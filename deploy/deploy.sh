#!/usr/bin/env bash
#
# Runs on the server, invoked by CI over SSH. Not usually run by hand.
#
#   ./deploy.sh <image-tag>
#
# The image tag is a git commit SHA, so what is running is always traceable to a
# commit, and rollback is a matter of pointing at the previous SHA rather than
# rebuilding anything.

set -euo pipefail

IMAGE_TAG="${1:?usage: deploy.sh <image-tag>}"
APP_DIR="${APP_DIR:-/opt/product-catalog}"
COMPOSE="docker compose -f docker-compose.prod.yml"

cd "$APP_DIR"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mFAILED: %s\033[0m\n' "$1" >&2; }

# --- Remember what is currently running, for rollback ------------------------
PREVIOUS_TAG=""
if [[ -f .env ]] && grep -q '^IMAGE_TAG=' .env; then
  PREVIOUS_TAG="$(grep '^IMAGE_TAG=' .env | cut -d= -f2)"
fi
log "Deploying ${IMAGE_TAG}  (currently: ${PREVIOUS_TAG:-none})"

write_tag() {
  # Rewrite only the IMAGE_TAG line, leaving secrets in .env untouched.
  if grep -q '^IMAGE_TAG=' .env 2>/dev/null; then
    sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=$1|" .env
  else
    echo "IMAGE_TAG=$1" >>.env
  fi
}

# --- Preflight ----------------------------------------------------------------
# Fail before touching the running service, not halfway through.
for required in POSTGRES_PASSWORD API_KEY; do
  if ! grep -q "^${required}=..*" .env 2>/dev/null; then
    fail "$required is missing from $APP_DIR/.env"
    exit 1
  fi
done

log "Pulling ghcr.io image ${IMAGE_TAG}"
write_tag "$IMAGE_TAG"
if ! $COMPOSE pull api; then
  fail "could not pull the image — leaving the running version alone"
  [[ -n "$PREVIOUS_TAG" ]] && write_tag "$PREVIOUS_TAG"
  exit 1
fi

# --- Make sure nginx can start ------------------------------------------------
# nginx refuses to start when ssl_certificate points at a file that does not
# exist, which is the case on the very first deploy — the real certificate cannot
# be issued until nginx is already answering ACME challenges on port 80.
#
# A self-signed placeholder breaks that circle: nginx starts, serves the
# challenge, and init-letsencrypt.sh swaps in the trusted certificate. Without
# this the first deploy of a new server always fails.
DOMAIN=nike-catalog.me
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

if ! $COMPOSE run --rm --entrypoint "test -f $CERT_DIR/fullchain.pem" certbot 2>/dev/null; then
  log "No certificate yet — planting a self-signed placeholder so nginx can boot"
  $COMPOSE run --rm --entrypoint "sh -c 'mkdir -p $CERT_DIR && \
    openssl req -x509 -nodes -newkey rsa:2048 -days 2 \
      -keyout $CERT_DIR/privkey.pem \
      -out $CERT_DIR/fullchain.pem \
      -subj \"/CN=$DOMAIN\"'" certbot
  echo "  placeholder in place — run ./init-letsencrypt.sh to get a trusted cert"
fi

# --- Database migration -------------------------------------------------------
# Runs as a one-off container on the new image, before the new code serves
# traffic. Idempotent, so a retried deploy is safe.
log "Ensuring Postgres is up"
$COMPOSE up -d postgres
$COMPOSE run --rm --entrypoint "node dist/db/migrate.js" api

# --- Roll the API -------------------------------------------------------------
log "Recreating the API container"
$COMPOSE up -d --no-deps api

log "Ensuring nginx and certbot are up"
$COMPOSE up -d nginx certbot

# --- Verify -------------------------------------------------------------------
# Checked inside the API container, not through nginx. Port 80 is deliberately
# only ACME challenges and a 301 to HTTPS, so curling it would follow a redirect
# and tell us nothing about the application. The rollback decision has to turn on
# whether the new code is serving, which is exactly what this asks.
api_ready() {
  $COMPOSE exec -T api node -e "
    fetch('http://127.0.0.1:3000/ready')
      .then(r => r.text())
      .then(t => { console.log(t); process.exit(t.includes('\"status\":\"ready\"') ? 0 : 1); })
      .catch(() => process.exit(1))
  " 2>/dev/null
}

log "Waiting for readiness"
healthy=false
for attempt in $(seq 1 30); do
  if api_ready >/dev/null; then
    healthy=true
    echo "  ready after ${attempt}s: $(api_ready)"
    break
  fi
  sleep 1
done

if [[ "$healthy" != true ]]; then
  fail "new version never became ready"
  $COMPOSE logs --no-color --tail 60 api || true

  if [[ -n "$PREVIOUS_TAG" && "$PREVIOUS_TAG" != "$IMAGE_TAG" ]]; then
    log "Rolling back to ${PREVIOUS_TAG}"
    write_tag "$PREVIOUS_TAG"
    $COMPOSE up -d --no-deps api
    for _ in $(seq 1 30); do
      api_ready >/dev/null && { echo "  rollback healthy"; break; }
      sleep 1
    done
    fail "deploy rolled back to ${PREVIOUS_TAG}"
  else
    fail "no previous version to roll back to"
  fi
  exit 1
fi

# --- Verify the proxy in front ------------------------------------------------
# Over HTTPS with -k, because on a fresh server the certificate is still the
# self-signed placeholder. Non-fatal: the application is already confirmed
# healthy, and a certificate that is not trusted yet is a known, expected state
# until init-letsencrypt.sh has run.
log "Checking the proxy and cache"
if curl -fsSk "https://127.0.0.1/health" --resolve "$DOMAIN:443:127.0.0.1" >/dev/null 2>&1 ||
  curl -fsSk "https://127.0.0.1/health" >/dev/null 2>&1; then
  url="https://127.0.0.1/api/v1/products?limit=1"
  first=$(curl -fsSk -o /dev/null -D - "$url" 2>/dev/null | grep -i '^x-cache-status' | tr -d '\r' || true)
  second=$(curl -fsSk -o /dev/null -D - "$url" 2>/dev/null | grep -i '^x-cache-status' | tr -d '\r' || true)
  echo "  ${first:-no cache header}"
  echo "  ${second:-no cache header}"
else
  echo "  proxy not serving HTTPS yet — expected before ./init-letsencrypt.sh"
fi

# Port 80 must redirect, and must not serve the API in the clear.
redirect=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/api/v1/products" || true)
echo "  http://  -> ${redirect} (301 expected)"

# --- Clean up -----------------------------------------------------------------
# Old images accumulate and a 60 GB disk is not infinite. Keeps the previous
# image so rollback stays instant, drops anything older.
log "Pruning unused images"
docker image prune -f --filter "until=168h" >/dev/null || true

log "Deployed ${IMAGE_TAG}"
docker compose -f docker-compose.prod.yml ps --format 'table {{.Service}}\t{{.Status}}'
