import { scoreProduct, type ProductTags, type ScoreBreakdown, type StyleDNAInput } from "./score";
import type { Category, Climate, Occasion, Subcategory } from "../claude/taxonomy";

export type Candidate = {
  productId: string;
  storeId: string;
  storeDomain: string;
  title: string;
  productUrl: string;
  imageUrl: string;
  priceMin: number | null;
  isAvailable: boolean;
  publishedAt: Date | null;
  tags: ProductTags;
};

export type RankedItem = {
  productId: string;
  storeDomain: string;
  title: string;
  productUrl: string;
  imageUrl: string;
  priceMin: number | null;
  publishedAt: Date | null;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  tags: ProductTags;
  /** Which pass produced this item. "exact" cleared the occasion/climate
   * gate in Pass 1 (or there was no occasion/climate intent to gate on --
   * everything is "exact" in a plain StyleDNA-only browse). "fallback"
   * only cleared it in the relaxed Pass 2 -- archetype/availability/
   * category/subcategory/price still applied, only occasion/climate were
   * dropped as a gate. Drives the "N exact occasion matches, then closest
   * StyleDNA matches" UI transparency requirement. */
  matchTier: "exact" | "fallback";
};

/** Per-query shopping intent, layered on top of the persistent StyleDNA
 * profile -- not part of StyleDNAInput itself, since occasion/climate are
 * additive context for one search, not a persistent profile attribute. */
export type QueryIntent = {
  occasion?: Occasion[];
  climate?: Climate;
  /** OR semantics -- a candidate matches if its category is any one of
   * these, not all of them (a product only ever has one category, so "all"
   * would be self-defeating whenever more than one is selected). */
  categories?: Category[];
  subcategory?: Subcategory;
  priceMin?: number;
  priceMax?: number;
  sort?: "best_match" | "newest" | "price_asc" | "price_desc";
};

export type RankResult = {
  items: RankedItem[];
  totalScored: number;
  /** Passed every absolute hard filter (availability, archetype overlap,
   * and any explicit category/subcategory/price selection) -- NOT
   * gated on occasion/climate, since those can relax in Pass 2. This is
   * the pool graceful degradation draws from. */
  totalEligible: number;
  exactCount: number;
  fallbackCount: number;
};

// The full ranked pool computed per request -- large enough to support
// several "Show 25 more" pages without feeling like we've scraped the
// bottom of the catalog, but still a bounded, curated set rather than
// "every eligible product." The API slices pages out of this; rationale
// generation only runs for the page actually being shown, not the whole
// pool, so paging doesn't multiply Claude cost.
const POOL_SIZE = 100;

// The "Show 25 more" unit -- also the block size the composition floor is
// applied at (see selectPoolWithComposition). Exported so the API route
// slices pages at the exact same boundary the pool was built in blocks of;
// if these ever drifted apart, a page could straddle two composition
// blocks and no longer reliably clear the floor on its own.
export const PAGE_SIZE = 25;

// Diminishing multiplier applied to the Nth item selected from the same
// store during greedy selection. Implements "avoid too many products from
// the same brand near the top" and "prefer diversification over strict
// score ranking when scores are close" -- without hard-excluding a store
// that genuinely has the best matches when there's no real alternative
// (the floor multiplier still lets it win rather than leaving slots empty).
const STORE_REPEAT_MULTIPLIER = [1, 0.82, 0.66, 0.52, 0.4, 0.32];

// Category-mix range: nothing in scoreProduct/greedySelect considers
// category at all, so whichever category happens to score best for a
// given profile could otherwise dominate the whole feed. Confirmed both
// directions for real: some profiles' top 20 skewed almost entirely
// bags/accessories (min-only floor didn't exist yet); after adding an
// apparel *floor*, a different profile swung to 100% apparel and zero
// accessories, because silhouette/formality/color -- 45 of ~95 max score
// points -- are axes accessories structurally score worse on than
// apparel (a scarf being "flowing" or "elevated_casual" barely applies
// the way it does to a dress), so apparel can legitimately out-score
// every eligible accessory. A floor alone can't prevent that -- it needs
// a ceiling too. Four buckets, each with its own min/max share of a page:
// reserve every bucket's minimum first, then fill remaining slots by
// score across buckets that haven't hit their maximum yet.
type Bucket = "apparel" | "shoes" | "bags" | "jewelry_accessories";

