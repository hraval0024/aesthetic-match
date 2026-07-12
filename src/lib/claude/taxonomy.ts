// Fixed style taxonomy (PROJECT.md), plus the product-context taxonomy
// (category, subcategory, occasion, climate) frozen in the catalog-expansion
// design pass. Do not let synonym drift between calls -- scoring is
// exact-enum-match, so a single off-taxonomy tag fails silently.
// archetype_secondary/occasion use closed enums validated in code (second
// safety net behind forced tool_choice), same pattern throughout this file.

export const ARCHETYPES = [
  "coastal",
  "old_money",
  "clean_girl_minimal",
  "streetwear_athletic",
  "cottagecore_romantic",
  "scandi_minimal",
  "trend_forward",
  "edgy",
  "bohemian",
  "classic",
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

// Pure dressiness scale. vacation/college were removed -- those describe
// context/occasion, not dressiness, and now live in OCCASIONS below where
// they belong (vacation -> vacation_resort/vacation_city, college folded
// into everyday/loungewear_home as appropriate per-item).
export const FORMALITIES = [
  "loungewear",
  "casual",
  "elevated_casual",
  "business",
  "formal",
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

export const CATEGORIES = [
  "tops",
  "bottoms",
  "dresses",
  "outerwear",
  "activewear",
  "swimwear",
  "shoes",
  "bags",
  "accessories",
  "jewelry",
  "beauty_home",
] as const;

// Flat list for the tool schema (Claude's strict tool-use mode needs a
// plain string enum, not a category-conditional schema -- the same
// constraint that shaped every other enum here). CATEGORY_SUBCATEGORIES
// below is the second safety net that enforces a subcategory actually
// belongs to its category, validated in code same as everything else.
export const SUBCATEGORIES = [
  "t_shirt", "blouse", "shirt", "sweater", "sweatshirt", "tank", "bodysuit", "polo",
  "jeans", "trousers", "shorts", "skirt", "leggings",
  "mini_dress", "midi_dress", "maxi_dress", "jumpsuit_romper",
  "jacket", "coat", "blazer", "cardigan",
  "sports_bra", "athletic_top", "athletic_bottom", "athletic_set",
  "bikini", "one_piece", "cover_up",
  "sneakers", "sandals", "heels", "flats", "boots",
  "tote", "crossbody", "clutch", "backpack",
  "hat", "scarf", "belt", "sunglasses", "hair_accessory",
  "earrings", "necklace", "bracelet", "ring",
  "fragrance", "home_decor", "other",
] as const;

// occasion is deliberately multi-value (unlike archetype_primary) -- a
// single product routinely suits several occasions at once (a slip dress
// is date_night AND wedding_guest AND vacation_city), and forcing a single
// dominant value would throw away real signal the ranking model can use.
export const OCCASIONS = [
  "everyday",
  "work",
  "date_night",
  "brunch_daytime_social",
  "vacation_resort",
  "vacation_city",
  "wedding_guest",
  "formal_event",
  "party_night_out",
  "athletic_active",
  "festival",
  "loungewear_home",
] as const;

export const CLIMATES = [
  "warm_weather",
  "cold_weather",
  "transitional",
  "year_round",
] as const;

export type Archetype = (typeof ARCHETYPES)[number];
export type Silhouette = (typeof SILHOUETTES)[number];
export type Formality = (typeof FORMALITIES)[number];
export type ColorFamily = (typeof COLOR_FAMILIES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Subcategory = (typeof SUBCATEGORIES)[number];
export type Occasion = (typeof OCCASIONS)[number];
export type Climate = (typeof CLIMATES)[number];

export const CATEGORY_SUBCATEGORIES: Record<Category, readonly Subcategory[]> = {
  tops: ["t_shirt", "blouse", "shirt", "sweater", "sweatshirt", "tank", "bodysuit", "polo"],
  bottoms: ["jeans", "trousers", "shorts", "skirt", "leggings"],
  dresses: ["mini_dress", "midi_dress", "maxi_dress", "jumpsuit_romper"],
  outerwear: ["jacket", "coat", "blazer", "cardigan"],
  activewear: ["sports_bra", "athletic_top", "athletic_bottom", "athletic_set"],
  swimwear: ["bikini", "one_piece", "cover_up"],
  shoes: ["sneakers", "sandals", "heels", "flats", "boots"],
  bags: ["tote", "crossbody", "clutch", "backpack"],
  accessories: ["hat", "scarf", "belt", "sunglasses", "hair_accessory"],
  jewelry: ["earrings", "necklace", "bracelet", "ring"],
  beauty_home: ["fragrance", "home_decor", "other"],
};

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

/** Catalog products get everything ImageTags has, plus the product-context
 * fields that only make sense for something you can shop for -- a user's
 * personal inspiration photo doesn't have a category or an occasion, so
 * these are intentionally NOT part of ImageTags/TAG_TOOL (used for
 * StyleDNA photo tagging). Keeping them separate means profile creation
 * doesn't pay extra tokens/latency for fields aggregateStyleDNA never
 * reads. */
export type CatalogTags = ImageTags & {
  category: Category;
  subcategory: Subcategory;
  occasion: Occasion[];
  climate: Climate;
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

export const PRODUCT_TAG_TOOL_NAME = "tag_catalog_product_image";

export const PRODUCT_TAG_TOOL = {
  name: PRODUCT_TAG_TOOL_NAME,
  description:
    "Classify a catalog product image into the fixed style and shopping-context taxonomy for aesthetic matching.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      ...TAG_TOOL.input_schema.properties,
      category: {
        type: "string",
        enum: CATEGORIES,
        description: "The top-level product category.",
      },
      subcategory: {
        type: "string",
        enum: SUBCATEGORIES,
        description: "The specific product type within the category (e.g. 'midi_dress' under 'dresses').",
      },
      occasion: {
        type: "array",
        items: { type: "string", enum: OCCASIONS },
        description: "1-4 occasions this item genuinely suits -- pick every occasion that honestly applies, not just the single best one.",
      },
      climate: {
        type: "string",
        enum: CLIMATES,
        description: "The weather/season this item is suited for. Use year_round for climate-agnostic basics.",
      },
    },
    required: [...TAG_TOOL.input_schema.required, "category", "subcategory", "occasion", "climate"],
    additionalProperties: false,
  },
} as const;

export function isArchetype(value: unknown): value is Archetype {
  return typeof value === "string" && (ARCHETYPES as readonly string[]).includes(value);
}

export function isSilhouette(value: unknown): value is Silhouette {
  return typeof value === "string" && (SILHOUETTES as readonly string[]).includes(value);
}

export function isFormality(value: unknown): value is Formality {
  return typeof value === "string" && (FORMALITIES as readonly string[]).includes(value);
}

export function isColorFamily(value: unknown): value is ColorFamily {
  return typeof value === "string" && (COLOR_FAMILIES as readonly string[]).includes(value);
}

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

export function isSubcategory(value: unknown): value is Subcategory {
  return typeof value === "string" && (SUBCATEGORIES as readonly string[]).includes(value);
}

export function isOccasion(value: unknown): value is Occasion {
  return typeof value === "string" && (OCCASIONS as readonly string[]).includes(value);
}

export function isClimate(value: unknown): value is Climate {
  return typeof value === "string" && (CLIMATES as readonly string[]).includes(value);
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

/**
 * Same second-safety-net role as validateTags, extended for the catalog
 * fields. Additionally enforces subcategory-belongs-to-category, the one
 * cross-field rule the flat tool schema can't express on its own.
 */
export function validateCatalogTags(input: unknown): CatalogTags | null {
  const base = validateTags(input);
  if (!base) return null;
  const raw = input as Record<string, unknown>;

  if (!isCategory(raw.category)) return null;
  if (!isSubcategory(raw.subcategory)) return null;
  if (!CATEGORY_SUBCATEGORIES[raw.category].includes(raw.subcategory)) return null;

  if (
    !Array.isArray(raw.occasion) ||
    raw.occasion.length < 1 ||
    raw.occasion.length > 4 ||
    !raw.occasion.every(isOccasion)
  ) {
    return null;
  }

  if (!isClimate(raw.climate)) return null;

  return {
    ...base,
    category: raw.category,
    subcategory: raw.subcategory,
    occasion: raw.occasion as Occasion[],
    climate: raw.climate,
  };
}
