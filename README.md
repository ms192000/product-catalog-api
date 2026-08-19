# Product Catalog API

A REST service for an e-commerce product catalog: create, retrieve, update and delete products, and list them with category and price filters plus pagination.

Built for the stated shape of the problem — a few hundred thousand products, reads vastly outnumbering writes, filtering and pagination as the primary access pattern. Live on **200,000 products**.

## Live

|                                                                      |                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[nike-catalog.me](https://nike-catalog.me)**                       | **Interactive console.** Browse the real catalog with filters that map onto query parameters, build requests against any endpoint, and run guided scenarios that demonstrate the index, the pagination tradeoff, optimistic concurrency and the cache. Nothing is mocked. |
| **[nike-catalog.me/reference](https://nike-catalog.me/reference/)**  | **API reference.** The OpenAPI contract rendered for browsing, with request/response shapes, status codes and the reasoning behind each. `/docs` redirects here.                                                                                                          |
| [nike-catalog.me/openapi.yaml](https://nike-catalog.me/openapi.yaml) | The spec itself.                                                                                                                                                                                                                                                          |
| [nike-catalog.me/health](https://nike-catalog.me/health)             | Liveness, and which commit is running.                                                                                                                                                                                                                                    |

```bash
# The primary read pattern: category + price range, sorted, paginated
curl "https://nike-catalog.me/api/v1/products?category=Running&minPrice=500000&maxPrice=1500000&sort=price:asc&limit=5"
```

---

## The problem, and what follows from it

Three constraints drove every decision.

**A few hundred thousand products.** Large enough that the difference between a good query plan and a bad one is milliseconds versus seconds. Small enough that one machine is the right answer, and sharding would be theatre.

**Reads vastly outnumber writes.** So reads get the budget: indexes shaped to the exact filters, HTTP caching, a proxy that answers without touching the application. Writes are allowed to be slower in exchange — which is why there are seven indexes rather than one.

**Filter by category and price range, with pagination.** Not a general search problem. Equality on one column, a range on another, ordered, in pages. That specific shape has an obvious right answer in a relational database, and it is the reason for the datastore choice.

---

## Why PostgreSQL

The listing query is: match a category, restrict to a price band, sort, return page N. A composite B-tree turns that into "jump to where the Running shoes start, walk forward in price order until you leave the band, stop after 20 rows". The database reads roughly as many rows as it returns, and that property is what keeps the query flat as the catalog grows.

<details>
<summary><b>What I considered and rejected</b> — DynamoDB, MongoDB, Elasticsearch</summary>

**DynamoDB (key-value).** Fast and operationally simple when access patterns are few and known up front. Here clients combine category, brand, price range, stock and text freely. Each new combination is another global secondary index or a scan with a filter — and DynamoDB filters apply _after_ reading, so you pay for rows you discard. Modelling arbitrary filter combinations in a key-value store means rebuilding a query planner by hand.

**MongoDB (document).** A reasonable choice, and it supports compound indexes on the same columns. But the data is uniformly shaped — every product has a SKU, a price, a category — which is the case relational storage is built for. Choosing documents trades away transactions, joins and constraint enforcement for schema flexibility this data does not need.

**Elasticsearch.** Better than Postgres at relevance, worse as a source of truth: near-real-time indexing means a write is not immediately readable, and there are no transactions. The right use is a sidecar fed from Postgres once search becomes a real feature. Postgres full-text search (included here, `?q=`) is good enough well past this scale.

**A cache in front, not a different database.** The read-heavy requirement is satisfied by caching, and caching sits _in front of_ the datastore. It is not an argument for changing it.

</details>

---

## The index that does the work

```sql
CREATE INDEX products_category_price_idx
  ON products (category, price_minor, id)
  WHERE status = 'active';
```

**Column order is the whole decision.** Equality first, range second. Postgres descends to the `category = 'Running'` block, walks it in `price_minor` order, and stops when it leaves the band. Because the walk is already in price order, `ORDER BY price` needs **no sort step at all**.

Reverse the columns to `(price_minor, category)` and the same query scans every product in the price band across all categories, discarding non-matches one row at a time. Same columns, same data, dramatically more work.

`id` comes last so the index also satisfies the tie-break. `WHERE status = 'active'` makes it partial: drafts and archived rows are excluded, so the index is smaller, more of it stays in memory, and the planner does not re-check status per row.

Measured on 200,000 products (`npm run explain`):

| Query                                      | Plan                                           | Time         |
| ------------------------------------------ | ---------------------------------------------- | ------------ |
| `category` + price range, ordered by price | `Index Scan using products_category_price_idx` | **0.68 ms**  |
| Price range only, ordered by price         | `Index Scan using products_price_idx`          | **0.42 ms**  |
| Page 5000 via `OFFSET 100000`              | Sort + Bitmap Heap Scan                        | **26.72 ms** |
| Same position via keyset cursor            | `Index Scan`                                   | **0.33 ms**  |
| Full-text search `?q=`                     | Bitmap Index Scan on GIN                       | **25.64 ms** |
| Category facet counts                      | HashAggregate over the table                   | **81.22 ms** |

No sort step appears in the first row. That is the index doing its job.

The last two rows are the honest weak spots. Full-text search at 26 ms is acceptable and is the first thing that would move to a dedicated engine. Facet counts scan the whole table by necessity — counting every category means visiting every row — which is why they are a separate opt-in endpoint rather than part of every listing response.

---

## Pagination: two kinds, and why

Both are implemented, because they solve different problems.

**Offset** (`?limit=20&offset=40`) is what a numbered pager needs, and the only way to answer "page 3 of 87". It degrades with depth: `OFFSET 100000` makes Postgres walk and discard 100,000 index entries before returning anything. This is the default, because page numbers are what clients expect.

**Keyset** (`?cursor=…`) carries the last row's sort value and id, so the next page becomes `WHERE (price_minor, id) > (last_price, last_id)` — a fresh index seek costing the same at page 1 and page 10,000. The 0.33 ms versus 26.72 ms above is the same position reached two ways.

Keyset also fixes a correctness problem, not just speed. Under offset pagination, if someone inserts a product while a customer is on page 2, every later page shifts and an item is silently skipped. A cursor describes a position in the data rather than a count of rows to skip.

**`id` is always the final sort key.** Two products at ₹4,999.00 have no defined relative order otherwise, so Postgres may return them differently between queries — the same product appears on pages 1 and 2 while another never appears at all. For keyset it is worse: the cursor would not identify a unique position, so a boundary inside a group of tied prices could skip or repeat the whole group. A test creates deliberate price ties every ten rows and asserts that paging through 50 products yields exactly 50 distinct ids.

**`?withTotal=true` is opt-in.** `COUNT(*)` over a filtered set is the most expensive part of a listing — it visits every matching row while the page needs 20. Offset requests get a total by default because a pager is useless without one; cursor requests do not.

---

## Money is an integer

`price_minor BIGINT` — ₹1,299.00 is stored as `129900` and formatted on the way out.

Floating point cannot represent most decimal fractions. In a catalog that produces this:

```js
1499.95 * 7; // 10499.649999999998
// the same value added seven times
// 10499.650000000001
```

Two ways of totalling seven identical items disagree, and neither equals ₹10,499.65. That is a bug which reconciles against nothing and surfaces in accounting weeks later rather than in a test. Integers have no such failure mode. Every currency has a smallest indivisible unit, so an integer count of those units is the honest data type; rounding happens once, deliberately, at display.

`NUMERIC` would also be exact and is the textbook answer. `BIGINT` is chosen because this is the second column of the hot composite index: `NUMERIC` is variable-length with slower comparisons, while `BIGINT` is a fixed 8 bytes and compares in one instruction.

The API enforces this rather than trusting it — `"amount": 1299.99` is rejected with a 400 naming `price.amount`.

---

## The data model

One table. The columns are ordinary; the decisions worth defending are which things got to be columns at all.

**Typed columns for what you filter on, JSONB for the rest.** Everything the API filters, sorts or paginates by is a real column with a real index. Everything that varies product to product — colourway, size, materials — goes in `attributes`. Modelling the whole product as a document would keep flexibility this data does not need and lose index quality on precisely the fields the primary query depends on.

<details>
<summary><b>Why <code>category</code> is a text column and not a <code>categories</code> table</b></summary>

This is the normalisation question, and I went the other way deliberately.

Normalising would give referential integrity, one place to rename a category, and somewhere to hang metadata like display order or a parent. What it costs is a join on the hottest read path — and it would break the index that makes this fast. `(category, price_minor, id)` works because `category` is a value in the same row as the price. With a `category_id` foreign key, every request must resolve name to id first and every response join back to get the name: two extra steps on the query that matters most, to solve a problem a catalog of this size does not have.

The honest tradeoff: a rename becomes an `UPDATE` across many rows, and nothing at the database level stops `"Runnning"` being inserted. I would normalise the moment categories need hierarchy, localised names, or their own metadata — and I expect that to happen, which is why categories are exposed through `/facets` rather than as a fixed list clients hardcode. Clients already treat them as server data, so introducing a table later is a change behind the interface rather than to it.

</details>

<details>
<summary><b>Full column list</b></summary>

| Column                         | Type                 | Why                                                                                                            |
| ------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                           | `UUID` PK            | Application-generated, so a client can create without a round trip to learn its id, and ids are not guessable. |
| `sku`                          | `TEXT`               | External identifier other systems quote. Unique on `lower(sku)`, immutable once set.                           |
| `name`, `description`, `brand` | `TEXT`               | Also fed into the full-text index.                                                                             |
| `category`                     | `TEXT`               | Denormalised on purpose — see above.                                                                           |
| `price_minor`                  | `BIGINT`             | Integer minor units.                                                                                           |
| `currency`                     | `CHAR(3)`            | ISO 4217, per row, so multi-currency needs no migration.                                                       |
| `stock`                        | `INTEGER`            | `CHECK (stock >= 0)` — overselling cannot be represented.                                                      |
| `status`                       | `TEXT` + `CHECK`     | `active` / `draft` / `archived`. Enables soft delete and the partial indexes.                                  |
| `attributes`                   | `JSONB`              | The escape hatch for genuinely variable data.                                                                  |
| `created_at`, `updated_at`     | `TIMESTAMPTZ`        | Not `TIMESTAMP` — a catalog is edited from more than one timezone.                                             |
| `version`                      | `INTEGER`            | Increments on every write. The ETag derives from it.                                                           |
| `search_vector`                | generated `TSVECTOR` | Maintained by Postgres, so it cannot drift from the row. GIN indexed.                                          |

</details>

---

## API

Base path `/api/v1`. Full shapes, headers and status codes: **[/reference](https://nike-catalog.me/reference/)**.

| Method   | Path                 | Notes                                                         |
| -------- | -------------------- | ------------------------------------------------------------- |
| `GET`    | `/products`          | Filter, sort, paginate                                        |
| `GET`    | `/products/facets`   | Category counts for the current filters                       |
| `GET`    | `/products/sku/:sku` | Lookup by SKU, case-insensitive                               |
| `GET`    | `/products/:id`      | Supports `If-None-Match` → 304                                |
| `POST`   | `/products`          | 201 with `Location` and `ETag`. Status defaults to `draft`    |
| `PATCH`  | `/products/:id`      | Partial update. Requires `If-Match`                           |
| `DELETE` | `/products/:id`      | Soft delete → `archived`. Requires `If-Match`                 |
| `GET`    | `/health`            | Liveness plus the running commit. Does not touch the database |
| `GET`    | `/ready`             | Readiness. Runs a real query                                  |

Responses separate data from page metadata, and echo back how the query was interpreted — so a client can see that `categoy` was not silently ignored:

```json
{
  "data": [
    { "sku": "…", "price": { "amount": 129900, "currency": "INR" }, "priceFormatted": "₹1,299.00" }
  ],
  "page": { "limit": 20, "total": 19947, "nextCursor": "WyIx…", "hasMore": true },
  "query": {
    "filters": { "category": ["Running"], "minPrice": 500000 },
    "sort": { "field": "price", "direction": "asc" }
  }
}
```

<details>
<summary><b>Listing parameters</b></summary>

| Parameter               | Example              | Notes                                             |
| ----------------------- | -------------------- | ------------------------------------------------- |
| `category`              | `Running,Basketball` | Comma-separated values are ORed                   |
| `brand`                 | `Nike`               | ANDed with other filters                          |
| `minPrice` / `maxPrice` | `500000`             | Minor units, inclusive                            |
| `inStockOnly`           | `true`               | `stock > 0`                                       |
| `q`                     | `pegasus`            | Full-text over name, brand, category, description |
| `status`                | `active`             | Defaults to `active`, so drafts never leak        |
| `sort`                  | `price:asc`          | `price`, `name`, `createdAt`, `relevance`         |
| `limit`                 | `20`                 | Clamped to 100 rather than rejected               |
| `offset`                | `40`                 | Mutually exclusive with `cursor`                  |
| `cursor`                | opaque               | Keyset pagination                                 |
| `withTotal`             | `true`               | Opt in to `COUNT(*)`                              |

</details>

<details>
<summary><b>Writes: optimistic concurrency, and soft delete</b></summary>

**`If-Match` is required on `PATCH` and `DELETE`, not optional.** Without it: `428 Precondition Required`. With a stale one: `412`. `If-Match: *` explicitly opts out.

Two staff editing the same product is not an edge case. If the header were optional, the default would be last-write-wins — one person's change silently erasing another's, with no error anywhere. Requiring it makes the conflict visible to the client that caused it.

The check and the write are one statement:

```sql
UPDATE products SET …, version = version + 1
WHERE id = $1 AND version = $2
```

Two concurrent updates cannot both match the same version, so exactly one wins and the other gets a 412.

**Delete is a soft delete** — `status` becomes `archived`. Catalog rows are referenced by order history, analytics and search indexes; removing the row orphans all of it, so a two-year-old order can no longer say what was in it. Archiving hides the product from listings while keeping it addressable by id. `DELETE` returns `200` with the archived product rather than `204`, because there is still a representation to return.

**ETags come from `id:version`,** not a content hash — the counter already exists and is guaranteed to change on write. A timestamp would be wrong: two writes in the same millisecond would produce identical ETags and a client would cache a stale product indefinitely.

**SKU uniqueness is enforced by a unique index**, not by checking first. `SELECT` then `INSERT` has a gap another request can slip through; the index is the only authority that cannot be raced. The 23505 violation becomes a `409`.

</details>

<details>
<summary><b>Validation at the boundary</b></summary>

Every request is parsed by a [Zod](https://zod.dev) schema before reaching business logic. Incoming JSON is untyped and could contain anything; a schema is a description of the acceptable shape that also produces a typed value. One declaration gives both the runtime check and the TypeScript type, so they cannot drift — TypeScript alone disappears at compile time and checks nothing about what arrives over the network.

**Schemas are `.strict()`, so unknown fields are rejected.** `"pirce"` or `?categoy=Running` returns 400 naming the offending key. The alternative — ignoring what you do not recognise — means a client sends a filter, gets a 200, and receives the whole unfiltered catalog believing it was filtered. A typo that silently returns wrong data is far worse than one that fails loudly.

Validation also spans fields: `minPrice` above `maxPrice` is rejected as a range that cannot match, rather than returning an empty list that looks like "no products found".

Errors have one shape everywhere, with a machine-readable code and a path to the offending field:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "price.amount", "message": "must be an integer number of minor units" }]
  }
}
```

</details>

<details>
<summary><b>Serving reads: cache headers, ETags, nginx</b></summary>

**`Cache-Control: public, max-age=60, stale-while-revalidate=30`** on product reads. The highest-leverage line in the codebase for a read-heavy service: a response a shared cache can reuse for 60 seconds means the origin sees one request instead of a thousand. `stale-while-revalidate` lets a cache serve the slightly-stale copy immediately while refreshing behind it, so no customer waits.

**Conditional GETs.** A client sending `If-None-Match` gets a 304 with no body when nothing changed — the row is still read, but the payload is not serialised or transferred.

**nginx as a caching reverse proxy.** A cached GET never reaches Node and never touches Postgres.

- `proxy_cache_key` includes the query string, so each filter combination caches separately.
- `proxy_cache_lock on` — when an entry expires, one request repopulates it and the rest wait, instead of all stampeding the origin.
- `proxy_cache_use_stale … http_502 http_503` — if the API is down, keep serving the last good response. A 60-second-old price beats an error page.
- `/health` and `/ready` are proxied explicitly and never cached. A cached readiness probe reports the state of a process that may have died since.
- `X-Cache-Status` is exposed on every response, so `HIT` versus `MISS` is observable rather than assumed. CI asserts on it.

Reads that feed a conditional write must bypass the cache — a cached ETag can be a version behind, and the write would then correctly fail with a 412. The console does this with `Cache-Control: no-cache`, which nginx honours via `proxy_cache_bypass`.

</details>

---

## Testing

49 API tests against a real PostgreSQL engine, plus 30 smoke checks over a real socket. They cover the behaviour that is easy to get wrong rather than restating the implementation.

<details>
<summary><b>What the tests actually assert, and why against a real engine</b></summary>

- Category and price-range filtering, including rows sitting exactly on both bounds — an off-by-one there silently drops products priced at precisely the number the customer typed.
- Offset paging with deliberate price ties every ten rows, asserting 50 distinct ids across 5 pages. This fails without the `id` tie-break.
- Keyset paging walking the full set with no duplicates and no gaps.
- `withTotal` with a cursor returning the size of the whole filtered set, not the rows remaining after the cursor.
- 400s for unknown query parameters, unsupported sort fields, inverted price ranges and fractional prices.
- 409 on duplicate SKU regardless of case; 428/412/200 across the `If-Match` cases; 304 on conditional GET.

**Why a real engine and not mocks.** The substance of this service _is_ its query behaviour — whether the index is used, whether keyset pagination returns disjoint pages, whether a unique violation surfaces as a 409. Mocking the repository would test that the mock behaves like the mock. Tests run on [PGlite](https://pglite.dev), PostgreSQL compiled to WebAssembly and run in-process: the actual engine, so the same SQL, planner, index types and error codes. Production uses node-postgres against a real server, behind the same `Db` interface.

The gap is real: PGlite is single-connection, so concurrent-write behaviour is not exercised there. A CI job runs the same suite against a real PostgreSQL 16 service container, because "the same engine" is a claim worth testing rather than trusting.

`scripts/smoke.mjs` adds checks over a real socket, because in-process tests skip real HTTP: header casing, wire status codes, actual 304 handling, TLS. It earned its place immediately — it caught that `tsc` does not copy `schema.sql` into `dist/`, so the image would have built, passed every test, and failed to migrate.

</details>

---

## CI/CD and deployment

Every push to `main` that passes CI redeploys automatically. Cheapest checks first, so a formatting error fails in under a minute rather than after a Docker build.

| Job             | What it proves                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static`        | Prettier, ESLint and `tsc --noEmit` are clean                                                                                                                                |
| `test`          | 49 tests pass on the embedded engine                                                                                                                                         |
| `test-postgres` | The same suite against real PostgreSQL 16, then 50,000 rows seeded and the query plans re-verified                                                                           |
| `build`         | `tsc` emits a runnable `dist/server.js`, and the compiled server passes smoke over real HTTP                                                                                 |
| `docker`        | Image builds, runs as a non-root user, the full nginx + API + PostgreSQL stack passes smoke _through the proxy_, and `X-Cache-Status: HIT` is asserted on a repeated request |
| `deploy`        | Ships to the server and verifies the live site                                                                                                                               |

<details>
<summary><b>How a deploy works, and how it rolls back</b></summary>

```
push to main
  → CI: static, tests, tests-on-real-postgres, build+smoke, docker+stack
  → the tested image is pushed to ghcr.io/<repo>:<sha>
  → deploy: ship config → write .env from secrets → ssh → deploy.sh <sha>
       ├─ pull the image
       ├─ run migrations (one-off container, idempotent)
       ├─ recreate the API container
       ├─ poll readiness for 30s
       └─ not ready? restore the previous SHA
  → smoke test the live domain from the runner (read-only)
```

**The image is built in CI, not on the server.** A small instance running `npm ci` and `tsc` next to Postgres is how a deploy gets OOM-killed. The server only pulls.

**Images are tagged with the commit SHA, never just `latest`.** `latest` makes "what is running?" unanswerable and rollback a guess. `/health` reports the same SHA, so the running build is verifiable without shell access.

**The image that ships is the exact image that passed the stack test** — built once, tagged twice, tested under the local tag, pushed under the registry tag.

**Rollback is automatic.** `deploy.sh` records the outgoing SHA first. If the new container never reports ready within 30 seconds, it restores the previous one and exits non-zero, leaving the site up on the last known good version.

**The post-deploy smoke test is read-only.** The write lifecycle already ran against the throwaway stack. Repeating it in production would leave an archived test product on every deploy. What the production run verifies is what CI cannot: DNS resolves, the certificate is valid, nginx is caching, and unauthenticated writes are refused.

Two jobs exist because of specific failure modes. `build` asserts `dist/server.js` exists, since `tsc` exiting 0 does not prove it emitted what the Dockerfile runs. `docker` smoke-tests _through_ nginx, because that is the only way to catch a proxy rule that swallows `/ready` or strips a header — a mistake that leaves every test green while production health checks fail.

</details>

<details>
<summary><b>Infrastructure and configuration</b></summary>

A single Amazon Lightsail instance in `ap-south-1`: nginx terminating TLS and caching reads, the API container, and PostgreSQL 16. Postgres is never published to the host — only exposed on the compose network, so the database is unreachable from the internet even if the firewall were misconfigured. TLS is Let's Encrypt, renewed automatically by a certbot sidecar with no downtime, because challenges are served from a shared volume rather than by stopping nginx.

The instance carries 2 GB of swap. On a small box running Postgres, Node and nginx, a memory spike without swap means the OOM killer, and it usually picks Postgres. Container logs are size-capped, which prevents the other classic small-instance death: a full disk weeks after a successful launch.

Secrets live in GitHub Actions and are written to the server on each deploy at mode 600, so rotating one means updating a secret and pushing rather than editing a file on a host.

| Variable            | Default | Purpose                                                        |
| ------------------- | ------- | -------------------------------------------------------------- |
| `PORT`              | `3000`  | HTTP port                                                      |
| `DATABASE_URL`      | unset   | Set to use a PostgreSQL server; unset uses the embedded engine |
| `DEFAULT_PAGE_SIZE` | `20`    | Page size when `limit` is omitted                              |
| `MAX_PAGE_SIZE`     | `100`   | Ceiling; larger requests are clamped                           |
| `CACHE_MAX_AGE`     | `60`    | Seconds a GET stays fresh in a shared cache                    |
| `RATE_LIMIT`        | `600`   | Requests per minute per IP                                     |
| `API_KEY`           | unset   | When set, writes require `X-API-Key`                           |
| `BUILD_COMMIT`      | unset   | Stamped at image build; reported by `/health`                  |

</details>

<details>
<summary><b>Repository layout</b></summary>

Each layer depends only on the one beneath it. A route never writes SQL; the repository never knows what HTTP is.

```
src/
├── server.ts                    Process entry: env, DB, migrate, listen, graceful shutdown
├── app.ts                       Composition root — the only place that knows how the
│                                  layers connect, which is what lets tests swap the DB
├── config.ts                    All environment reading, in one file
│
├── db/
│   ├── schema.sql               Table, constraints and seven indexes, each commented
│   │                             with the query it serves
│   ├── client.ts                The Db seam: one interface, two adapters
│   ├── migrate.ts               Applies schema.sql. Idempotent
│   └── seed.ts                  Generates N products from a seeded PRNG, so the same
│                                  COUNT always produces the same catalog. Batched
│                                  inserts, then ANALYZE so the planner has statistics
│
├── domain/
│   ├── product.ts               Product type, Money as minor units, cursor encode/decode,
│   │                             ETag derivation. No SQL, no HTTP
│   └── errors.ts                Typed errors carrying the HTTP status they map to
│
├── repositories/
│   └── product.repository.ts    All SQL. Filtering, ordering and pagination happen in
│                                  the database. Reads and writes are separate methods,
│                                  which is what makes a read replica a one-file change
│
├── services/
│   └── product.service.ts       Use cases: SKU conflicts, ETag comparison, archive
│
└── http/
    ├── schemas.ts               Zod request schemas — the trust boundary
    ├── product.routes.ts        Parse, delegate, set cache headers, respond
    └── middleware.ts            Rate limiting, API key, logging, one error handler

tests/                           49 tests driving the real app over HTTP against real SQL
scripts/explain.ts               EXPLAIN ANALYZE harness — produces the timings above
scripts/smoke.mjs                Post-deploy checks over a real socket
openapi.yaml                     The API contract
web/                             The live console and the spec reference
deploy/                          nginx (local + TLS), prod compose, bootstrap, deploy
.github/workflows/ci.yml         The pipeline
```

</details>

---

## Tradeoffs

Things that are deliberately not free.

**Seven indexes make writes slower.** Every insert updates all of them. Correct for reads ≫ writes; the wrong call for a write-heavy system.

**Facet counts scan the table** — 81 ms at this size. Hence a separate opt-in endpoint rather than part of every listing.

**Full-text search is Postgres, not Elasticsearch.** 26 ms, no typo tolerance, no synonyms. Right for now; the first thing to outgrow.

**Requiring `If-Match` makes writes less convenient.** A caller must read before writing. That is the cost of not making silent overwrites the default.

**Soft delete means archived rows stay in the table** and every default query carries a status filter. Paid for by partial indexes, which exclude those rows entirely.

**Cached responses can be up to 60 seconds stale.** Fine for a catalog. Not fine for stock during a launch, which would need a shorter TTL or explicit invalidation.

**One instance is a single point of failure,** and a deploy has a ~15 second gap. Chosen for cost. The alternative is below.

**The development engine is not the production server.** PGlite is single-connection, so lock contention is untestable there. Mitigated by the real-PostgreSQL CI job rather than by pretending the gap is absent.

---

## What I would change for production

<details>
<summary><b>The architecture I would actually run, and roughly what it costs</b></summary>

Currently one Lightsail instance, chosen for cost — flat, predictable, and genuinely sufficient at this traffic. The version below is roughly $150–250/month, which is precisely why it is not what is running.

```
                    Route 53
                        │
                   CloudFront            ← edge cache; most reads never go further
                        │
        ┌───────────────┴────────────────┐
  ALB → ECS Fargate (2+ tasks)      S3 (product images)
        │
        ├── ElastiCache Redis            ← hot products by id
        └── RDS PostgreSQL Multi-AZ
                ├── writer
                └── read replica(s)      ← the actual read-scaling mechanism
```

**CloudFront is the biggest win, and the API is already built for it.** It emits `Cache-Control` and a stable ETag on every read — exactly what a CDN needs — so this is configuration, not a rewrite. Two settings decide whether it helps or silently breaks things: the cache key **must** include the filter query parameters (CloudFront ignores the query string by default, which would collapse every filter into one cached response and serve running shoes to someone browsing basketball), and nothing carrying `X-API-Key` may be cached.

**Read replicas are the correct answer to "faster reads" for this query pattern.** Reads and writes already go through separate repository methods, so pointing reads at a replica is a change in one file. That is what the `Db` seam is for.

**ECS Fargate over EC2**, because there is no reason to patch an OS to run one container. **RDS Multi-AZ** for automated failover and point-in-time recovery, which instance snapshots do not give you. **Secrets Manager** instead of an env file, for rotation and an audit trail.

A cheap intermediate step: a Lightsail CDN distribution is $2.50/month and is CloudFront underneath — edge caching without leaving the flat-rate pricing.

</details>

<details>
<summary><b>On DynamoDB specifically, since "use it for fast reads" is a common instinct</b></summary>

DynamoDB for reads with a separate store for writes, kept in sync, is a real pattern — CQRS with read models. Why I would not reach for it here:

**DynamoDB is not a read replica.** A read replica is another copy of the same engine, kept current by the database itself, answering the same SQL. DynamoDB is a different database with a different query model. Putting it in the read path is not replication; it is maintaining a second, differently-shaped copy of the catalog, and you own the sync.

**It does not fit this query shape.** `category = X AND price BETWEEN a AND b ORDER BY price`, paginated, is servable by a GSI keyed on `category` with `price` as sort key — genuinely well. The trouble is everything else the brief implies. Add brand, in-stock, text search, sort by name or newest, and each combination wants its own GSI. `FilterExpression` applies _after_ items are read, so you are billed for rows you discard; Postgres evaluates the same predicates during an index range scan and never materialises them. Six GSIs later you are paying write capacity on all of them for every write, and arbitrary filter combinations still are not covered.

**Syncing two stores buys an eventual-consistency bug surface.** Write to Postgres, stream to DynamoDB, and a client that POSTs then immediately GETs may not see its own write. Replication lag becomes part of the API contract.

**Here it buys nothing, because caching already solved the problem.** Reads vastly outnumber writes and a listing tolerates 60 seconds of staleness, so CloudFront and nginx already absorb the overwhelming majority before the database is touched.

**Where DynamoDB would genuinely earn its place** is workloads that are actually key-value shaped, which a filtered catalog listing is not: session state and carts, idempotency keys with a TTL, atomic inventory counters where row-level lock contention in Postgres is a real risk, and clickstream events.

So the honest split is not "DynamoDB for reads, Postgres for writes". It is: Postgres stays the source of truth because the query pattern is relational; OpenSearch becomes the query engine once filtering and text outgrow it, fed by change-data-capture off the WAL; and DynamoDB takes the genuinely key-value workloads alongside them.

</details>

<details>
<summary><b>Next steps, in the order the constraints would bite</b></summary>

1. **A CDN at the edge.** Cheapest real improvement; the cache headers are already correct.
2. **Read replicas.** One-file change, thanks to the read/write split.
3. **Zero-downtime deploys.** Two API containers behind nginx with drain-and-swap closes the ~15 second gap.
4. **Materialised view for facet counts.** Turns the 81 ms scan into an index lookup; counts thirty seconds stale are almost never a problem.
5. **OpenSearch as a search sidecar,** fed by change-data-capture, with Postgres still the source of truth.
6. **Redis for hot product reads.** nginx caches by URL; Redis would cache by id, surviving across different filter URLs.
7. **Cache invalidation on write,** letting the TTL rise substantially.
8. **Bulk endpoints.** A 10,000-product import is currently 10,000 requests.
9. **Metrics and tracing.** Prometheus histograms per route and spans around queries turn "it feels slow" into a specific slow query.
10. **Per-user authorisation.** Writes take a shared key today; production needs identity and an audit trail of who changed which price.
11. **Partitioning by category** only at tens of millions of rows. Not before — it adds real complexity and buys nothing at this scale.

</details>

---

## Scope

The brief asked for a product catalog backend: CRUD, filtering by category and price with pagination, at a few hundred thousand products, reads ≫ writes, datastore of my choosing with the reasoning. That is what the core of this is.

<details>
<summary><b>What goes beyond the brief, and what I would cut first</b></summary>

**Traceable to a line in the brief:** ETags and cache headers plus the nginx layer ("reads vastly outnumber writes" is a caching requirement more than a code one); keyset pagination ("a few hundred thousand products" means deep pages are reachable and offset degrades there); `EXPLAIN ANALYZE` evidence (a datastore claim is worth more with numbers than adjectives); soft delete and `If-Match` (a catalog is edited concurrently and referenced by orders).

**Beyond it, and the first things I would cut:** full-text search, the facets endpoint, rate limiting, API-key auth, the dual-driver database seam, TLS, the deployment pipeline and the live console. None was asked for. They are here because the service is genuinely deployed and those are the things a deployed service needs — but the brief would have been satisfied without any of them.

**Deliberately not built:** a storefront UI (the brief says build the backend, so the front door is the API and a console for exercising it), `PUT` (a full replace on a resource with server-owned fields makes accidental field clearing the default; `PATCH` plus a required `If-Match` expresses the same intent without the hazard), bulk endpoints, image handling.

</details>
