/**
 * Smoke test against a running server.
 *
 * Unit tests drive the app in-process, which skips real HTTP: header casing,
 * status codes on the wire, JSON serialisation, conditional-request handling,
 * TLS, DNS. This exercises the actual socket, so CI catches a build that
 * compiles and passes tests but does not serve.
 *
 *   BASE_URL=http://localhost:3000 node scripts/smoke.mjs
 *
 * Two modes:
 *
 *   full (default)   Creates, updates and archives a product. Used against CI's
 *                    throwaway stack, where polluting the data does not matter.
 *   read-only        SMOKE_READ_ONLY=true. Verifies the read path, caching and
 *                    validation without writing. Used against production, so a
 *                    deploy does not leave a trail of archived test products in
 *                    the real catalog.
 *
 * API_KEY is sent on writes when set, because production requires it.
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const API_KEY = process.env.API_KEY ?? '';
const READ_ONLY = process.env.SMOKE_READ_ONLY === 'true';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 10_000);
const READY_TIMEOUT_MS = Number(process.env.SMOKE_READY_TIMEOUT_MS ?? 90_000);

/**
 * Every request goes through here so each one has a deadline.
 *
 * Bare `fetch` inherits the OS TCP timeout, which is around 75 seconds. Against a
 * host that accepts DNS but drops packets — a closed firewall port, exactly the
 * failure this hit in practice — the readiness loop then takes 60 x 75s instead
 * of 60 x 1s, and the CI job hangs for over an hour before reporting anything.
 * A per-request deadline turns that into a fast, legible failure.
 */
function req(url, init = {}) {
  return globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function writeHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
    ...extra,
  };
}

/**
 * Waits for readiness, not just for the port to accept a connection.
 *
 * A 200 alone is not enough: a proxy misconfigured to serve something else on
 * /ready also returns 200. Requiring JSON with status 'ready' means the check
 * fails loudly instead of passing against the wrong thing.
 */
async function waitForReady() {
  // Bounded by wall time, not by an attempt count. With a retry count, the total
  // wait is attempts x (request timeout + sleep), which balloons when every
  // request times out rather than answering — so the thing meant to cap the wait
  // ends up multiplying it. A deadline says what is actually meant: give up after
  // this long.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let attempt = 0;
  let lastError = 'no attempt completed';

  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const res = await req(`${BASE}/ready`);
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && type.includes('application/json')) {
        const body = await res.json();
        if (body.status === 'ready') return body;
        lastError = `unexpected body: ${JSON.stringify(body)}`;
      } else {
        lastError = `status ${res.status}, content-type '${type}'`;
      }
    } catch (error) {
      lastError =
        error.name === 'TimeoutError' ? `no response within ${TIMEOUT_MS}ms` : error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.error(
    `\nServer never became ready at ${BASE}\n` +
      `  gave up after ${READY_TIMEOUT_MS}ms and ${attempt} attempt(s)\n` +
      `  last error: ${lastError}\n\n` +
      'If the host resolves but every request times out, the usual cause is a\n' +
      'closed firewall port rather than an unhealthy application.',
  );
  process.exit(1);
}

/** Reads, caching and validation. Safe to run against production. */
async function readChecks() {
  const health = await req(`${BASE}/health`);
  check('/health returns 200', health.status === 200);
  check(
    '/health is JSON, not an HTML fallback',
    (health.headers.get('content-type') ?? '').includes('application/json'),
  );

  const listRes = await req(`${BASE}/api/v1/products?limit=5`);
  const list = await listRes.json();
  check('listing returns 200', listRes.status === 200);
  check('listing is paginated', list?.page?.limit === 5, JSON.stringify(list?.page));
  check(
    'listing sets a shared Cache-Control',
    (listRes.headers.get('cache-control') ?? '').includes('max-age'),
    listRes.headers.get('cache-control') ?? 'absent',
  );

  // The primary read pattern from the brief, over the wire.
  const filtered = await req(
    `${BASE}/api/v1/products?category=Running&minPrice=100000&maxPrice=2000000&sort=price:asc&limit=5`,
  );
  const filteredBody = await filtered.json();
  check('category + price range filter returns 200', filtered.status === 200);

  const amounts = (filteredBody?.data ?? []).map((p) => p.price.amount);
  check(
    'every returned price is inside the requested band',
    amounts.every((a) => a >= 100_000 && a <= 2_000_000),
    JSON.stringify(amounts),
  );
  check(
    'results are sorted by price ascending',
    JSON.stringify(amounts) === JSON.stringify([...amounts].sort((a, b) => a - b)),
  );

  // Conditional GET, if there is a product to ask about.
  const sample = filteredBody?.data?.[0] ?? list?.data?.[0];
  if (sample) {
    const one = await req(`${BASE}/api/v1/products/${sample.id}`);
    const etag = one.headers.get('etag');
    check('GET by id returns 200', one.status === 200);
    check('GET by id returns an ETag', Boolean(etag));

    if (etag) {
      const notModified = await req(`${BASE}/api/v1/products/${sample.id}`, {
        headers: { 'if-none-match': etag },
      });
      check('conditional GET returns 304', notModified.status === 304, `got ${notModified.status}`);
    }
  } else {
    console.log('  skip  conditional GET — catalog is empty');
  }

  // Validation. All reads, so safe against production.
  const badSort = await req(`${BASE}/api/v1/products?sort=discount:asc`);
  check('unsupported sort field returns 400', badSort.status === 400);

  const typo = await req(`${BASE}/api/v1/products?categoy=Running`);
  check('unknown query parameter returns 400', typo.status === 400);

  const inverted = await req(`${BASE}/api/v1/products?minPrice=900&maxPrice=100`);
  check('inverted price range returns 400', inverted.status === 400);

  const missing = await req(`${BASE}/api/v1/products/00000000-0000-0000-0000-000000000000`);
  check('unknown id returns 404', missing.status === 404);
}

