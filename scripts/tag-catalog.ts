// Offline vision tagging (Phase 3). Run manually via `npm run tag`.
// For every catalog product: download its image, hash it, and either reuse
// an existing TagCache row (never re-tag identical images) or make one
// forced-tool-use Claude call and cache the result. Concurrency capped at 5
// simultaneous Claude requests -- deliberate rate-limit/cost guard agreed
// during architecture freeze.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db/prisma";
import { tagCatalogImage } from "../src/lib/claude/tagImage";
import { hashImage } from "../src/lib/images/hash";
import { createLimiter } from "../src/lib/concurrency/limiter";

const CONCURRENCY = 5;
const LOW_CONFIDENCE_THRESHOLD = 0.6;
const COVERAGE_ALERT_THRESHOLD = 0.15; // PROJECT.md: "if more than ~15%..."

type ProductResult = {
  productId: string;
  title: string;
  status: "cache_hit" | "tagged" | "tag_failed" | "download_failed" | "error";
  archetypePrimary?: string;
  confidence?: number;
  claudeLatencyMs?: number;
  note?: string;
};

async function tagProduct(product: {
  id: string;
  title: string;
  imageUrl: string;
}): Promise<ProductResult> {
  let bytes: Buffer;
  let mediaType: string;
  try {
    const res = await fetch(product.imageUrl);
    if (!res.ok) {
      return {
        productId: product.id,
        title: product.title,
        status: "download_failed",
        note: `http ${res.status}`,
      };
    }
    mediaType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return {
      productId: product.id,
      title: product.title,
      status: "download_failed",
      note: String((err as Error)?.message ?? err),
    };
  }

  const hash = hashImage(bytes);

  const cached = await prisma.tagCache.findUnique({ where: { imageHash: hash } });
  if (cached) {
    await prisma.product.update({ where: { id: product.id }, data: { imageHash: hash } });
    return {
      productId: product.id,
      title: product.title,
      status: "cache_hit",
      archetypePrimary: cached.archetypePrimary,
      confidence: cached.confidence ?? undefined,
    };
  }

  const start = Date.now();
  const result = await tagCatalogImage(bytes, mediaType);
  const claudeLatencyMs = Date.now() - start;

  if (!result.ok) {
    return {
      productId: product.id,
      title: product.title,
      status: "tag_failed",
      claudeLatencyMs,
      note: result.detail ? `${result.reason}: ${result.detail}` : result.reason,
    };
  }

  // upsert (not create): guards against a race where two concurrent tasks
  // both missed the cache check for the same image hash.
  await prisma.tagCache.upsert({
    where: { imageHash: hash },
    create: {
      imageHash: hash,
      archetypePrimary: result.tags.archetypePrimary,
      archetypeSecondary: result.tags.archetypeSecondary,
      silhouette: JSON.stringify(result.tags.silhouette),
      formality: result.tags.formality,
      colorFamily: JSON.stringify(result.tags.colorFamily),
      fabric: result.tags.fabric,
      textureNotes: result.tags.textureNotes,
      confidence: result.tags.confidence,
      category: result.tags.category,
      subcategory: result.tags.subcategory,
      occasion: JSON.stringify(result.tags.occasion),
      climate: result.tags.climate,
    },
    update: {},
  });
  await prisma.product.update({ where: { id: product.id }, data: { imageHash: hash } });

  return {
    productId: product.id,
    title: product.title,
    status: "tagged",
    archetypePrimary: result.tags.archetypePrimary,
    confidence: result.tags.confidence,
    claudeLatencyMs,
  };
}

async function main() {
  const products = await prisma.product.findMany({
    select: { id: true, title: true, imageUrl: true },
  });

  console.log(JSON.stringify({ event: "tagging_start", productCount: products.length }));

  const limit = createLimiter(CONCURRENCY);
  let completed = 0;

  const results = await Promise.all(
    products.map((p) =>
      limit(async () => {
        const r = await tagProduct(p);
        completed++;
        console.log(
          JSON.stringify({
            event: "product_tagged",
            progress: `${completed}/${products.length}`,
            title: r.title,
            status: r.status,
            archetypePrimary: r.archetypePrimary,
            confidence: r.confidence,
            note: r.note,
          }),
        );
        return r;
      }),
    ),
  );

  const cacheHits = results.filter((r) => r.status === "cache_hit");
  const freshlyTagged = results.filter((r) => r.status === "tagged");
  const failed = results.filter((r) => r.status === "tag_failed" || r.status === "error");
  const downloadFailed = results.filter((r) => r.status === "download_failed");

  const successfullyTagged = [...cacheHits, ...freshlyTagged];
  const confidences = successfullyTagged
    .map((r) => r.confidence)
    .filter((c): c is number => typeof c === "number");
  const avgConfidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : null;
  const lowConfidenceCount = confidences.filter((c) => c < LOW_CONFIDENCE_THRESHOLD).length;
  const lowConfidenceRate = confidences.length ? lowConfidenceCount / confidences.length : 0;

  const claudeLatencies = freshlyTagged
    .map((r) => r.claudeLatencyMs)
    .filter((l): l is number => typeof l === "number");
  const avgClaudeLatencyMs = claudeLatencies.length
    ? Math.round(claudeLatencies.reduce((a, b) => a + b, 0) / claudeLatencies.length)
    : null;

  const archetypeCounts: Record<string, number> = {};
  for (const r of successfullyTagged) {
    if (r.archetypePrimary) {
      archetypeCounts[r.archetypePrimary] = (archetypeCounts[r.archetypePrimary] ?? 0) + 1;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    totalProducts: products.length,
    cacheHits: cacheHits.length,
    freshlyTagged: freshlyTagged.length,
    failed: failed.length,
    downloadFailed: downloadFailed.length,
    cacheHitRate: products.length ? cacheHits.length / products.length : 0,
    successRate: products.length ? successfullyTagged.length / products.length : 0,
    avgClaudeLatencyMs,
    confidence: {
      threshold: LOW_CONFIDENCE_THRESHOLD,
      average: avgConfidence,
      lowConfidenceCount,
      lowConfidenceRate,
      exceedsCoverageAlertThreshold: lowConfidenceRate > COVERAGE_ALERT_THRESHOLD,
      note:
        lowConfidenceRate > COVERAGE_ALERT_THRESHOLD
          ? `${(lowConfidenceRate * 100).toFixed(1)}% of tagged items scored below ${LOW_CONFIDENCE_THRESHOLD} confidence -- exceeds the 15% signal threshold from PROJECT.md. Consider whether the taxonomy needs an additional archetype category.`
          : `${(lowConfidenceRate * 100).toFixed(1)}% of tagged items scored below ${LOW_CONFIDENCE_THRESHOLD} confidence -- within the 15% threshold, taxonomy looks adequate.`,
    },
    archetypeDistribution: archetypeCounts,
    failedItems: failed.map((r) => ({ title: r.title, status: r.status, note: r.note })),
    downloadFailedItems: downloadFailed.map((r) => ({ title: r.title, note: r.note })),
  };

  const reportPath = path.join(process.cwd(), "data", "tagging-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({ event: "tagging_complete", report }, null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(JSON.stringify({ event: "tagging_fatal_error", error: String(err) }));
  await prisma.$disconnect();
  process.exit(1);
});
