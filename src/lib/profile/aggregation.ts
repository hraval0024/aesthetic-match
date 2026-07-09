import type { Archetype, ColorFamily, Formality, ImageTags, Silhouette } from "../claude/taxonomy";

export type StyleDNA = {
  archetypePrimary: Archetype;
  archetypeSecondary: Archetype | null;
  silhouette: Silhouette[];
  colorFamily: ColorFamily[];
  formality: Formality;
  sourceImageCount: number;
};

// Mode with earliest-upload-order tiebreak: precompute full counts, then walk
// the original (upload) order and only replace the running winner on a
// STRICT improvement -- so among values tied for the max count, the one that
// appears earliest in the array wins, per the agreed deterministic rule.
function modeEarliestTiebreak<T extends string>(valuesInUploadOrder: T[]): T {
  const counts = new Map<T, number>();
  for (const v of valuesInUploadOrder) counts.set(v, (counts.get(v) ?? 0) + 1);

  let bestValue = valuesInUploadOrder[0];
  let bestCount = 0;
  for (const v of valuesInUploadOrder) {
    const c = counts.get(v)!;
    if (c > bestCount) {
      bestCount = c;
      bestValue = v;
    }
  }
  return bestValue;
}

// archetype_secondary = second-most-frequent archetype_primary across the
// reference images (not each image's own archetype_secondary field -- the
// user wants dominant styles to emerge from the set, not the model's
// per-image secondary guess), if it appears at least twice. Same
// earliest-order tiebreak as primary.
function pickArchetypes(archetypesInUploadOrder: Archetype[]): {
  primary: Archetype;
  secondary: Archetype | null;
} {
  const primary = modeEarliestTiebreak(archetypesInUploadOrder);

  const remaining = archetypesInUploadOrder.filter((a) => a !== primary);
  if (remaining.length === 0) return { primary, secondary: null };

  const counts = new Map<Archetype, number>();
  for (const v of remaining) counts.set(v, (counts.get(v) ?? 0) + 1);

  let secondary: Archetype | null = null;
  let secondaryCount = 0;
  for (const v of remaining) {
    const c = counts.get(v)!;
    if (c > secondaryCount) {
      secondaryCount = c;
      secondary = v;
    }
  }

  return { primary, secondary: secondaryCount >= 2 ? secondary : null };
}

// silhouette / color_family = union of values appearing in >=40% of
// reference images. Dedupes within a single image's own array first so one
// image can't inflate a value's count by listing it twice. Sorted by
// frequency desc (ties broken alphabetically) purely for stable, readable
// output -- order has no scoring meaning downstream.
function pickByFrequencyThreshold<T extends string>(
  valuesPerImage: T[][],
  totalImages: number,
  threshold: number,
): T[] {
  const counts = new Map<T, number>();
  for (const imageValues of valuesPerImage) {
    for (const v of new Set(imageValues)) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count / totalImages >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value);
}

const FREQUENCY_THRESHOLD = 0.4;

/**
 * Deterministic Style DNA aggregation across the user's tagged reference
 * images, in upload order (order matters -- it's the tiebreak signal).
 * Pure function: no I/O, no DB, easy to unit-test / call from any caller.
 */
export function aggregateStyleDNA(taggedImagesInUploadOrder: ImageTags[]): StyleDNA {
  if (taggedImagesInUploadOrder.length === 0) {
    throw new Error("aggregateStyleDNA requires at least one tagged image");
  }

  const { primary, secondary } = pickArchetypes(
    taggedImagesInUploadOrder.map((t) => t.archetypePrimary),
  );
  const formality = modeEarliestTiebreak(taggedImagesInUploadOrder.map((t) => t.formality));
  const silhouette = pickByFrequencyThreshold(
    taggedImagesInUploadOrder.map((t) => t.silhouette),
    taggedImagesInUploadOrder.length,
    FREQUENCY_THRESHOLD,
  );
  const colorFamily = pickByFrequencyThreshold(
    taggedImagesInUploadOrder.map((t) => t.colorFamily),
    taggedImagesInUploadOrder.length,
    FREQUENCY_THRESHOLD,
  );

  return {
    archetypePrimary: primary,
    archetypeSecondary: secondary,
    silhouette,
    colorFamily,
    formality,
    sourceImageCount: taggedImagesInUploadOrder.length,
  };
}
