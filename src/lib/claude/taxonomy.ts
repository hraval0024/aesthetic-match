// Fixed style taxonomy (PROJECT.md). Do not let synonym drift between calls --
// scoring is exact-enum-match, so a single off-taxonomy tag fails silently.
// archetype_secondary uses the sentinel string "none" rather than a JSON null
// enum member, which keeps the tool schema a plain string-enum (more robust
// across schema validators) -- callers translate "none" -> null.

export const ARCHETYPES = [
  "coastal_grandmother",
  "old_money",
  "clean_girl_minimal",
  "streetwear_athletic",
  "cottagecore_romantic",
  "scandi_minimal",
  "trend_forward",
  "edgy_alternative",
  "bohemian",
] as const;

export const SILHOUETTES = [
  "oversized",
  "fitted",
  "relaxed",
  "structured",
  "boxy",
  "flowing",
  "tailored",
] as const;

export const FORMALITIES = [
  "loungewear",
  "casual",
  "elevated_casual",
  "business",
  "formal",
  "vacation",
  "college",
] as const;

export const COLOR_FAMILIES = [
  "neutral_cream",
  "earth_tone",
  "monochrome_black",
  "pastel",
  "jewel_tone",
  "bright_bold",
  "denim_blue",
  "metallic",
] as const;

export type Archetype = (typeof ARCHETYPES)[number];
export type Silhouette = (typeof SILHOUETTES)[number];
export type Formality = (typeof FORMALITIES)[number];
export type ColorFamily = (typeof COLOR_FAMILIES)[number];

export type ImageTags = {
  archetypePrimary: Archetype;
  archetypeSecondary: Archetype | null;
  silhouette: Silhouette[];
  formality: Formality;
  colorFamily: ColorFamily[];
  fabric: string;
  textureNotes: string;
  /** 0-1, model's own confidence in archetype_primary. Not used in scoring --
   * reporting only, for the taxonomy-coverage signal (PROJECT.md: "if more
   * than ~15% of tagged items can't be confidently placed... report it"). */
  confidence: number;
};

export const TAG_TOOL_NAME = "tag_fashion_image";

export const TAG_TOOL = {
  name: TAG_TOOL_NAME,
  description:
    "Classify a fashion image into the fixed style taxonomy for aesthetic matching.",
  // Guarantees tool_use.input validates exactly against input_schema --
  // without this, arrays with a single valid item (e.g. silhouette: ["relaxed"])
  // were observed coming back as a bare string ("relaxed"), which the second
  // safety-net validator in code correctly rejected but retrying alone would
  // not have fixed, since it's a systematic schema gap, not a random miss.
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      archetype_primary: {
        type: "string",
        enum: ARCHETYPES,
        description: "The single dominant style archetype for this look.",
      },
      archetype_secondary: {
        type: "string",
        enum: [...ARCHETYPES, "none"],
        description:
          "A second archetype if the look blends two aesthetics, otherwise 'none'.",
      },
      silhouette: {
        type: "array",
        items: { type: "string", enum: SILHOUETTES },
        description: "1-3 silhouette descriptors.",
      },
      formality: {
        type: "string",
        enum: FORMALITIES,
      },
      color_family: {
        type: "array",
        items: { type: "string", enum: COLOR_FAMILIES },
        description: "1-3 color family descriptors.",
      },
      fabric: {
        type: "string",
        description:
          "Material/composition, e.g. '100% silk' or 'mostly natural fabric'. Free text, not used in scoring.",
      },
      texture_notes: {
        type: "string",
        description:
          "Short free-text phrase, e.g. 'nubby linen weave'. Flavor for rationale generation only, never used in scoring.",
      },
      confidence: {
        type: "number",
        description:
          "A number from 0 to 1: your confidence that archetype_primary is a correct, confident placement (not a forced best-guess). Not used in scoring.",
      },
    },
    required: [
      "archetype_primary",
      "archetype_secondary",
      "silhouette",
      "formality",
      "color_family",
      "fabric",
      "texture_notes",
      "confidence",
    ],
    additionalProperties: false,
  },
} as const;

export function isArchetype(value: unknown): value is Archetype {
  return typeof value === "string" && (ARCHETYPES as readonly string[]).includes(value);
}

function isSilhouette(value: unknown): value is Silhouette {
  return typeof value === "string" && (SILHOUETTES as readonly string[]).includes(value);
}

function isFormality(value: unknown): value is Formality {
  return typeof value === "string" && (FORMALITIES as readonly string[]).includes(value);
}

function isColorFamily(value: unknown): value is ColorFamily {
  return typeof value === "string" && (COLOR_FAMILIES as readonly string[]).includes(value);
}

/**
 * Second safety net behind the forced tool_choice + enum schema: re-validate
 * every field against the taxonomy in code. Returns null if invalid (caller
 * retries once).
 */
export function validateTags(input: unknown): ImageTags | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;

  if (!isArchetype(raw.archetype_primary)) return null;

  const archetypeSecondary =
    raw.archetype_secondary === "none" ? null : raw.archetype_secondary;
  if (archetypeSecondary !== null && !isArchetype(archetypeSecondary)) return null;

  if (
    !Array.isArray(raw.silhouette) ||
    raw.silhouette.length < 1 ||
    raw.silhouette.length > 3 ||
    !raw.silhouette.every(isSilhouette)
  ) {
    return null;
  }

  if (!isFormality(raw.formality)) return null;

  if (
    !Array.isArray(raw.color_family) ||
    raw.color_family.length < 1 ||
    raw.color_family.length > 3 ||
    !raw.color_family.every(isColorFamily)
  ) {
    return null;
  }

  if (typeof raw.fabric !== "string") return null;
  if (typeof raw.texture_notes !== "string") return null;

  if (
    typeof raw.confidence !== "number" ||
    raw.confidence < 0 ||
    raw.confidence > 1
  ) {
    return null;
  }

  return {
    archetypePrimary: raw.archetype_primary,
    archetypeSecondary,
    silhouette: raw.silhouette as Silhouette[],
    formality: raw.formality,
    colorFamily: raw.color_family as ColorFamily[],
    fabric: raw.fabric,
    textureNotes: raw.texture_notes,
    confidence: raw.confidence,
  };
}