const BUCKET_CATEGORIES: Record<Bucket, ReadonlySet<string>> = {
  apparel: new Set(["tops", "bottoms", "dresses", "outerwear", "activewear", "swimwear"]),
  shoes: new Set(["shoes"]),
  bags: new Set(["bags"]),
  // "jewelry" in the original ask meant jewelry + accessories (hats,
  // scarves, sunglasses, hair accessories) combined -- confirmed with the
  // user rather than assumed, since accessories didn't map to any of the
  // four buckets as first specified.
  jewelry_accessories: new Set(["jewelry", "accessories"]),
};

const BUCKET_RANGES: Record<Bucket, { min: number; max: number }> = {
  apparel: { min: 0.45, max: 0.6 },
  shoes: { min: 0.3, max: 0.35 },
  bags: { min: 0.1, max: 0.15 },
  jewelry_accessories: { min: 0.05, max: 0.1 },
};

const BUCKET_NAMES = Object.keys(BUCKET_CATEGORIES) as Bucket[];

function bucketOf(category: string): Bucket | null {
  for (const name of BUCKET_NAMES) {
    if (BUCKET_CATEGORIES[name].has(category)) return name;
  }
  return null; // beauty_home -- already excluded entirely upstream (see passesAbsoluteFilters)
}

// Modest relative to the core style score (max ~95) -- occasion/climate are
// meant to drive the strict-first gate and break ties, not dominate the
// underlying style match. year_round gets partial credit: it's a real,
// deliberate match (climate-agnostic basics), just a weaker signal than an
// exact seasonal match.
const OCCASION_OVERLAP_WEIGHT = 12;
const CLIMATE_MATCH_WEIGHT = 6;
const CLIMATE_YEAR_ROUND_WEIGHT = 3;

// Best available proxy for "visually very similar" without image
// embeddings: same store + identical tag signature (category, archetype
// pair, silhouette set, color set, formality) reads as the same look,
// likely a color/size variant that survived ingestion's per-product
// collapsing under a different handle. category is part of the signature
// deliberately -- without it, a boot and a top from the same store that
// happened to share every other tag would collide in the same dedup
// group and one would silently drop, even though they're never actually
// "the same look" (confirmed for real: exactly this collision existed in
// the live catalog before this fix, one pair, low blast radius, but a
// real bug nonetheless).
function tagSignature(tags: ProductTags): string {
  return [
    tags.category,
    tags.archetypePrimary,
    tags.archetypeSecondary ?? "none",
    [...tags.silhouette].sort().join("+"),
    [...tags.colorFamily].sort().join("+"),
    tags.formality,
  ].join("|");
}

// Absolute hard filters: never relaxed, in either pass. Availability and
// archetype overlap are always-on; category/subcategory/price only apply
// when the user actually selected one (explicit constraints, not intent).
function passesAbsoluteFilters(candidate: Candidate, hasArchetypeOverlap: boolean, intent: QueryIntent): boolean {
  if (!candidate.isAvailable) return false;
  if (!hasArchetypeOverlap) return false;
  // beauty_home is excluded from the recommendation feed by default (frozen
  // catalog-coverage decision) -- this app matches fashion aesthetics, not
  // home decor or beauty. Only surfaces if a future UI explicitly browses
  // that category.
  if (candidate.tags.category === "beauty_home" && !intent.categories?.includes("beauty_home")) return false;
  // OR semantics: match if the candidate's category is any one of the
  // selected categories.
  if (intent.categories && intent.categories.length > 0 && !intent.categories.includes(candidate.tags.category)) {
    return false;
  }
  if (intent.subcategory && candidate.tags.subcategory !== intent.subcategory) return false;
  if (intent.priceMin != null && (candidate.priceMin == null || candidate.priceMin < intent.priceMin)) return false;
  if (intent.priceMax != null && (candidate.priceMin == null || candidate.priceMin > intent.priceMax)) return false;
  return true;
}

