import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { rankAndDiversify, describeMatch, PAGE_SIZE, type Candidate, type QueryIntent } from "@/lib/ranking/rank";
import type { StyleDNAInput } from "@/lib/ranking/score";
import { generateRationales } from "@/lib/claude/generateRationales";
import { checkRateLimit, getClientKey } from "@/lib/security/rateLimit";
import {
  isArchetype,
  isSilhouette,
  isFormality,
  isColorFamily,
  isCategory,
  isSubcategory,
  isOccasion,
  isClimate,
  type Archetype,
  type Category,
  type Climate,
  type ColorFamily,
  type Formality,
  type Occasion,
  type Silhouette,
  type Subcategory,
} from "@/lib/claude/taxonomy";

export const runtime = "nodejs";

const SORT_MODES = ["best_match", "newest", "price_asc", "price_desc"] as const;
// PAGE_SIZE is imported from rank.ts, not redefined here -- it's also the
// block size the composition floor is applied at, so the API slicing
// pages at any other boundary would let a page straddle two composition
// blocks and lose the per-page apparel guarantee.

// Validates enum membership, not just field presence/type. A StyleDNA saved
// to localStorage before a taxonomy change (or hand-edited via devtools)
// would otherwise pass a loose type check, silently fail every archetype
// comparison in scoring, and surface to the user as an empty "no matches in
// our catalog" state -- which misattributes a broken local profile to an
// inventory problem. Rejecting it explicitly here lets the client tell the
// user to rebuild their StyleDNA instead.
function isValidStyleDNA(value: unknown): value is StyleDNAInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!isArchetype(v.archetypePrimary)) return false;
  if (v.archetypeSecondary !== null && !isArchetype(v.archetypeSecondary)) return false;
  if (!Array.isArray(v.silhouette) || !v.silhouette.every(isSilhouette)) return false;
  if (!Array.isArray(v.colorFamily) || !v.colorFamily.every(isColorFamily)) return false;
  if (!isFormality(v.formality)) return false;
  return true;
}

// Intent is optional, additive shopping context (occasion/climate/category/
// subcategory/price/sort) layered on top of the persistent StyleDNA -- see
// ranking model freeze. Parsed permissively: an invalid or missing field is
// just dropped (no filter applied for that field) rather than failing the
// whole request, since intent is opt-in refinement, not core input like
// styleDNA is.
function parseIntent(raw: unknown): QueryIntent {
  if (typeof raw !== "object" || raw === null) return {};
  const v = raw as Record<string, unknown>;
  const intent: QueryIntent = {};

  if (Array.isArray(v.occasion)) {
    const occasion = v.occasion.filter(isOccasion) as Occasion[];
    if (occasion.length > 0) intent.occasion = occasion;
  }
  if (isClimate(v.climate)) intent.climate = v.climate as Climate;
  if (Array.isArray(v.categories)) {
    const categories = v.categories.filter(isCategory) as Category[];
    if (categories.length > 0) intent.categories = categories;
  }
  if (isSubcategory(v.subcategory)) intent.subcategory = v.subcategory as Subcategory;
  if (typeof v.priceMin === "number" && Number.isFinite(v.priceMin)) intent.priceMin = v.priceMin;
  if (typeof v.priceMax === "number" && Number.isFinite(v.priceMax)) intent.priceMax = v.priceMax;
  if (typeof v.sort === "string" && (SORT_MODES as readonly string[]).includes(v.sort)) {
    intent.sort = v.sort as QueryIntent["sort"];
  }

  return intent;
}

