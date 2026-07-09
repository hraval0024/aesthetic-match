// Structurally-typed rather than importing StyleDNA directly: this also runs
// client-side against a plain JSON.parse()'d response, which only has string
// fields, not the branded Archetype/Silhouette/etc. union types.
type StyleDNALike = {
  archetypePrimary: string;
  archetypeSecondary: string | null;
  silhouette: string[];
  colorFamily: string[];
  formality: string;
};

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function joinWithAnd(values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

/**
 * Deterministic, template-built one-line description of a Style DNA profile.
 * Not Claude-generated -- this is a display nicety derived entirely from
 * already-computed fields, so it doesn't belong on the Claude-call critical
 * path (that's reserved for per-item rationale generation later).
 */
export function summarizeStyleDNA(dna: StyleDNALike): string {
  const primary = humanize(dna.archetypePrimary);
  const secondaryPart = dna.archetypeSecondary
    ? ` with a touch of ${humanize(dna.archetypeSecondary)}`
    : "";

  const silhouettePart = dna.silhouette.length
    ? `${joinWithAnd(dna.silhouette.map(humanize))} silhouettes`
    : "a mix of silhouettes";

  const colorPart = dna.colorFamily.length
    ? ` in ${joinWithAnd(dna.colorFamily.map(humanize))} tones`
    : "";

  const formality = humanize(dna.formality);

  return `A ${primary} aesthetic${secondaryPart}, built on ${silhouettePart}${colorPart} — worn ${formality}.`;
}
