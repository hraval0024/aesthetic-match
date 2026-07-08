// Offline catalog ingestion (Phase 2). Run manually via `npm run ingest`.
// Fetches each candidate store's public /products.json, health-checks it,
// normalizes Shopify's shape into our Product model (variant collapsing),
// then round-robin trims to a global cap so no single store dominates.
// Rewrites Store + Product on every run (full rebuild); TagCache from
// Phase 3 is untouched so previously-tagged images are never re-tagged
// even after a full catalog rebuild.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db/prisma";

const USER_AGENT =
  "Mozilla/5.0 (compatible; AestheticMatchBot/0.1; +research/demo project, one request per store)";
const REQUEST_TIMEOUT_MS = 10_000;
const POLITENESS_DELAY_MS = 1000;
const PER_STORE_LIMIT = 100; // single page, no pagination -- see tradeoffs in ingestion report
const GLOBAL_CATALOG_CAP = 200;

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

async function fetchStoreProducts(domain: string): Promise<{
  httpCode: number | null;
  status: StoreStatus;
  note: string;
  raw: unknown[];
}> {
  const url = `https://${domain}/products.json?limit=${PER_STORE_LIMIT}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: controller.signal,
    });

    const httpCode = res.status;

    if (httpCode === 404) {
      return { httpCode, status: "disabled", note: "endpoint not found", raw: [] };
    }
    if (httpCode === 401 || httpCode === 403) {
      return { httpCode, status: "blocked", note: "access denied", raw: [] };
    }
    if (httpCode !== 200) {
      return { httpCode, status: "error", note: `http ${httpCode}`, raw: [] };
    }

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        httpCode,
        status: "blocked",
        note: "200 but not JSON (likely bot-challenge/HTML page)",
        raw: [],
      };
    }

    if (!Array.isArray(json?.products)) {
      return { httpCode, status: "blocked", note: "200 JSON but no products array", raw: [] };
    }

    return { httpCode, status: "ok", note: "", raw: json.products };
  } catch (err: any) {
    const note = err?.name === "AbortError" ? "request timed out" : String(err?.message ?? err);
    return { httpCode: null, status: "error", note, raw: [] };
  } finally {
    clearTimeout(timeout);
  }
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

  return {
    handle: raw.handle,
    title: raw.title,
    productUrl: `https://${domain}/products/${raw.handle}`,
    imageUrl,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    currency: null,
  };
}

function roundRobinTrim(
  byStore: { domain: string; products: NormalizedProduct[] }[],
  cap: number,
): { domain: string; product: NormalizedProduct }[] {
  const queues = byStore.map((s) => ({ domain: s.domain, items: [...s.products] }));
  const selected: { domain: string; product: NormalizedProduct }[] = [];
  let progressed = true;

  while (selected.length < cap && progressed) {
    progressed = false;
    for (const q of queues) {
      if (selected.length >= cap) break;
      const next = q.items.shift();
      if (next) {
        selected.push({ domain: q.domain, product: next });
        progressed = true;
      }
    }
  }
  return selected;
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

  const trimmed = roundRobinTrim(
    healthyStores.map((s) => ({ domain: s.domain, products: s.products })),
    GLOBAL_CATALOG_CAP,
  );

  // Full rebuild of Store + Product every run. TagCache (Phase 3) is untouched.
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
      },
    });
  }

  const byStatus: Record<StoreStatus, number> = { ok: 0, blocked: 0, disabled: 0, error: 0 };
  for (const r of results) byStatus[r.status]++;

  const archetypeCounts: Record<string, number> = {};
  for (const { domain, product } of trimmed) {
    void product;
    const archetype = results.find((r) => r.domain === domain)!.archetype;
    archetypeCounts[archetype] = (archetypeCounts[archetype] ?? 0) + 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    storesAttempted: results.length,
    storesByStatus: byStatus,
    rawProductsFetched: results.reduce((sum, r) => sum + r.rawProductCount, 0),
    normalizedProductsAvailable: results.reduce((sum, r) => sum + r.normalizedProductCount, 0),
    globalCap: GLOBAL_CATALOG_CAP,
    finalCatalogSize: trimmed.length,
    finalCatalogByArchetype: archetypeCounts,
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