function occasionOverlapFraction(productOccasions: Occasion[], intentOccasions: Occasion[]): number {
  if (intentOccasions.length === 0) return 0;
  const set = new Set(productOccasions);
  const matched = intentOccasions.filter((o) => set.has(o)).length;
  return matched / intentOccasions.length;
}

// The strict Pass 1 gate: occasion needs real overlap, climate needs an
// exact match (year_round always passes -- broaden, not narrow, same
// philosophy as the archetype_secondary broadening mechanism).
function passesOccasionClimateGate(candidate: Candidate, intent: QueryIntent): boolean {
  if (intent.occasion && intent.occasion.length > 0) {
    if (occasionOverlapFraction(candidate.tags.occasion, intent.occasion) === 0) return false;
  }
  if (intent.climate) {
    if (candidate.tags.climate !== intent.climate && candidate.tags.climate !== "year_round") return false;
  }
  return true;
}

// In Pass 2, occasion/climate drop from a gate to this ranking bonus --
// partial overlap outranks zero overlap, but zero overlap no longer
// excludes.
function occasionClimateBonus(candidate: Candidate, intent: QueryIntent): number {
  let bonus = 0;
  if (intent.occasion && intent.occasion.length > 0) {
    bonus += occasionOverlapFraction(candidate.tags.occasion, intent.occasion) * OCCASION_OVERLAP_WEIGHT;
  }
  if (intent.climate) {
    if (candidate.tags.climate === intent.climate) bonus += CLIMATE_MATCH_WEIGHT;
    else if (candidate.tags.climate === "year_round") bonus += CLIMATE_YEAR_ROUND_WEIGHT;
  }
  return bonus;
}

type Scored = { candidate: Candidate; breakdown: ScoreBreakdown; effectiveScore: number };

function dedupeBestPerGroup(scored: Scored[]): Scored[] {
  const bestPerGroup = new Map<string, Scored>();
  for (const s of scored) {
    const key = `${s.candidate.storeId}::${tagSignature(s.candidate.tags)}`;
    const existing = bestPerGroup.get(key);
    if (!existing || s.effectiveScore > existing.effectiveScore) {
      bestPerGroup.set(key, s);
    }
  }
  const deduped = [...bestPerGroup.values()];
  deduped.sort(
    (a, b) => b.effectiveScore - a.effectiveScore || a.candidate.productId.localeCompare(b.candidate.productId),
  );
  return deduped;
}

