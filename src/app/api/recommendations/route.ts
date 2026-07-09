import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { rankAndDiversify, describeMatch, type Candidate } from "@/lib/ranking/rank";
import type { StyleDNAInput } from "@/lib/ranking/score";
import { generateRationales } from "@/lib/claude/generateRationales";
import {
  isArchetype,
  isSilhouette,
  isFormality,
  isColorFamily,
  type Archetype,
  type ColorFamily,
  type Formality,
  type Silhouette,
} from "@/lib/claude/taxonomy";

export const runtime = "nodejs";

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

export async function POST(request: NextRequest) {
  const totalStart = Date.now();

  let body: { styleDNA?: unknown };
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

  // Stateless by design (no accounts): the profile lives on the client and
  // is sent with every request rather than persisted server-side. The
  // catalog itself is read-only here -- it's the offline-tagged snapshot
  // from Phase 2/3, not re-ingested or re-tagged per request.
  const products = await prisma.product.findMany({
    where: { imageHash: { not: null } },
    include: { store: true, tag: true },
  });

  const candidates: Candidate[] = products
    .filter((p): p is typeof p & { tag: NonNullable<(typeof p)["tag"]> } => p.tag !== null)
    .map((p) => ({
      productId: p.id,
      storeId: p.storeId,
      storeDomain: p.store.domain,
      title: p.title,
      productUrl: p.productUrl,
      imageUrl: p.imageUrl,
      priceMin: p.priceMin,
      tags: {
        archetypePrimary: p.tag.archetypePrimary as Archetype,
        archetypeSecondary: p.tag.archetypeSecondary as Archetype | null,
        silhouette: JSON.parse(p.tag.silhouette) as Silhouette[],
        colorFamily: JSON.parse(p.tag.colorFamily) as ColorFamily[],
        formality: p.tag.formality as Formality,
      },
    }));

  const rankingStart = Date.now();
  const { items, totalScored, totalArchetypeRelevant } = rankAndDiversify(profile, candidates);
  const rankingLatencyMs = Date.now() - rankingStart;

  let rationales = new Map<string, string>();
  let rationaleLatencyMs = 0;
  if (items.length > 0) {
    const rationaleStart = Date.now();
    rationales = await generateRationales(
      items.map((item) => ({
        productId: item.productId,
        title: item.title,
        matchedFacts: describeMatch(profile, item),
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
    score: Math.round(item.score * 10) / 10,
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
      totalCatalogSize: candidates.length,
      totalScored,
      totalArchetypeRelevant,
      returned: items.length,
      degraded: items.length < 20,
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
      totalArchetypeRelevant,
      degraded: items.length < 20,
      latencyMs: totalLatencyMs,
    },
  });
}
