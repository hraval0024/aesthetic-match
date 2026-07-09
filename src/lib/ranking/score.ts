import type { Archetype, ColorFamily, Formality, Silhouette } from "../claude/taxonomy";

export type ProductTags = {
  archetypePrimary: Archetype;
  archetypeSecondary: Archetype | null;
  silhouette: Silhouette[];
  colorFamily: ColorFamily[];
  formality: Formality;
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
  /** "primary" = product's archetype_primary matches the profile's primary.
   * "secondary_broadened" = product's archetype_primary matches the
   * profile's *secondary* -- this is the broadening mechanism (pulls in
   * more candidates) rather than requiring both to match (which would
   * narrow). "none" = no archetype relationship at all, which is a hard
   * exclusion (see rank.ts) since PROJECT.md weights archetype_primary
   * heaviest and prioritizing it means an archetype-irrelevant item is
   * never a real recommendation regardless of other overlap. */
  archetypeMatchType: "primary" | "secondary_broadened" | "none";
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
  let archetypeMatchType: ScoreBreakdown["archetypeMatchType"] = "none";
  if (product.archetypePrimary === profile.archetypePrimary) {
    archetypeScore = WEIGHTS.archetypePrimary;
    archetypeMatchType = "primary";
  } else if (profile.archetypeSecondary && product.archetypePrimary === profile.archetypeSecondary) {
    archetypeScore = WEIGHTS.archetypeSecondaryBroaden;
    archetypeMatchType = "secondary_broadened";
  }

  let blendBonus = 0;
  if (product.archetypeSecondary === profile.archetypePrimary) {
    blendBonus = WEIGHTS.blendBonusPrimary;
  } else if (
    profile.archetypeSecondary &&
    product.archetypeSecondary &&
    product.archetypeSecondary === profile.archetypeSecondary
  ) {
    blendBonus = WEIGHTS.blendBonusSecondary;
  }

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
  };
}
