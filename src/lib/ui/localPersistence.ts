// Client-side continuity without accounts (explicitly out of scope, and the
// user decided against OAuth since it doesn't strengthen the core idea).
// StyleDNA moved from sessionStorage to localStorage here deliberately --
// sessionStorage dies when the tab closes, which defeats "feels continuous
// when you come back." Saved recommendations store a full snapshot (not
// just a productId) so a saved item still displays correctly even if it
// later drops out of a re-ranked live feed.
//
// All reads/writes are guarded: Safari private browsing (and storage-full
// conditions) can throw synchronously on setItem even though getItem works,
// so an unguarded call here would crash whatever click handler triggered
// it. Writes return a boolean so callers can tell the user rather than
// silently no-op.

export type StyleDNA = {
  archetypePrimary: string;
  archetypeSecondary: string | null;
  silhouette: string[];
  colorFamily: string[];
  formality: string;
  sourceImageCount?: number;
};

export type SavedRecommendation = {
  productId: string;
  title: string;
  store: string;
  productUrl: string;
  imageUrl: string;
  priceMin: number | null;
  rationale: string | null;
  savedAt: string;
};

const STYLE_DNA_KEY = "aesthetic-match:styleDNA";
const SAVED_KEY = "aesthetic-match:savedRecommendations";

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): boolean {
  if (typeof window === "undefined") return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to do -- if remove fails, storage was already unusable.
  }
}

export function getStyleDNA(): StyleDNA | null {
  return readJSON<StyleDNA | null>(STYLE_DNA_KEY, null);
}

/** Returns false if the browser blocked the write (private mode, quota) --
 * callers should tell the user rather than assume it silently worked. */
export function setStyleDNA(dna: StyleDNA): boolean {
  return writeJSON(STYLE_DNA_KEY, dna);
}

export function clearStyleDNA(): void {
  removeKey(STYLE_DNA_KEY);
}

export function getSavedRecommendations(): SavedRecommendation[] {
  return readJSON<SavedRecommendation[]>(SAVED_KEY, []);
}

export function isRecommendationSaved(productId: string): boolean {
  return getSavedRecommendations().some((r) => r.productId === productId);
}

/** Returns false if the browser blocked the write. */
export function saveRecommendation(item: Omit<SavedRecommendation, "savedAt">): boolean {
  const current = getSavedRecommendations();
  if (current.some((r) => r.productId === item.productId)) return true;
  return writeJSON(SAVED_KEY, [...current, { ...item, savedAt: new Date().toISOString() }]);
}

export function unsaveRecommendation(productId: string): void {
  const updated = getSavedRecommendations().filter((r) => r.productId !== productId);
  writeJSON(SAVED_KEY, updated);
}
