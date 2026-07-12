import type { Archetype, Category, Climate, ColorFamily, Formality, Occasion, Silhouette, Subcategory } from "../claude/taxonomy";

export type ProductTags = {
  archetypePrimary: Archetype;
  archetypeSecondary: Archetype | null;
  silhouette: Silhouette[];
  colorFamily: ColorFamily[];
  formality: Formality;
  // Product-context fields, not used by scoreProduct's formula below --
  // consumed by rank.ts's hard filters (category/subcategory) and the
  // strict-first/graceful-relaxation gate (occasion/climate). Kept on the
  // same tags type as everything else since they're all AI-classified
  // attributes of the product; see CatalogTags in taxonomy.ts.
  category: Category;
  subcategory: Subcategory;
  occasion: Occasion[];
  climate: Climate;
};

export type StyleDNAInput = {
  archetypePrimary: Archetype;
  archetypeSecondary: Archetype | null;
  silhouette: Silhouette[];
  colorFamily: ColorFamily[];
  formality: Formality;
};

export type ScoreBreakdown = {
  archetypeScore: number;
  blendBonus: number;
  silhouetteScore: number;
  formalityScore: number;
  colorScore: number;
  total: number;
  matchedSilhouette: string[];
  matchedColorFamily: string[];
  /** Strongest tier that matched, for rationale text only -- does not by
   * itself decide the hard filter (see hasArchetypeOverlap). "primary" =
   * product.primary == profile.primary. "secondary_broadened" =
   * product.primary == profile.secondary. "blend_primary" =
   * product.secondary == profile.primary. "blend_secondary" =
   * product.secondary == profile.secondary. "none" = no tier matched. */
  archetypeMatchType: "primary" | "secondary_broadened" | "blend_primary" | "blend_secondary" | "none";
  /** The actual hard-filter signal (see rank.ts): true if ANY of the four
   * tiers above matched -- i.e. {profile.primary, profile.secondary} and
   * {product.primary, product.secondary} share at least one value. Revised
   * from an earlier version that only checked product.primary against the
   * profile: a product whose SECONDARY echoed the user's primary/secondary
   * was being excluded outright even though it's a real, meaningful
   * overlap (e.g. profile primary=clean_girl_minimal/secondary=old_money
   * should still surface a product with primary=scandi_minimal/
   * secondary=clean_girl_minimal, not lose it to the gate). */
  hasArchetypeOverlap: boolean;
};

// archetype_primary heaviest, silhouette/formality medium, color_family
// light-medium, fabric/texture excluded entirely -- per architecture
// freeze. blendBonus rewards a product whose *secondary* archetype echoes
// the profile without being required (broadening, not narrowing).
const WEIGHTS = {
  archetypePrimary: 40,
  archetypeSecondaryBroaden: 20,
  blendBonusPrimary: 10,
  blendBonusSecondary: 6,
  silhouette: 20,
  formality: 15,
  colorFamily: 10,
};

export const MAX_POSSIBLE_SCORE =
  WEIGHTS.archetypePrimary + WEIGHTS.blendBonusPrimary + WEIGHTS.silhouette + WEIGHTS.formality + WEIGHTS.colorFamily;

// "Palette distance" is weighted overlap of color_family enums (not
// pixel-level color math -- taxonomy only has categorical buckets), per
// architecture freeze. Same Jaccard mechanism used for silhouette.
function jaccard(a: string[], b: string[]): { overlap: number; matched: string[] } {
  const setA = new Set(a);
  const setB = new Set(b);
  const matched = [...setA].filter((x) => setB.has(x));
  const union = new Set([...setA, ...setB]).size;
  return { overlap: union === 0 ? 0 : matched.length / union, matched };
}

/** Exact enum matches only (PROJECT.md); fabric/texture excluded entirely. */
export function scoreProduct(profile: StyleDNAInput, product: ProductTags): ScoreBreakdown {
  let archetypeScore = 0;
  let primaryMatchType: "primary" | "secondary_broadened" | "none" = "none";
  if (product.archetypePrimary === profile.archetypePrimary) {
    archetypeScore = WEIGHTS.archetypePrimary;
    primaryMatchType = "primary";
  } else if (profile.archetypeSecondary && product.archetypePrimary === profile.archetypeSecondary) {
    archetypeScore = WEIGHTS.archetypeSecondaryBroaden;
    primaryMatchType = "secondary_broadened";
  }

  let blendBonus = 0;
  let blendMatchType: "blend_primary" | "blend_secondary" | "none" = "none";
  if (product.archetypeSecondary === profile.archetypePrimary) {
    blendBonus = WEIGHTS.blendBonusPrimary;
    blendMatchType = "blend_primary";
  } else if (
    profile.archetypeSecondary &&
    product.archetypeSecondary &&
    product.archetypeSecondary === profile.archetypeSecondary
  ) {
    blendBonus = WEIGHTS.blendBonusSecondary;
    blendMatchType = "blend_secondary";
  }

  const hasArchetypeOverlap = archetypeScore > 0 || blendBonus > 0;
  const archetypeMatchType = primaryMatchType !== "none" ? primaryMatchType : blendMatchType;

  const silhouette = jaccard(profile.silhouette, product.silhouette);
  const silhouetteScore = silhouette.overlap * WEIGHTS.silhouette;

  const formalityScore = profile.formality === product.formality ? WEIGHTS.formality : 0;

  const color = jaccard(profile.colorFamily, product.colorFamily);
  const colorScore = color.overlap * WEIGHTS.colorFamily;

  return {
    archetypeScore,
    blendBonus,
    silhouetteScore,
    formalityScore,
    colorScore,
    total: archetypeScore + blendBonus + silhouetteScore + formalityScore + colorScore,
    matchedSilhouette: silhouette.matched,
    matchedColorFamily: color.matched,
    archetypeMatchType,
    hasArchetypeOverlap,
  };
}