// Greedy store-diversity selection. storeCounts is passed in (and mutated)
// rather than created fresh each call, so Pass 2 continues Pass 1's
// diversity accounting instead of resetting it -- a store that already
// contributed 3 items in Pass 1 shouldn't get a fresh diversity budget for
// Pass 2's fallback fill.
function greedySelect(pool: Scored[], count: number, storeCounts: Map<string, number>): Scored[] {
  const remaining = [...pool];
  const selected: Scored[] = [];

  while (selected.length < count && remaining.length > 0) {
    let bestIndex = 0;
    let bestEffective = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = storeCounts.get(remaining[i].candidate.storeId) ?? 0;
      const multiplier = STORE_REPEAT_MULTIPLIER[Math.min(c, STORE_REPEAT_MULTIPLIER.length - 1)];
      const effective = remaining[i].effectiveScore * multiplier;
      if (effective > bestEffective) {
        bestEffective = effective;
        bestIndex = i;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    storeCounts.set(chosen.candidate.storeId, (storeCounts.get(chosen.candidate.storeId) ?? 0) + 1);
    selected.push(chosen);
  }
  return selected;
}

// Same greedy store-diversity logic as greedySelect, but also skips any
// candidate whose bucket has already hit its max share -- used for the
// "fill remaining slots" phase after bucket minimums are reserved, so a
// high-scoring bucket can't eat slots reserved (by their maximum) for
// weaker-scoring ones.
function greedySelectWithBucketCaps(
  pool: Scored[],
  count: number,
  storeCounts: Map<string, number>,
  bucketCounts: Record<Bucket, number>,
  bucketMax: Record<Bucket, number>,
): Scored[] {
  const remaining = [...pool];
  const selected: Scored[] = [];

  while (selected.length < count && remaining.length > 0) {
    let bestIndex = -1;
    let bestEffective = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const bucket = bucketOf(remaining[i].candidate.tags.category);
      if (bucket && bucketCounts[bucket] >= bucketMax[bucket]) continue;
      const c = storeCounts.get(remaining[i].candidate.storeId) ?? 0;
      const multiplier = STORE_REPEAT_MULTIPLIER[Math.min(c, STORE_REPEAT_MULTIPLIER.length - 1)];
      const effective = remaining[i].effectiveScore * multiplier;
      if (effective > bestEffective) {
        bestEffective = effective;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) break; // everything left is capped out at its bucket's max
    const [chosen] = remaining.splice(bestIndex, 1);
    storeCounts.set(chosen.candidate.storeId, (storeCounts.get(chosen.candidate.storeId) ?? 0) + 1);
    const bucket = bucketOf(chosen.candidate.tags.category);
    if (bucket) bucketCounts[bucket]++;
    selected.push(chosen);
  }
  return selected;
}

// Reserves each bucket's minimum share first, then fills remaining slots
// by score across buckets that haven't hit their maximum -- a floor AND a
// ceiling, not just a floor (see the comment on BUCKET_RANGES for why a
// floor alone wasn't enough). If capping leaves slots unfilled because the
// pool is too thin for a bucket to reach its share, tops up uncapped
// rather than leaving slots artificially empty -- same graceful-
// degradation principle as everything else here: never fabricate to hit a
// target, only guarantee it when the pool genuinely supports it. When
// `enforceComposition` is false (the user explicitly filtered to one
// category/subcategory), the whole scheme is moot -- every candidate is
// already that one category -- so this degrades to a single greedySelect
// call, unchanged from before.
function selectWithComposition(
  pool: Scored[],
  count: number,
  storeCounts: Map<string, number>,
  enforceComposition: boolean,
): Scored[] {
  if (!enforceComposition || count === 0) {
    return greedySelect(pool, count, storeCounts);
  }

  const bucketCounts: Record<Bucket, number> = { apparel: 0, shoes: 0, bags: 0, jewelry_accessories: 0 };
  const bucketMax: Record<Bucket, number> = { apparel: 0, shoes: 0, bags: 0, jewelry_accessories: 0 };
  for (const name of BUCKET_NAMES) bucketMax[name] = Math.ceil(count * BUCKET_RANGES[name].max);

  const selected: Scored[] = [];
  const selectedIds = new Set<string>();

  for (const name of BUCKET_NAMES) {
    const bucketPool = pool.filter((s) => bucketOf(s.candidate.tags.category) === name);
    // round, not floor -- with count=25 (the common case), 25*0.30=7.5 for
    // shoes' 30% minimum; flooring to 7 (28%) reads as "fell short of the
    // range" even though it's a rounding artifact, not a real shortfall.
    // Rounding lands inside the target range far more often.
    const minCount = Math.min(Math.round(count * BUCKET_RANGES[name].min), bucketPool.length);
    const picked = greedySelect(bucketPool, minCount, storeCounts);
    for (const p of picked) {
      selected.push(p);
      selectedIds.add(p.candidate.productId);
      bucketCounts[name]++;
    }
  }

  let remainingPool = pool.filter((s) => !selectedIds.has(s.candidate.productId));
  const capped = greedySelectWithBucketCaps(remainingPool, count - selected.length, storeCounts, bucketCounts, bucketMax);
  for (const p of capped) {
    selected.push(p);
    selectedIds.add(p.candidate.productId);
  }

  if (selected.length < count) {
    remainingPool = pool.filter((s) => !selectedIds.has(s.candidate.productId));
    selected.push(...greedySelect(remainingPool, count - selected.length, storeCounts));
  }

  return selected;
}

// Applying the bucket ranges once across the whole POOL_SIZE would only
// guarantee them in aggregate -- nothing stops a bucket's share from
// concentrating on, say, page 4, while page 1 (the only page most people
// ever see) comes back skewed. Confirmed for real: one test profile hit
// 36% apparel on page 1 even with a pool-wide-only floor in place.
// Building the pool in PAGE_SIZE blocks, each independently
// composition-checked, means every page -- not just the pool as a whole --
// clears every bucket's range on its own.
function selectPoolWithComposition(
  pool: Scored[],
  totalCount: number,
  storeCounts: Map<string, number>,
  enforceComposition: boolean,
): Scored[] {
  const selected: Scored[] = [];
  let remaining = pool;

  while (selected.length < totalCount && remaining.length > 0) {
    const blockTarget = Math.min(PAGE_SIZE, totalCount - selected.length);
    const block = selectWithComposition(remaining, blockTarget, storeCounts, enforceComposition);
    if (block.length === 0) break;
    selected.push(...block);
    const blockIds = new Set(block.map((s) => s.candidate.productId));
    remaining = remaining.filter((s) => !blockIds.has(s.candidate.productId));
  }

  return selected;
}

function toRankedItem(s: Scored, matchTier: RankedItem["matchTier"]): RankedItem {
  return {
    productId: s.candidate.productId,
    storeDomain: s.candidate.storeDomain,
    title: s.candidate.title,
    productUrl: s.candidate.productUrl,
    imageUrl: s.candidate.imageUrl,
    priceMin: s.candidate.priceMin,
    publishedAt: s.candidate.publishedAt,
    score: s.effectiveScore,
    scoreBreakdown: s.breakdown,
    tags: s.candidate.tags,
    matchTier,
  };
}

// Ascending tuple compare -- relevance (negated score) is always the
// secondary deterministic tiebreak, productId the final one, per the
// frozen sort design. best_match sorts purely by relevance (tuple[0]).
function sortKey(item: RankedItem, sort: NonNullable<QueryIntent["sort"]>): [number, number, string] {
  const relevance = -item.score;
  switch (sort) {
    case "newest":
      return [-(item.publishedAt?.getTime() ?? 0), relevance, item.productId];
    case "price_asc":
      return [item.priceMin ?? Infinity, relevance, item.productId];
    case "price_desc":
      return [-(item.priceMin ?? -Infinity), relevance, item.productId];
    case "best_match":
    default:
      return [relevance, 0, item.productId];
  }
}

// Sorts WITHIN each matchTier group, exact always first -- re-sorting to
// "newest" or a price order never hides that some results are fallback
// matches (frozen transparency requirement: the grouping persists under
// every sort mode).
//
// best_match is deliberately NOT re-sorted here: selectPoolWithComposition
// already produced it in composition-preserving block order (each
// PAGE_SIZE block internally best-score-first within its own apparel/rest
// split). A flat re-sort by raw score would undo that block structure the
// same way a single pool-wide composition pass did -- pulling every
// non-apparel item above every apparel item regardless of which block
// they were reserved into. Explicit sort modes (newest/price) are a
// deliberate user override and intentionally take priority over
// composition, the same precedent as an explicit category filter
// disabling the floor entirely.
function applySort(items: RankedItem[], sort: NonNullable<QueryIntent["sort"]>): RankedItem[] {
  if (sort === "best_match") return items;

  const exact = items.filter((i) => i.matchTier === "exact");
  const fallback = items.filter((i) => i.matchTier === "fallback");
  const sortGroup = (group: RankedItem[]) =>
    [...group].sort((a, b) => {
      const ka = sortKey(a, sort);
      const kb = sortKey(b, sort);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    });
  return [...sortGroup(exact), ...sortGroup(fallback)];
}

export function rankAndDiversify(
  profile: StyleDNAInput,
  candidates: Candidate[],
  intent: QueryIntent = {},
): RankResult {
  const scored = candidates.map((c) => ({ candidate: c, breakdown: scoreProduct(profile, c.tags) }));

  const eligible = scored.filter((s) => passesAbsoluteFilters(s.candidate, s.breakdown.hasArchetypeOverlap, intent));

  const hasOccasionOrClimateIntent = Boolean((intent.occasion && intent.occasion.length > 0) || intent.climate);

  // A composition floor is moot once the user has explicitly filtered to
  // one or more categories/a subcategory -- the eligible pool is already
  // scoped to exactly what they asked for, so there's nothing to balance
  // against. Applies whenever ANY category is selected, not just one --
  // multi-select doesn't get its own balancing scheme.
  const enforceComposition = !(intent.categories && intent.categories.length > 0) && !intent.subcategory;

  const withBonus = (s: (typeof eligible)[number]): Scored => ({
    ...s,
    effectiveScore: s.breakdown.total + occasionClimateBonus(s.candidate, intent),
  });

  // Pass 1 -- strict: eligible pool, additionally gated on occasion/climate
  // if specified.
  const pass1Pool = hasOccasionOrClimateIntent
    ? eligible.filter((s) => passesOccasionClimateGate(s.candidate, intent))
    : eligible;
  const pass1Deduped = dedupeBestPerGroup(pass1Pool.map(withBonus));

  const storeCounts = new Map<string, number>();
  const pass1Selected = selectPoolWithComposition(pass1Deduped, POOL_SIZE, storeCounts, enforceComposition).map(
    (s) => toRankedItem(s, "exact"),
  );

  let allSelected = pass1Selected;

  // Pass 2 -- fallback: only engages if there was an occasion/climate
  // intent to relax AND Pass 1 came up short. Same eligible pool (so
  // archetype/availability/category/subcategory/price stay absolute),
  // minus whatever Pass 1 already selected; occasion/climate no longer
  // gate, only contribute the ranking bonus. The composition floor applies
  // independently within this pass's own contribution -- never blends a
  // fallback item ahead of an exact-tier one just to hit the apparel quota,
  // since exact-tier is always ordered first regardless (see applySort).
  if (hasOccasionOrClimateIntent && pass1Selected.length < POOL_SIZE) {
    const usedIds = new Set(pass1Selected.map((s) => s.productId));
    const fallbackPool = eligible.filter((s) => !usedIds.has(s.candidate.productId));
    const fallbackDeduped = dedupeBestPerGroup(fallbackPool.map(withBonus));
    const fallbackSelected = selectPoolWithComposition(
      fallbackDeduped,
      POOL_SIZE - pass1Selected.length,
      storeCounts,
      enforceComposition,
    ).map((s) => toRankedItem(s, "fallback"));
    allSelected = [...pass1Selected, ...fallbackSelected];
  }

  const sorted = applySort(allSelected, intent.sort ?? "best_match");

  return {
    items: sorted,
    totalScored: scored.length,
    totalEligible: eligible.length,
    exactCount: sorted.filter((i) => i.matchTier === "exact").length,
    fallbackCount: sorted.filter((i) => i.matchTier === "fallback").length,
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
export function describeMatch(profile: StyleDNAInput, item: RankedItem, intent: QueryIntent = {}): string[] {
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
  if (intent.occasion && intent.occasion.length > 0) {
    const matchedOccasions = item.tags.occasion.filter((o) => intent.occasion!.includes(o));
    if (matchedOccasions.length > 0) {
      facts.push(`suits the search: ${matchedOccasions.map(humanize).join(", ")}`);
    } else if (item.matchTier === "fallback") {
      facts.push(`closest style match (not a direct occasion match)`);
    }
  }
  if (intent.climate && (item.tags.climate === intent.climate || item.tags.climate === "year_round")) {
    facts.push(`climate: ${humanize(item.tags.climate)}`);
  }
  return facts;
}
