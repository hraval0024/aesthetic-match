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

// Classified from the optional free-text "what are you shopping for?" field
// on the profile page (see classifyIntent.ts) -- persisted alongside the
// StyleDNA so the recommendations page can pre-seed its occasion/climate
// filters on first load, without the user ever re-typing or re-selecting
// anything from a taxonomy picker.
export type ShoppingIntent = { occasion: string[]; climate: string | null };

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
const SHOPPING_INTENT_KEY = "aesthetic-match:shoppingIntent";

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

export function getShoppingIntent(): ShoppingIntent | null {
  return readJSON<ShoppingIntent | null>(SHOPPING_INTENT_KEY, null);
}

/** Always call this on profile creation, even with an empty intent -- if
 * the user doesn't type anything this time, any stale intent from a
 * previous profile should clear too, not silently linger. */
export function setShoppingIntent(intent: ShoppingIntent): boolean {
  return writeJSON(SHOPPING_INTENT_KEY, intent);
}

export function clearShoppingIntent(): void {
  removeKey(SHOPPING_INTENT_KEY);
}

const SHOPPING_INTENT_TEXT_KEY = "aesthetic-match:shoppingIntentText";

// The raw phrase the user typed ("summer trip to Italy"), separate from
// its classified {occasion, climate} result -- needed anywhere the app
// shows the user their own words back (the profile page's edit flow, the
// "Showing results for..." line, the landing page's "last time you
// shopped for" recall). Showing the classified taxonomy values back to
// the user would violate the "user never sees the taxonomy" principle
// this feature was built around.
export function getShoppingIntentText(): string {
  return readJSON<string>(SHOPPING_INTENT_TEXT_KEY, "");
}

export function setShoppingIntentText(text: string): boolean {
  return writeJSON(SHOPPING_INTENT_TEXT_KEY, text);
}

export function clearShoppingIntentText(): void {
  removeKey(SHOPPING_INTENT_TEXT_KEY);
}

const PROFILE_NOTICE_KEY = "aesthetic-match:profileNotice";

/** One-shot notice set right before navigating from /profile to
 * /recommendations (e.g. "3 of your photos couldn't be used") -- since
 * building a StyleDNA no longer has its own review screen, this is how
 * that transparency survives the jump instead of silently disappearing. */
export function setProfileNotice(text: string): boolean {
  return writeJSON(PROFILE_NOTICE_KEY, text);
}

/** Reads and clears in one step, so the notice shows exactly once on
 * landing, not on every subsequent visit to /recommendations. */
export function consumeProfileNotice(): string | null {
  const notice = readJSON<string | null>(PROFILE_NOTICE_KEY, null);
  if (notice) removeKey(PROFILE_NOTICE_KEY);
  return notice;
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
