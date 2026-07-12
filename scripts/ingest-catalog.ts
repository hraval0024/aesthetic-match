// Offline catalog ingestion (catalog-expansion pass). Run manually via
// `npm run ingest`. Fetches each candidate store's public /products.json
// (paginated), health-checks it, normalizes Shopify's shape into our
// Product model (variant collapsing), then allocates a per-archetype
// quota with a per-store contribution cap and price-stratified sampling --
// replacing the earlier flat "first N products, single global cap" pass.
// Rewrites Store + Product on every run (full rebuild); TagCache is
// untouched so previously-tagged images are never re-tagged even after a
// full catalog rebuild.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db/prisma";

const USER_AGENT =
  "Mozilla/5.0 (compatible; AestheticMatchBot/0.1; +research/demo project, one request per store)";
const REQUEST_TIMEOUT_MS = 10_000;
const POLITENESS_DELAY_MS = 1000;
const PER_PAGE_LIMIT = 250; // Shopify's max page size for /products.json
const PER_STORE_PAGES = 2; // up to 500 raw products per store before sampling

// Coverage-driven targets (catalog-expansion design freeze): every
// archetype should have strong, realistic depth, not a forced uniform
// split. floor/target/cap bound that per archetype; perStoreCapFraction
// keeps any single store from dominating an archetype's allocation, so
// hitting the target requires real brand diversity.
// Tightened after a first real run: with cap=250 every well-supplied
// archetype hit the ceiling (10 archetypes landed at ~245 avg = 2454
// total), well over the 1500-2000 target -- real store supply exceeded
// the original cap almost everywhere, so the cap (not the target) was the
// binding constraint. cap=190 keeps every archetype close to its target
// while landing the total near the middle of the requested range.
const ARCHETYPE_FLOOR = 120;
const ARCHETYPE_TARGET = 170;
const ARCHETYPE_CAP = 190;
const PER_STORE_CAP_FRACTION = 0.4;

// Stratify each store's own contribution by price bucket rather than
// taking the first N as Shopify happens to return them (typically
// newest-first or ID order) -- otherwise sampling systematically biases
// toward whichever slice of a store's catalog loads first.
const PRICE_BUCKETS = [
  { label: "<$50", max: 50 },
  { label: "$50-100", max: 100 },
  { label: "$100-200", max: 200 },
  { label: "$200-400", max: 400 },
  { label: "$400+", max: Infinity },
];

type Candidate = { domain: string; archetype: string };
type StoreStatus = "ok" | "blocked" | "disabled" | "error";

type NormalizedProduct = {
  handle: string;
  title: string;
  productUrl: string;
  imageUrl: string;
  priceMin: number | null;
  priceMax: number | null;
  currency: null; // not present in public /products.json responses; UI displays a
  // flat "$" per product decision rather than guessing currency from domain TLD
  isAvailable: boolean;
  publishedAt: string | null;
};

type StoreResult = {
  domain: string;
  archetype: string;
  status: StoreStatus;
  httpCode: number | null;
  rawProductCount: number;
  normalizedProductCount: number;
  note: string;
  products: NormalizedProduct[];
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(
  domain: string,
  page: number,
): Promise<{ httpCode: number | null; status: StoreStatus; note: string; products: unknown[] }> {
  const url = `https://${domain}/products.json?limit=${PER_PAGE_LIMIT}&page=${page}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: controller.signal,
    });

    const httpCode = res.status;

    if (httpCode === 404) return { httpCode, status: "disabled", note: "endpoint not found", products: [] };
    if (httpCode === 401 || httpCode === 403) return { httpCode, status: "blocked", note: "access denied", products: [] };
    if (httpCode !== 200) return { httpCode, status: "error", note: `http ${httpCode}`, products: [] };

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return { httpCode, status: "blocked", note: "200 but not JSON (likely bot-challenge/HTML page)", products: [] };
    }

    if (!Array.isArray(json?.products)) {
      return { httpCode, status: "blocked", note: "200 JSON but no products array", products: [] };
    }

    return { httpCode, status: "ok", note: "", products: json.products };
  } catch (err: any) {
    const note = err?.name === "AbortError" ? "request timed out" : String(err?.message ?? err);
    return { httpCode: null, status: "error", note, products: [] };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchStoreProducts(domain: string): Promise<{
  httpCode: number | null;
  status: StoreStatus;
  note: string;
  raw: unknown[];
}> {
  const first = await fetchPage(domain, 1);
  if (first.status !== "ok") {
    return { httpCode: first.httpCode, status: first.status, note: first.note, raw: [] };
  }

  const allRaw: unknown[] = [...first.products];

  for (let page = 2; page <= PER_STORE_PAGES; page++) {
    if (first.products.length < PER_PAGE_LIMIT) break; // page 1 wasn't full -- no more pages
    await sleep(POLITENESS_DELAY_MS);
    const next = await fetchPage(domain, page);
    if (next.status !== "ok" || next.products.length === 0) break; // stop paginating, keep what we have
    allRaw.push(...next.products);
    if (next.products.length < PER_PAGE_LIMIT) break;
  }

  return { httpCode: first.httpCode, status: "ok", note: "", raw: allRaw };
}

function normalizeProduct(domain: string, raw: any): NormalizedProduct | null {
  if (!raw?.handle || !raw?.title) return null;

  const images = Array.isArray(raw.images) ? raw.images : [];
  const imageUrl: string | undefined = images[0]?.src ?? raw.image?.src;
  if (!imageUrl) return null; // no usable image -- can't vision-tag this later, so skip it

  const variants = Array.isArray(raw.variants) ? raw.variants : [];
  const prices = variants
    .map((v: any) => parseFloat(v?.price))
    .filter((p: number) => !Number.isNaN(p));
  const isAvailable = variants.some((v: any) => v?.available === true);

  return {
    handle: raw.handle,
    title: raw.title,
    productUrl: `https://${domain}/products/${raw.handle}`,
    imageUrl,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    currency: null,
    isAvailable,
    publishedAt: typeof raw.published_at === "string" ? raw.published_at : null,
  };
}