/**
 * Second request for the same URL should be served by the nginx cache.
 *
 * Only meaningful when a proxy is in front, so a missing header is reported as a
 * skip rather than a failure — running straight against Node is a valid setup.
 */
async function cacheChecks() {
  const url = `${BASE}/api/v1/products?category=Running&limit=5`;
  const first = await req(url);
  const firstStatus = first.headers.get('x-cache-status');

  if (!firstStatus) {
    console.log('  skip  cache checks — no proxy in front (no X-Cache-Status header)');
    return false;
  }

  const second = await req(url);
  const secondStatus = second.headers.get('x-cache-status');
  check(
    'repeated GET is served from the proxy cache',
    secondStatus === 'HIT',
    `first=${firstStatus} second=${secondStatus}`,
  );
  return true;
}

/**
 * The API reference is static and served by nginx, so it only exists when a proxy
 * is in front. Checked here because it is the first thing a person opening the
 * link sees — a broken spec URL or a 404 on /docs/ is a silent, embarrassing
 * failure that no unit test would catch.
 */
async function docsChecks() {
  // The bare domain must serve the console itself, not redirect. It is the
  // address people are given, so a redirect there is a wrong answer.
  const root = await req(`${BASE}/`);
  const rootType = root.headers.get('content-type') ?? '';
  check(
    'bare / serves the console directly',
    root.status === 200 && rootType.includes('text/html'),
    `${root.status} ${rootType}`,
  );

  const console_ = await root.text();
  check('the console is the interactive one', console_.includes('Product Catalog API'));
  check('the console can reach the API', console_.includes('/api/v1/products'));

  // Previously shared address; a dead link is worse than a redirect.
  const legacy = await req(`${BASE}/docs/`, { redirect: 'manual' });
  check(
    '/docs/ still redirects rather than 404ing',
    legacy.status === 301 && (legacy.headers.get('location') ?? '').includes('/reference'),
    `${legacy.status} -> ${legacy.headers.get('location') ?? 'none'}`,
  );

  const docs = await req(`${BASE}/reference/`);
  const docsType = docs.headers.get('content-type') ?? '';
  check(
    '/reference/ serves HTML',
    docs.status === 200 && docsType.includes('text/html'),
    `${docs.status} ${docsType}`,
  );

  const html = await docs.text();
  check('/reference/ points at the spec', html.includes('/openapi.yaml'));

  const spec = await req(`${BASE}/openapi.yaml`);
  check('/openapi.yaml is served', spec.status === 200, `got ${spec.status}`);

  const body = await spec.text();
  check('the spec is the product catalog contract', body.includes('Product Catalog API'));
  check('the spec documents the listing endpoint', body.includes('/products'));

  const unknown = await req(`${BASE}/definitely-not-a-route`);
  check(
    'unknown paths still return a JSON 404',
    unknown.status === 404 && (unknown.headers.get('content-type') ?? '').includes('json'),
    `${unknown.status} ${unknown.headers.get('content-type') ?? ''}`,
  );
}

