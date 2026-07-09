# Setup Instructions

Tested end-to-end in a clean checkout on Node 20.19.2 / npm 10.8.2. These steps
work in a fresh Linux container with no prior state — no native compilation
step is required (SQLite is accessed via `@prisma/adapter-libsql`, a
pure-JS/prebuilt-binary driver adapter, deliberately chosen over
`better-sqlite3` earlier in this project after `better-sqlite3` failed to
compile in a fresh container).

## Requirements

- Node.js 20.x and npm (no other system packages needed)
- An Anthropic API key with access to `claude-opus-4-8` and `claude-haiku-4-5`

## 1. Install dependencies

**Order matters here** — create `.env` *before* running `npm ci`. The
install's `postinstall` hook runs `prisma generate`, which reads
`DATABASE_URL` via `prisma.config.ts`; if `.env` doesn't exist yet, that step
fails outright (`Cannot resolve environment variable: DATABASE_URL`).

```bash
cp .env.example .env
```

Edit `.env` and set a real `ANTHROPIC_API_KEY`. Leave `DATABASE_URL` as-is
(`file:./prisma/dev.db`). The other stub keys in `.env.example` (OpenAI,
ElevenLabs, Google Cloud, AWS) are not used by this project — safe to leave
as placeholders.

```bash
npm ci
```

## 2. Set up the catalog database

The app needs a populated SQLite database — a `Store`/`Product` catalog and
its Claude-generated `TagCache` — before recommendations can return anything.
There are two ways to get one:

### Fast path (recommended): use the committed snapshot

The repo ships `prisma/prod.db` — the real, already-tagged catalog (34
Shopify stores probed, 200 products ingested, 213 images vision-tagged) built
during development via the scripts below. Copy it into place as your working
database and you're running in seconds, at zero additional cost:

```bash
cp prisma/prod.db prisma/dev.db
```

### From-scratch path (optional): rebuild the catalog yourself

Only do this if you want to verify the ingestion/tagging pipeline itself, or
refresh the catalog. It makes real network requests to live Shopify stores
and real, billed calls to the Claude API.

```bash
npm run db:push     # create the schema in prisma/dev.db
npm run ingest       # scrape the curated store list -- ~1-2 min, no API cost
npm run tag          # vision-tag every product image via Claude
```

`npm run tag` calls `claude-opus-4-8` once per not-yet-cached product image
(concurrency capped at 5). For a full 200-product catalog from an empty
cache, budget roughly **$2-4 and a few minutes** — a rough estimate, not a
quote; re-runs are cheap since `TagCache` is keyed by image hash and already-
tagged images are never re-tagged.

## 3. Run it

```bash
npm run dev
```

Visit `http://localhost:3000`. Upload 5-10 fashion photos, build a StyleDNA,
see recommendations.

For a production-mode smoke test locally:

```bash
npm run build
npm run start
```

## 4. Verify the setup worked

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/          # 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/profile   # 200
curl -s -X POST http://localhost:3000/api/recommendations \
  -H "Content-Type: application/json" \
  -d '{"styleDNA":{"archetypePrimary":"old_money","archetypeSecondary":null,"silhouette":["tailored"],"colorFamily":["neutral_cream"],"formality":"elevated_casual"}}'
# Should return a non-empty "recommendations" array from the real catalog.
```

## Production deployment notes

- Set **only** `ANTHROPIC_API_KEY` as an environment variable on the hosting
  platform. Do **not** set `DATABASE_URL` in production.
- With no `DATABASE_URL` override, `src/lib/db/prisma.ts` automatically
  copies the bundled read-only `prisma/prod.db` into a writable location
  (`/tmp`) on first use and points the connection there — this is what makes
  `TagCache` writes (caching a newly-uploaded photo's tags) work on hosts
  with a read-only deployment filesystem (e.g. Vercel serverless functions).
  Local dev never hits this path, since `.env` sets `DATABASE_URL` explicitly.
- `prisma/dev.db` is gitignored (local scratch state, rebuilt from the
  snapshot or from scratch per above). `prisma/prod.db` is committed — it
  **is** the deployed catalog.

## Known limitations

- **Catalog is a static snapshot**, not a live feed — by design (see
  PROJECT.md). Refreshing it means re-running `npm run ingest` + `npm run
  tag` and re-committing `prisma/prod.db`.
- **`TagCache` doesn't persist across serverless cold starts** in production
  (see above) — a cache miss just re-tags the image via Claude and produces
  an identical result, so this affects latency on a cold start, not
  correctness.
- **No accounts** — StyleDNA and saved recommendations persist in the
  browser (`localStorage`/IndexedDB) per device, not synced across devices
  or browsers. This was a deliberate product decision, not an oversight.