function priceBucketIndex(price: number | null): number {
  if (price == null) return PRICE_BUCKETS.length - 1;
  for (let i = 0; i < PRICE_BUCKETS.length; i++) {
    if (price < PRICE_BUCKETS[i].max) return i;
  }
  return PRICE_BUCKETS.length - 1;
}

/** Round-robin across price buckets rather than taking the first `cap`
 * items in whatever order they arrived -- deliberately engineers price
 * diversity into each store's contribution instead of leaving it
 * incidental. */
function stratifiedSample(products: NormalizedProduct[], cap: number): NormalizedProduct[] {
  if (products.length <= cap) return products;
  const buckets: NormalizedProduct[][] = PRICE_BUCKETS.map(() => []);
  for (const p of products) buckets[priceBucketIndex(p.priceMin)].push(p);

  const selected: NormalizedProduct[] = [];
  const pointers = buckets.map(() => 0);
  let progressed = true;
  while (selected.length < cap && progressed) {
    progressed = false;
    for (let b = 0; b < buckets.length; b++) {
      if (selected.length >= cap) break;
      if (pointers[b] < buckets[b].length) {
        selected.push(buckets[b][pointers[b]]);
        pointers[b]++;
        progressed = true;
      }
    }
  }
  return selected;
}

type Allocated = { domain: string; product: NormalizedProduct };

/** Round-robin across stores (not price bucket this time) to trim an
 * over-full archetype pool down to its cap -- preserves brand diversity
 * under trimming instead of e.g. keeping whichever store happened to sort
 * first. */
function trimRoundRobinByStore(pool: Allocated[], cap: number): Allocated[] {
  if (pool.length <= cap) return pool;
  const byDomain = new Map<string, Allocated[]>();
  for (const item of pool) {
    if (!byDomain.has(item.domain)) byDomain.set(item.domain, []);
    byDomain.get(item.domain)!.push(item);
  }
  const domains = [...byDomain.keys()];
  const pointers = domains.map(() => 0);
  const trimmed: Allocated[] = [];
  let progressed = true;
  while (trimmed.length < cap && progressed) {
    progressed = false;
    for (let i = 0; i < domains.length; i++) {
      if (trimmed.length >= cap) break;
      const items = byDomain.get(domains[i])!;
      if (pointers[i] < items.length) {
        trimmed.push(items[pointers[i]]);
        pointers[i]++;
        progressed = true;
      }
    }
  }
  return trimmed;
}

