import { scoreProduct, type ProductTags, type ScoreBreakdown, type StyleDNAInput } from "./score";

export type Candidate = {
  productId: string;
  storeId: string;
  storeDomain: string;
  title: string;
  productUrl: string;
  imageUrl: string;
  priceMin: number | null;
  tags: ProductTags;
};

export type RankedItem = {
  productId: string;
  storeDomain: string;
  title: string;
  productUrl: string;
  imageUrl: string;
  priceMin: number | null;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  tags: ProductTags;
};

export type RankResult = {
  items: RankedItem[];
  totalScored: number;
  totalArchetypeRelevant: number;
};

const TOP_N = 20;

// Diminishing multiplier applied to the Nth item selected from the same
// store during greedy selection. Implements "avoid too many products from
// the same brand near the top" and "prefer diversification over strict
// score ranking when scores are close" -- without hard-excluding a store
// that genuinely has the best matches when there's no real alternative
// (the floor multiplier still lets it win rather than leaving slots empty).
const STORE_REPEAT_MULTIPLIER = [1, 0.82, 0.66, 0.52, 0.4, 0.32];

// Best available proxy for "visually very similar" without image
// embeddings: same store + identical tag signature (archetype pair,
// silhouette set, color set, formality) reads as the same look, likely a
// color/size variant that survived Phase 2's per-product collapsing under
// a different handle.
function tagSignature(tags: ProductTags): string {
  return [
    tags.archetypePrimary,
    tags.archetypeSecondary ?? "none",
    [...tags.silhouette].sort().join("+"),
    [...tags.colorFamily].sort().join("+"),
    tags.formality,
  ].join("|");
}

export function rankAndDiversify(profile: StyleDNAInput, candidates: Candidate[]): RankResult {
  const scored = candidates.map((c) => ({ candidate: c, breakdown: scoreProduct(profile, c.tags) }));

  // Hard filter, not just a weight: prioritizing archetype_primary means an
  // item with zero archetype relationship (doesn't match primary, doesn't
  // broaden via secondary) is never a real recommendation. This is also
  // the graceful-degradation path -- if a profile has weak catalog overlap,
  // fewer than 20 items clear this bar and we return fewer, rather than
  // padding the feed with archetype-irrelevant "matches."
  const archetypeRelevant = scored.filter((s) => s.breakdown.archetypeMatchType !== "none");

  const bestPerGroup = new Map<string, (typeof archetypeRelevant)[number]>();
  for (const s of archetypeRelevant) {
    const key = `${s.candidate.storeId}::${tagSignature(s.candidate.tags)}`;
    const existing = bestPerGroup.get(key);
    if (!existing || s.breakdown.total > existing.breakdown.total) {
      bestPerGroup.set(key, s);
    }
  }
  const deduped = [...bestPerGroup.values()];
  deduped.sort(
    (a, b) => b.breakdown.total - a.breakdown.total || a.candidate.productId.localeCompare(b.candidate.productId),
  );

  const storeCounts = new Map<string, number>();
  const remaining = [...deduped];
  const selected: typeof deduped = [];

  while (selected.length < TOP_N && remaining.length > 0) {
    let bestIndex = 0;
    let bestEffective = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const count = storeCounts.get(remaining[i].candidate.storeId) ?? 0;
      const multiplier = STORE_REPEAT_MULTIPLIER[Math.min(count, STORE_REPEAT_MULTIPLIER.length - 1)];
      const effective = remaining[i].breakdown.total * multiplier;
      if (effective > bestEffective) {
        bestEffective = effective;
        bestIndex = i;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    storeCounts.set(chosen.candidate.storeId, (storeCounts.get(chosen.candidate.storeId) ?? 0) + 1);
    selected.push(chosen);
  }

  return {
    items: selected.map((s) => ({
      productId: s.candidate.productId,
      storeDomain: s.candidate.storeDomain,
      title: s.candidate.title,
      productUrl: s.candidate.productUrl,
      imageUrl: s.candidate.imageUrl,
      priceMin: s.candidate.priceMin,
      score: s.breakdown.total,
      scoreBreakdown: s.breakdown,
      tags: s.candidate.tags,
    })),
    totalScored: scored.length,
    totalArchetypeRelevant: archetypeRelevant.length,
  };
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

/** Precomputed real facts for the rationale prompt -- Claude phrases them
 * naturally but doesn't invent or re-derive the match itself. Humanized
 * here (not left to the model) so raw enum strings like
 * "cottagecore_romantic" never get a chance to leak into user-facing copy
 * verbatim -- observed happening when the underscored form was fed as-is. */
export function describeMatch(profile: StyleDNAInput, item: RankedItem): string[] {
  const b = item.scoreBreakdown;
  const facts: string[] = [];

  if (b.archetypeMatchType === "primary") {
    facts.push(`primary archetype: ${humanize(item.tags.archetypePrimary)}`);
  } else if (b.archetypeMatchType === "secondary_broadened") {
    facts.push(`archetype ${humanize(item.tags.archetypePrimary)} matches the user's secondary aesthetic`);
  }
  if (item.tags.archetypeSecondary && b.blendBonus > 0) {
    facts.push(`secondary archetype: ${humanize(item.tags.archetypeSecondary)}`);
  }
  if (b.matchedSilhouette.length) {
    facts.push(`shared silhouette: ${b.matchedSilhouette.map(humanize).join(", ")}`);
  }
  if (b.formalityScore > 0) {
    facts.push(`shared formality: ${humanize(item.tags.formality)}`);
  }
  if (b.matchedColorFamily.length) {
    facts.push(`shared color family: ${b.matchedColorFamily.map(humanize).join(", ")}`);
  }
  return facts;
}