/** Full write lifecycle. Only run where polluting the data is acceptable. */
async function writeChecks() {
  const sku = `SMOKE-${Date.now()}`;
  const createRes = await req(`${BASE}/api/v1/products`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({
      sku,
      name: 'Smoke Test Runner',
      description: 'Created by the CI smoke test.',
      brand: 'Nike',
      category: 'Running',
      price: { amount: 1_299_00, currency: 'INR' },
      stock: 5,
      // Explicit, because the default is 'draft'. A POST does not publish a
      // product; this smoke test wants it visible in listings, so it says so.
      status: 'active',
    }),
  });
  check('POST creates a product', createRes.status === 201, `got ${createRes.status}`);

  const created = await createRes.json();
  const id = created?.data?.id;
  const etag = createRes.headers.get('etag');
  check('POST returns a Location header', Boolean(createRes.headers.get('location')));
  check('POST returns an ETag', Boolean(etag));
  check('price round-trips as integer minor units', created?.data?.price?.amount === 1_299_00);

  if (!id) {
    check('cannot continue write checks without an id', false);
    return;
  }

  const listRes = await req(
    `${BASE}/api/v1/products?category=Running&minPrice=100000&maxPrice=200000&limit=100`,
  );
  const list = await listRes.json();
  check(
    'the new product appears in a filtered listing',
    list?.data?.some((p) => p.sku === sku),
  );

  // Optimistic concurrency.
  const noMatch = await req(`${BASE}/api/v1/products/${id}`, {
    method: 'PATCH',
    headers: writeHeaders(),
    body: JSON.stringify({ stock: 9 }),
  });
  check('PATCH without If-Match is refused', noMatch.status === 428, `got ${noMatch.status}`);

  const stale = await req(`${BASE}/api/v1/products/${id}`, {
    method: 'PATCH',
    headers: writeHeaders({ 'if-match': '"deadbeefdeadbeefdead"' }),
    body: JSON.stringify({ stock: 9 }),
  });
  check('PATCH with a stale ETag returns 412', stale.status === 412, `got ${stale.status}`);

  const patched = await req(`${BASE}/api/v1/products/${id}`, {
    method: 'PATCH',
    headers: writeHeaders({ 'if-match': etag }),
    body: JSON.stringify({ stock: 9 }),
  });
  check('PATCH with the current ETag succeeds', patched.status === 200, `got ${patched.status}`);
  const patchedBody = await patched.json();
  check('version increments on write', patchedBody?.data?.version === 2);

  const fractional = await req(`${BASE}/api/v1/products`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({
      sku: `${sku}-BAD`,
      name: 'Fractional',
      description: 'x',
      brand: 'Nike',
      category: 'Running',
      price: { amount: 1299.99, currency: 'INR' },
      stock: 1,
    }),
  });
  check('fractional price is rejected', fractional.status === 400, `got ${fractional.status}`);

  const duplicate = await req(`${BASE}/api/v1/products`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({
      sku: sku.toLowerCase(),
      name: 'Duplicate',
      description: 'x',
      brand: 'Nike',
      category: 'Running',
      price: { amount: 100_00, currency: 'INR' },
      stock: 1,
    }),
  });
  check('duplicate SKU returns 409 regardless of case', duplicate.status === 409);

  // 200 with a body, not 204: this is a soft delete, so there is still a
  // representation to return and the client should see the new state.
  const del = await req(`${BASE}/api/v1/products/${id}`, {
    method: 'DELETE',
    headers: writeHeaders({ 'if-match': patched.headers.get('etag') }),
  });
  check('DELETE returns 200', del.status === 200, `got ${del.status}`);
  const deleted = await del.json();
  check('DELETE archives rather than destroying', deleted?.data?.status === 'archived');

  // Still addressable by id — an old order must be able to resolve what was
  // bought — but no longer present in the default listing.
  const afterDelete = await req(`${BASE}/api/v1/products/${id}`);
  check('archived product is still retrievable by id', afterDelete.status === 200);

  const afterList = await req(`${BASE}/api/v1/products?category=Running&limit=100`);
  const afterListBody = await afterList.json();
  check(
    'archived product is gone from the default listing',
    !afterListBody?.data?.some((p) => p.sku === sku),
  );
}

/** Writes must be rejected without a key when the server requires one. */
async function authChecks() {
  const res = await req(`${BASE}/api/v1/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sku: `NOAUTH-${Date.now()}`,
      name: 'Should not be created',
      description: 'x',
      brand: 'Nike',
      category: 'Running',
      price: { amount: 100_00, currency: 'INR' },
      stock: 1,
    }),
  });
  check(
    'unauthenticated write is rejected',
    res.status === 401 || res.status === 403,
    `got ${res.status}`,
  );
}

async function main() {
  console.log(`Smoke testing ${BASE}${READ_ONLY ? ' (read-only)' : ''}`);

  const ready = await waitForReady();
  check('/ready reports ready with a row count', typeof ready.products === 'number');

  await readChecks();
  const proxied = await cacheChecks();

  if (proxied) {
    await docsChecks();
  } else {
    console.log('  skip  docs checks — static reference is served by nginx, not the app');
  }

  if (READ_ONLY) {
    // Production requires a key on writes, so this proves the guard is live
    // without creating anything.
    if (API_KEY) await authChecks();
    console.log('  skip  write lifecycle — read-only mode');
  } else {
    await writeChecks();
  }

  console.log(
    failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