async function main() {
  const candidatesPath = path.join(process.cwd(), "data", "candidate_stores.json");
  const candidates: Candidate[] = JSON.parse(fs.readFileSync(candidatesPath, "utf-8"));

  console.log(JSON.stringify({ event: "ingestion_start", storeCount: candidates.length }));

  const results: StoreResult[] = [];

  for (const candidate of candidates) {
    const { domain, archetype } = candidate;
    const { httpCode, status, note, raw } = await fetchStoreProducts(domain);

    let normalized: NormalizedProduct[] = [];
    if (status === "ok") {
      const seen = new Set<string>();
      for (const p of raw) {
        const n = normalizeProduct(domain, p);
        if (n && !seen.has(n.handle)) {
          seen.add(n.handle);
          normalized.push(n);
        }
      }
    }

    const result: StoreResult = {
      domain,
      archetype,
      status,
      httpCode,
      rawProductCount: raw.length,
      normalizedProductCount: normalized.length,
      note,
      products: normalized,
    };
    results.push(result);

    console.log(
      JSON.stringify({
        event: "store_ingested",
        domain,
        archetype,
        status,
        httpCode,
        rawProductCount: raw.length,
        normalizedProductCount: normalized.length,
        note: note || undefined,
      }),
    );

    await sleep(POLITENESS_DELAY_MS);
  }

  const healthyStores = results.filter((r) => r.status === "ok" && r.normalizedProductCount > 0);

  const byArchetype = new Map<string, StoreResult[]>();
  for (const r of healthyStores) {
    if (!byArchetype.has(r.archetype)) byArchetype.set(r.archetype, []);
    byArchetype.get(r.archetype)!.push(r);
  }

  const trimmed: Allocated[] = [];
  const archetypeReport: Record<
    string,
    { floor: number; target: number; cap: number; achieved: number; belowFloor: boolean; storeContributions: Record<string, number> }
  > = {};

  const perStoreCap = Math.ceil(ARCHETYPE_TARGET * PER_STORE_CAP_FRACTION);

  for (const [archetype, stores] of byArchetype) {
    let pool: Allocated[] = [];
    for (const store of stores) {
      const sampled = stratifiedSample(store.products, perStoreCap);
      pool.push(...sampled.map((p) => ({ domain: store.domain, product: p })));
    }

    pool = trimRoundRobinByStore(pool, ARCHETYPE_CAP);

    const storeContributions: Record<string, number> = {};
    for (const item of pool) {
      storeContributions[item.domain] = (storeContributions[item.domain] ?? 0) + 1;
    }

    trimmed.push(...pool);
    archetypeReport[archetype] = {
      floor: ARCHETYPE_FLOOR,
      target: ARCHETYPE_TARGET,
      cap: ARCHETYPE_CAP,
      achieved: pool.length,
      belowFloor: pool.length < ARCHETYPE_FLOOR,
      storeContributions,
    };
  }

  // Full rebuild of Store + Product every run. TagCache is untouched.
  await prisma.product.deleteMany({});
  await prisma.store.deleteMany({});

  const storeIdByDomain = new Map<string, string>();
  for (const r of results) {
    const store = await prisma.store.create({
      data: { domain: r.domain, archetypeHint: r.archetype, status: r.status },
    });
    storeIdByDomain.set(r.domain, store.id);
  }

  for (const { domain, product } of trimmed) {
    const storeId = storeIdByDomain.get(domain)!;
    await prisma.product.create({
      data: {
        storeId,
        handle: product.handle,
        title: product.title,
        productUrl: product.productUrl,
        imageUrl: product.imageUrl,
        priceMin: product.priceMin,
        priceMax: product.priceMax,
        currency: product.currency,
        isAvailable: product.isAvailable,
        publishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
      },
    });
  }

  const byStatus: Record<StoreStatus, number> = { ok: 0, blocked: 0, disabled: 0, error: 0 };
  for (const r of results) byStatus[r.status]++;

  const report = {
    generatedAt: new Date().toISOString(),
    storesAttempted: results.length,
    storesByStatus: byStatus,
    rawProductsFetched: results.reduce((sum, r) => sum + r.rawProductCount, 0),
    normalizedProductsAvailable: results.reduce((sum, r) => sum + r.normalizedProductCount, 0),
    finalCatalogSize: trimmed.length,
    archetypeCoverage: archetypeReport,
    finalCatalogByStore: healthyStores.map((s) => ({
      domain: s.domain,
      archetype: s.archetype,
      contributed: trimmed.filter((t) => t.domain === s.domain).length,
      available: s.normalizedProductCount,
    })),
    failedStores: results
      .filter((r) => r.status !== "ok")
      .map((r) => ({
        domain: r.domain,
        archetype: r.archetype,
        status: r.status,
        httpCode: r.httpCode,
        note: r.note,
      })),
  };

  const reportPath = path.join(process.cwd(), "data", "ingestion-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({ event: "ingestion_complete", report }, null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(JSON.stringify({ event: "ingestion_fatal_error", error: String(err) }));
  await prisma.$disconnect();
  process.exit(1);
});