function parseOffset(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

// Generous relative to legitimate use (initial load + several "Show 25
// more" pages in one browsing session) but still a real ceiling -- each
// request pays for a page of Claude rationale generation, confirmed the
// single most expensive per-request cost in this app (see the performance
// logging below: rationale generation routinely dominates total latency).
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

export async function POST(request: NextRequest) {
  const totalStart = Date.now();

  const rateLimit = checkRateLimit(`recommendations:${getClientKey(request)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: { styleDNA?: unknown; intent?: unknown; offset?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body with a styleDNA field." }, { status: 400 });
  }

  if (body.styleDNA === undefined || body.styleDNA === null) {
    return NextResponse.json({ error: "Missing styleDNA in request body." }, { status: 400 });
  }
  if (!isValidStyleDNA(body.styleDNA)) {
    return NextResponse.json(
      {
        error: "Your saved style profile looks out of date or invalid. Please rebuild your StyleDNA.",
        code: "invalid_style_dna",
      },
      { status: 422 },
    );
  }
  const profile = body.styleDNA;
  const intent = parseIntent(body.intent);
  const offset = parseOffset(body.offset);

  // Stateless by design (no accounts): the profile lives on the client and
  // is sent with every request rather than persisted server-side. The
  // catalog itself is read-only here -- it's the offline-tagged snapshot,
  // not re-ingested or re-tagged per request.
  const products = await prisma.product.findMany({
    where: { imageHash: { not: null } },
    include: { store: true, tag: true },
  });

  // A catalog product's tag must have gone through PRODUCT_TAG_TOOL (which
  // always sets category/subcategory/occasion/climate) -- TagCache is
  // shared with user-uploaded StyleDNA photo tagging (TAG_TOOL), which
  // leaves those fields null. A row with any of them null is a user-photo
  // tag, not a usable catalog candidate, and is filtered out here.
  const candidates: Candidate[] = products
    .filter(
      (p): p is typeof p & { tag: NonNullable<(typeof p)["tag"]> } =>
        p.tag !== null &&
        p.tag.category !== null &&
        p.tag.subcategory !== null &&
        p.tag.occasion !== null &&
        p.tag.climate !== null,
    )
    .map((p) => ({
      productId: p.id,
      storeId: p.storeId,
      storeDomain: p.store.domain,
      title: p.title,
      productUrl: p.productUrl,
      imageUrl: p.imageUrl,
      priceMin: p.priceMin,
      isAvailable: p.isAvailable,
      publishedAt: p.publishedAt,
      tags: {
        archetypePrimary: p.tag.archetypePrimary as Archetype,
        archetypeSecondary: p.tag.archetypeSecondary as Archetype | null,
        silhouette: JSON.parse(p.tag.silhouette) as Silhouette[],
        colorFamily: JSON.parse(p.tag.colorFamily) as ColorFamily[],
        formality: p.tag.formality as Formality,
        category: p.tag.category as Category,
        subcategory: p.tag.subcategory as Subcategory,
        occasion: JSON.parse(p.tag.occasion as string) as Occasion[],
        climate: p.tag.climate as Climate,
      },
    }));

  const rankingStart = Date.now();
  // Ranking computes the full pool (deterministic, no AI cost) fresh every
  // request rather than caching -- cheap enough that recomputing keeps page
  // 2's ordering guaranteed consistent with page 1's, with no separate
  // cache-invalidation story to get wrong.
  const { items: fullPool, totalScored, totalEligible, exactCount, fallbackCount } = rankAndDiversify(
    profile,
    candidates,
    intent,
  );
  const rankingLatencyMs = Date.now() - rankingStart;

  const items = fullPool.slice(offset, offset + PAGE_SIZE);

  let rationales = new Map<string, string>();
  let rationaleLatencyMs = 0;
  if (items.length > 0) {
    const rationaleStart = Date.now();
    // Only the page actually being shown pays for rationale generation --
    // paging through a deep pool via "Show 25 more" doesn't multiply
    // Claude cost by however many pages a user clicks through.
    rationales = await generateRationales(
      items.map((item) => ({
        productId: item.productId,
        title: item.title,
        matchedFacts: describeMatch(profile, item, intent),
      })),
    );
    rationaleLatencyMs = Date.now() - rationaleStart;
  }

  const recommendations = items.map((item) => ({
    productId: item.productId,
    title: item.title,
    store: item.storeDomain,
    productUrl: item.productUrl,
    imageUrl: item.imageUrl,
    priceMin: item.priceMin,
    publishedAt: item.publishedAt,
    score: Math.round(item.score * 10) / 10,
    matchTier: item.matchTier,
    tags: item.tags,
    rationale: rationales.get(item.productId) ?? null,
  }));

  const totalLatencyMs = Date.now() - totalStart;
  const scores = items.map((i) => i.score);
  const storeDistribution = items.reduce<Record<string, number>>((acc, i) => {
    acc[i.storeDomain] = (acc[i.storeDomain] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    JSON.stringify({
      event: "recommendations_generated",
      profileArchetypePrimary: profile.archetypePrimary,
      profileArchetypeSecondary: profile.archetypeSecondary,
      intent,
      offset,
      totalCatalogSize: candidates.length,
      totalScored,
      totalEligible,
      poolSize: fullPool.length,
      returned: items.length,
      exactCount,
      fallbackCount,
      // Degraded means the whole pool (across every page) is thin, not
      // just that this particular page came back small -- the last page
      // of a healthy pool is expected to be partial, that's normal
      // pagination, not degradation.
      degraded: fullPool.length < PAGE_SIZE,
      scoreMin: scores.length ? Math.min(...scores) : null,
      scoreMax: scores.length ? Math.max(...scores) : null,
      scoreAvg: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
      distinctStores: Object.keys(storeDistribution).length,
      storeDistribution,
      rationalesGenerated: rationales.size,
      totalLatencyMs,
      rankingLatencyMs,
      rationaleLatencyMs,
      exceeds3sTarget: totalLatencyMs > 3000,
    }),
  );

  return NextResponse.json({
    recommendations,
    meta: {
      returned: items.length,
      totalCatalogSize: candidates.length,
      totalEligible,
      totalAvailable: fullPool.length,
      offset,
      hasMore: offset + items.length < fullPool.length,
      exactCount,
      fallbackCount,
      degraded: fullPool.length < PAGE_SIZE,
      latencyMs: totalLatencyMs,
    },
  });
}
