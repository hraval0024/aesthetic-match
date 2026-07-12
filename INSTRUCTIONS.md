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

The repo ships `prisma/prod.db` — the real, already-tagged catalog (56
Shopify stores probed, 1,900 products ingested against the frozen taxonomy,
~1,800 images vision-tagged) built during development via the scripts below.
Copy it into place as your working database and you're running in seconds,
at zero additional cost:

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
(concurrency capped at 5). For the full 1,900-product catalog from an empty
cache, budget roughly **$20-35 and 30-60 minutes** — a rough estimate, not a
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

## Production deployment (Railway)

This app is deployed as a persistent Node process with a mounted volume,
not a serverless function — that matters because it has real state
(SQLite) and in-memory server state (the rate limiter in
`src/lib/security/rateLimit.ts`), both of which need one long-running
process to work correctly rather than many ephemeral instances.

1. **Create the Railway project** from this repo (`railway.toml` configures
   the build/start commands and health check explicitly, so Railway's
   Nixpacks auto-detection is a formality, not a dependency).
2. **Attach a Volume** to the service, mounted at a fixed path — `/data` is
   assumed throughout this doc.
3. **Set environment variables** on the service:
   - `ANTHROPIC_API_KEY` — required.
   - `DATABASE_URL=file:/data/prod.db` — required. Points at the volume,
     not the read-only bundled snapshot.
4. **Deploy.** On first boot, `src/lib/db/prisma.ts` finds nothing at
   `/data/prod.db` yet and seeds it once from the bundled, committed
   `prisma/prod.db` (the real 1,900-product tagged catalog). Every boot
   after that finds the seeded file already there and leaves it alone —
   writes made by the running app (e.g. `TagCache` upserts from live
   requests) land on the volume and persist across restarts and redeploys.
5. **Refreshing the catalog in production** means re-running `npm run
   ingest` + `npm run tag` locally, re-committing the updated
   `prisma/prod.db`, and redeploying — the volume's existing file is left
   alone by design (see step 4), so a catalog refresh requires deleting the
   file on the volume (via `railway run` or the dashboard's volume browser)
   before the next deploy, not just pushing a new commit.

`prisma/dev.db` is gitignored (local scratch state, rebuilt from the
snapshot or from scratch per above). `prisma/prod.db` is committed — it
**is** the catalog a fresh deploy seeds from.

### If deploying to a serverless host instead (e.g. Vercel)

The same `resolveDatabaseUrl()` function falls back to copying the bundled
snapshot into `/tmp` when no `DATABASE_URL` is set at all — this exists for
hosts with a read-only deployment filesystem and no persistent volume. Do
**not** set `DATABASE_URL` in that case. This path does not persist writes
across cold starts (see Known limitations) — it's a compatibility fallback,
not the primary deployment target.

## Known limitations

- **Catalog is a static snapshot**, not a live feed — by design (see
  PROJECT.md). Refreshing it means re-running `npm run ingest` + `npm run
  tag`, re-committing `prisma/prod.db`, and clearing the volume's existing
  copy before redeploying (see above).
- **`TagCache` only persists in production with a mounted volume.** On a
  serverless host with no volume (the `/tmp` fallback above), a cache miss
  just re-tags the image via Claude and produces an identical result, so
  it's a latency cost on a cold start, not a correctness issue — but it
  never actually warms up across requests on that kind of host.
- **No accounts** — StyleDNA and saved recommendations persist in the
  browser (`localStorage`/IndexedDB) per device, not synced across devices
  or browsers. This was a deliberate product decision, not an oversight.
