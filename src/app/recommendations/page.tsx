"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OCCASIONS, CATEGORIES } from "@/lib/claude/taxonomy";
import { summarizeStyleDNA } from "@/lib/profile/summarize";
import {
  getStyleDNA,
  clearStyleDNA,
  saveRecommendation,
  unsaveRecommendation,
  getSavedRecommendations,
  getShoppingIntent,
  getShoppingIntentText,
  consumeProfileNotice,
  type StyleDNA,
} from "@/lib/ui/localPersistence";
import { AppHeader } from "@/components/AppHeader";

type MatchTier = "exact" | "fallback";
type SortMode = "best_match" | "newest" | "price_asc" | "price_desc";

type Recommendation = {
  productId: string;
  title: string;
  store: string;
  productUrl: string;
  imageUrl: string;
  priceMin: number | null;
  publishedAt: string | null;
  score: number;
  matchTier: MatchTier;
  tags: {
    archetypePrimary: string;
    archetypeSecondary: string | null;
    silhouette: string[];
    colorFamily: string[];
    formality: string;
  };
  rationale: string | null;
};

type Meta = {
  returned: number;
  totalCatalogSize: number;
  totalEligible: number;
  totalAvailable: number;
  offset: number;
  hasMore: boolean;
  exactCount: number;
  fallbackCount: number;
  degraded: boolean;
  latencyMs: number;
};

type RecommendationsResponse = {
  recommendations: Recommendation[];
  meta: Meta;
};

type Intent = {
  occasion: string[];
  climate: string | null;
  categories: string[];
  priceMin: number | null;
  priceMax: number | null;
};

const EMPTY_INTENT: Intent = { occasion: [], climate: null, categories: [], priceMin: null, priceMax: null };
// Matches the server's PAGE_SIZE -- purely for the "Show N more" label's
// max increment; the server is the actual source of truth for page size.
const PAGE_SIZE = 25;

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "best_match", label: "Best match" },
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
];

function humanize(v: string) {
  return v.replace(/_/g, " ");
}

function hasActiveFilters(intent: Intent): boolean {
  return (
    intent.occasion.length > 0 ||
    !!intent.climate ||
    intent.categories.length > 0 ||
    intent.priceMin != null ||
    intent.priceMax != null
  );
}

// Mirrors the server's sort tiebreak chain (relevance, then productId) so
// re-sorting client-side matches exactly what a fresh server-sorted
// response would show. Sort never changes WHICH items are selected --
// that's decided by occasion/climate/category/price, which do need a
// refetch -- only their display order, so reordering the already-fetched
// items locally is both correct and avoids a pointless round trip *for an
// explicit sort override*.
//
// best_match is deliberately NOT re-sorted here, mirroring the server's
// applySort: the server builds each page in composition-balanced blocks
// (see rank.ts), and a flat re-sort by raw score would undo that the
// moment a low-scoring-but-bucket-reserved item (e.g. a shoe pulled in to
// satisfy the shoes-category floor) gets outranked by everything else and
// dragged to the bottom -- which is exactly the "items move after Show
// more" bug this fixes. Leaving best_match items in server-received order
// means page 1 never moves once rendered -- "Show more" only ever appends.
function clientSort(items: Recommendation[], sort: SortMode): Recommendation[] {
  if (sort === "best_match") return items;

  const key = (item: Recommendation): [number, number, string] => {
    const relevance = -item.score;
    switch (sort) {
      case "newest":
        return [-(item.publishedAt ? new Date(item.publishedAt).getTime() : 0), relevance, item.productId];
      case "price_asc":
        return [item.priceMin ?? Infinity, relevance, item.productId];
      case "price_desc":
        return [-(item.priceMin ?? -Infinity), relevance, item.productId];
      default:
        return [relevance, 0, item.productId];
    }
  };
  const sortGroup = (group: Recommendation[]) =>
    [...group].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    });
  // exact tier always first -- re-sorting never hides that some results
  // are fallback matches (frozen transparency requirement).
  return [...sortGroup(items.filter((i) => i.matchTier === "exact")), ...sortGroup(items.filter((i) => i.matchTier === "fallback"))];
}

function SkeletonCard() {
  return (
    <div className="motion-safe:animate-pulse">
      <div className="aspect-[4/5] rounded-lg bg-stone-100" />
      <div className="mt-3 h-2.5 w-1/3 rounded bg-stone-100" />
      <div className="mt-2 h-3 w-4/5 rounded bg-stone-100" />
      <div className="mt-2 h-3 w-2/3 rounded bg-stone-100" />
    </div>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6">
      <path
        d="M12 21s-7.5-4.6-10-9.3C0.4 8.4 2 4.5 5.7 4c2-.3 3.7.7 4.8 2.2C11.6 7.7 12 8.2 12 8.2s.4-.5 1.5-2C14.6 4.7 16.3 3.7 18.3 4c3.7.5 5.3 4.4 3.7 7.7C19.5 16.4 12 21 12 21z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RecommendationCard({
  item,
  saved,
  onToggleSave,
}: {
  item: Recommendation;
  saved: boolean;
  onToggleSave: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <article className="flex flex-col">
      <div className="relative aspect-[4/5] overflow-hidden rounded-lg bg-stone-100">
        {imageFailed ? (
          <div className="flex h-full w-full items-center justify-center px-4 text-center text-xs text-stone-500">
            Image unavailable
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
            alt={item.title}
            className="h-full w-full object-cover"
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        )}
        <button
          type="button"
          onClick={onToggleSave}
          aria-pressed={saved}
          aria-label={saved ? "Remove from saved" : "Save this item"}
          className={`absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full shadow-sm transition-colors ${
            saved ? "bg-stone-900 text-white" : "bg-white/90 text-stone-500 hover:text-stone-900"
          }`}
        >
          <HeartIcon filled={saved} />
        </button>
      </div>
      <div className="flex flex-1 flex-col pt-3">
        <p className="text-[11px] uppercase tracking-wide text-stone-500">{item.store}</p>
        <h3 className="mt-0.5 line-clamp-2 text-sm font-medium leading-snug text-stone-900">{item.title}</h3>
        {item.priceMin != null && <p className="mt-1 text-sm text-stone-600">${item.priceMin.toFixed(0)}</p>}
        {item.rationale && (
          <p className="mt-2 border-t border-stone-100 pt-2 text-[13px] leading-relaxed text-stone-500">
            {item.rationale}
          </p>
        )}
        <a
          href={item.productUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-auto inline-flex w-fit items-center gap-1 pt-3 text-xs font-medium text-stone-900 underline decoration-stone-300 underline-offset-4 transition-colors hover:decoration-stone-900"
        >
          Shop on {item.store} ↗
        </a>
      </div>
    </article>
  );
}

// Compact by design: a single trigger (labeled with the count once
// something's selected) opening a checklist popover, rather than 11
// always-visible chips like occasion has -- occasion is the headline
// "what's this search for" control, category is a secondary refinement
// and doesn't need the same visual weight.
function CategoryFilter({ selected, onChange }: { selected: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function toggle(category: string) {
    onChange(selected.includes(category) ? selected.filter((c) => c !== category) : [...selected, category]);
  }

  const triggerLabel =
    selected.length === 0 ? "All" : selected.length === 1 ? humanize(selected[0]) : `${selected.length} selected`;

  return (
    <div ref={containerRef} className="relative flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-stone-500">
      Category
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="rounded-full border border-stone-300 px-3 py-1.5 text-left text-sm capitalize text-stone-700 transition-colors hover:border-stone-400"
      >
        {triggerLabel}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 w-52 rounded-lg border border-stone-200 bg-white p-3 shadow-lg">
          <div className="max-h-56 space-y-2 overflow-y-auto">
            {CATEGORIES.filter((c) => c !== "beauty_home").map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-2 text-sm normal-case capitalize text-stone-700">
                <input
                  type="checkbox"
                  checked={selected.includes(c)}
                  onChange={() => toggle(c)}
                  className="h-3.5 w-3.5 rounded border-stone-300"
                />
                {humanize(c)}
              </label>
            ))}
          </div>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-3 text-xs normal-case text-stone-500 underline decoration-stone-300 underline-offset-4 transition-colors hover:text-stone-600"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FilterBar({
  intent,
  onChange,
  sort,
  onSortChange,
}: {
  intent: Intent;
  onChange: (next: Intent) => void;
  sort: SortMode;
  onSortChange: (sort: SortMode) => void;
}) {
  const [priceMinInput, setPriceMinInput] = useState(intent.priceMin?.toString() ?? "");
  const [priceMaxInput, setPriceMaxInput] = useState(intent.priceMax?.toString() ?? "");

  function toggleOccasion(occasion: string) {
    const active = intent.occasion.includes(occasion);
    onChange({
      ...intent,
      occasion: active ? intent.occasion.filter((o) => o !== occasion) : [...intent.occasion, occasion],
    });
  }

  function commitPriceRange() {
    const min = priceMinInput.trim() === "" ? null : Number(priceMinInput);
    const max = priceMaxInput.trim() === "" ? null : Number(priceMaxInput);
    onChange({
      ...intent,
      priceMin: min != null && Number.isFinite(min) ? min : null,
      priceMax: max != null && Number.isFinite(max) ? max : null,
    });
  }

  return (
    <div className="mb-8 space-y-4 border-b border-stone-200 pb-8">
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">Occasion</p>
        <div className="flex flex-wrap items-center gap-2">
          {OCCASIONS.map((occasion) => {
            const active = intent.occasion.includes(occasion);
            return (
              <button
                key={occasion}
                type="button"
                onClick={() => toggleOccasion(occasion)}
                aria-pressed={active}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  active
                    ? "border-stone-900 bg-stone-900 text-white"
                    : "border-stone-300 text-stone-600 hover:border-stone-400"
                }`}
              >
                {humanize(occasion)}
              </button>
            );
          })}
          {/* Climate has no picker anymore -- it's only ever inferred from
              free-text shopping intent -- but stays visible and removable
              as a small pill here when one's active, so it's never an
              invisible filter the user can't see or clear on its own. */}
          {intent.climate && (
            <button
              type="button"
              onClick={() => onChange({ ...intent, climate: null })}
              className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 bg-stone-50 px-3 py-1.5 text-xs font-medium capitalize text-stone-600 transition-colors hover:border-stone-400"
            >
              Climate: {humanize(intent.climate)}
              <span aria-hidden>×</span>
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <CategoryFilter selected={intent.categories} onChange={(categories) => onChange({ ...intent, categories })} />

        <div className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-stone-500">
          Price
          <div className="flex items-center gap-2">
            <input
              type="number"
              inputMode="numeric"
              placeholder="Min"
              value={priceMinInput}
              onChange={(e) => setPriceMinInput(e.target.value)}
              onBlur={commitPriceRange}
              onKeyDown={(e) => e.key === "Enter" && commitPriceRange()}
              className="w-20 rounded-full border border-stone-300 px-3 py-1.5 text-sm text-stone-700"
            />
            <span className="text-stone-500">–</span>
            <input
              type="number"
              inputMode="numeric"
              placeholder="Max"
              value={priceMaxInput}
              onChange={(e) => setPriceMaxInput(e.target.value)}
              onBlur={commitPriceRange}
              onKeyDown={(e) => e.key === "Enter" && commitPriceRange()}
              className="w-20 rounded-full border border-stone-300 px-3 py-1.5 text-sm text-stone-700"
            />
          </div>
        </div>

        <label className="ml-auto flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-stone-500">
          Sort
          <select
            value={sort}
            onChange={(e) => onSortChange(e.target.value as SortMode)}
            className="rounded-full border border-stone-300 px-3 py-1.5 text-sm text-stone-700"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {hasActiveFilters(intent) && (
          <button
            type="button"
            onClick={() => {
              setPriceMinInput("");
              setPriceMaxInput("");
              onChange(EMPTY_INTENT);
            }}
            className="text-xs text-stone-500 underline decoration-stone-300 underline-offset-4 transition-colors hover:text-stone-600"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

export default function RecommendationsPage() {
  const [styleDNA, setLocalStyleDNA] = useState<StyleDNA | null>(null);
  const [intentText, setIntentText] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [missingProfile, setMissingProfile] = useState(false);
  const [items, setItems] = useState<Recommendation[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [staleProfile, setStaleProfile] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [intent, setIntent] = useState<Intent>(EMPTY_INTENT);
  const [sort, setSort] = useState<SortMode>("best_match");
  const [profileNotice, setProfileNoticeState] = useState<string | null>(null);

  // append=false is a fresh query (new filters, initial load, retry) and
  // replaces the accumulated list; append=true is "Show N more" and grows
  // it. Errors route separately too -- a failed "Show more" shouldn't wipe
  // the grid the user is already looking at, just show a small inline
  // retry near the button.
  const fetchRecommendations = useCallback(
    async (profile: StyleDNA, currentIntent: Intent, offset: number, append: boolean) => {
      if (append) {
        setLoadingMore(true);
        setLoadMoreError(null);
      } else {
        setLoading(true);
        setError(null);
        setStaleProfile(false);
      }
      try {
        const res = await fetch("/api/recommendations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            styleDNA: profile,
            intent: { ...currentIntent, categories: currentIntent.categories },
            offset,
          }),
        });
        const json = await res.json();
        // 422 means the server rejected the StyleDNA itself (e.g. an
        // archetype value that no longer exists in the taxonomy) -- distinct
        // from a transient fetch failure, "Try again" would just repeat the
        // same broken request, so this needs its own recovery path.
        if (res.status === 422) {
          setStaleProfile(true);
          setError(json.error ?? "Your saved style profile looks out of date.");
          return;
        }
        if (!res.ok) throw new Error(json.error ?? "Something went wrong.");
        setItems((prev) => (append ? [...prev, ...json.recommendations] : json.recommendations));
        setMeta(json.meta);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Network error — check your connection and try again.";
        if (append) setLoadMoreError(message);
        else setError(message);
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [],
  );

  // Guards against React Strict Mode's dev-only double-invoke of mount
  // effects -- without this, the initial fetch fired twice on every page
  // load (confirmed for real: two POST /api/recommendations at the same
  // offset:0, ~3.8s and ~6.3s, racing each other), silently doubling the
  // Claude rationale-generation cost on every single page load. Strict
  // Mode only double-invokes effects, not event handlers, so "Show more"
  // (a real onClick) was never affected -- only this mount fetch was.
  const hasFetchedRef = useRef(false);
  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;

    setSavedIds(new Set(getSavedRecommendations().map((r) => r.productId)));
    setProfileNoticeState(consumeProfileNotice());
    setIntentText(getShoppingIntentText());
    const dna = getStyleDNA();
    if (!dna) {
      setMissingProfile(true);
      setLoading(false);
      return;
    }
    setLocalStyleDNA(dna);

    // Pre-seed the occasion/climate filters from whatever the profile page
    // classified out of the user's free-text shopping intent -- lands them
    // straight on an already-filtered feed instead of an empty StyleDNA-only
    // browse they'd have to manually refine. Shown back as the same chip
    // toggles the manual filter bar uses, so it stays visible and
    // adjustable, not a hidden magic filter.
    const shoppingIntent = getShoppingIntent();
    const seededIntent: Intent =
      shoppingIntent && (shoppingIntent.occasion.length > 0 || shoppingIntent.climate)
        ? { ...EMPTY_INTENT, occasion: shoppingIntent.occasion, climate: shoppingIntent.climate }
        : EMPTY_INTENT;
    setIntent(seededIntent);
    fetchRecommendations(dna, seededIntent, 0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleIntentChange(next: Intent) {
    setIntent(next);
    // Fresh filters mean a fresh query -- always page 1, never appended.
    if (styleDNA) fetchRecommendations(styleDNA, next, 0, false);
  }

  function handleLoadMore() {
    if (!styleDNA) return;
    fetchRecommendations(styleDNA, intent, items.length, true);
  }

  function handleToggleSave(item: Recommendation) {
    setSaveError(null);
    if (savedIds.has(item.productId)) {
      unsaveRecommendation(item.productId);
      setSavedIds((prev) => {
        const next = new Set(prev);
        next.delete(item.productId);
        return next;
      });
    } else {
      const saved = saveRecommendation({
        productId: item.productId,
        title: item.title,
        store: item.store,
        productUrl: item.productUrl,
        imageUrl: item.imageUrl,
        priceMin: item.priceMin,
        rationale: item.rationale,
      });
      if (!saved) {
        setSaveError("Couldn't save this item — your browser may be blocking local storage.");
        return;
      }
      setSavedIds((prev) => new Set(prev).add(item.productId));
    }
  }

  const displayed = useMemo(() => clientSort(items, sort), [items, sort]);
  const showFallbackTransparency = hasActiveFilters(intent) && (intent.occasion.length > 0 || !!intent.climate);

  if (missingProfile) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-white px-6 text-center text-stone-900">
        <p className="text-sm text-stone-500">Build your StyleDNA first to see recommendations.</p>
        <a
          href="/profile"
          className="mt-5 inline-flex items-center justify-center rounded-full bg-stone-900 px-7 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700"
        >
          Build My StyleDNA
        </a>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white pb-16 text-stone-900">
      <AppHeader />
      <div className="mx-auto w-full max-w-6xl px-6 pt-4">
        <div className="border-b border-stone-200 pb-8 text-center">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-stone-500">Your StyleDNA</p>
          {styleDNA && (
            <>
              <h1 className="mt-3 text-2xl font-medium capitalize tracking-tight sm:text-3xl">
                {styleDNA.archetypePrimary.replace(/_/g, " ")}
              </h1>
              <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-stone-600">
                {summarizeStyleDNA(styleDNA)}
              </p>
              {intentText && showFallbackTransparency && (
                <p className="mx-auto mt-4 max-w-md text-sm text-stone-500">
                  Showing results for &ldquo;{intentText}&rdquo;
                </p>
              )}
              <a
                href="/profile"
                className="mt-5 inline-flex items-center justify-center rounded-full border border-stone-300 px-5 py-2 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100"
              >
                Edit photos or intent
              </a>
            </>
          )}
          {profileNotice && (
            <p className="mx-auto mt-4 max-w-md text-xs text-stone-500">{profileNotice}</p>
          )}
        </div>

        <div className="pt-10">
          <FilterBar intent={intent} onChange={handleIntentChange} sort={sort} onSortChange={setSort} />

          {loading && (
            <>
              <p className="mb-6 text-center text-sm text-stone-500">Curating your matches…</p>
              <div className="grid grid-cols-2 gap-x-5 gap-y-9 sm:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            </>
          )}

          {!loading && error && (
            <div className="mx-auto max-w-md rounded-lg border border-red-200 bg-red-50/60 p-5 text-center text-sm text-red-800">
              <p>{error}</p>
              {staleProfile ? (
                <a
                  href="/profile"
                  onClick={() => clearStyleDNA()}
                  className="mt-3 inline-flex items-center justify-center rounded-full border border-red-300 px-5 py-2 text-xs font-medium text-red-800 transition-colors hover:bg-red-100"
                >
                  Rebuild My StyleDNA
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => styleDNA && fetchRecommendations(styleDNA, intent, 0, false)}
                  className="mt-3 inline-flex items-center justify-center rounded-full border border-red-300 px-5 py-2 text-xs font-medium text-red-800 transition-colors hover:bg-red-100"
                >
                  Try again
                </button>
              )}
            </div>
          )}

          {!loading && !error && meta && items.length === 0 && (
            <div className="mx-auto max-w-md text-center">
              <p className="text-sm text-stone-500">
                We couldn&rsquo;t find matches for this search in the current catalog yet.
              </p>
              {hasActiveFilters(intent) ? (
                <button
                  type="button"
                  onClick={() => handleIntentChange(EMPTY_INTENT)}
                  className="mt-4 inline-flex items-center justify-center rounded-full bg-stone-900 px-7 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700"
                >
                  Clear filters
                </button>
              ) : (
                <a
                  href="/profile"
                  className="mt-4 inline-flex items-center justify-center rounded-full bg-stone-900 px-7 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700"
                >
                  Try different photos
                </a>
              )}
            </div>
          )}

          {!loading && !error && meta && items.length > 0 && (
            <>
              {saveError && <p className="mb-4 text-center text-xs text-red-700">{saveError}</p>}
              {meta.degraded && !showFallbackTransparency && (
                <p className="mb-6 text-center text-sm text-stone-500">
                  We found {items.length} strong matches for your aesthetic — fewer than usual, since this
                  style has less inventory across our current brands right now.
                </p>
              )}
              {showFallbackTransparency && (
                <p className="mb-6 text-center text-sm text-stone-500">
                  {meta.exactCount} exact match{meta.exactCount !== 1 ? "es" : ""} for your search
                  {meta.fallbackCount > 0 && ", followed by your closest StyleDNA matches"}
                </p>
              )}
              <div className="grid grid-cols-2 gap-x-5 gap-y-9 sm:grid-cols-3 lg:grid-cols-4">
                {displayed.map((item, idx) => {
                  const isFirstFallback =
                    showFallbackTransparency &&
                    item.matchTier === "fallback" &&
                    (idx === 0 || displayed[idx - 1].matchTier === "exact");
                  return (
                    <Fragment key={item.productId}>
                      {isFirstFallback && (
                        <div className="col-span-full border-t border-stone-200 pt-6 text-center text-xs font-medium uppercase tracking-wide text-stone-500">
                          Closest StyleDNA matches
                        </div>
                      )}
                      <RecommendationCard
                        item={item}
                        saved={savedIds.has(item.productId)}
                        onToggleSave={() => handleToggleSave(item)}
                      />
                    </Fragment>
                  );
                })}
              </div>

              <div className="mt-10 flex flex-col items-center gap-3">
                <p className="text-xs text-stone-500">
                  Showing {items.length} of {meta.totalAvailable} match{meta.totalAvailable !== 1 ? "es" : ""}{" "}
                  for your style
                </p>
                {meta.hasMore && (
                  <button
                    type="button"
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                    className="inline-flex items-center justify-center rounded-full border border-stone-300 px-7 py-2.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loadingMore ? "Loading…" : `Show ${Math.min(PAGE_SIZE, meta.totalAvailable - items.length)} more`}
                  </button>
                )}
                {loadMoreError && <p className="text-xs text-red-700">{loadMoreError}</p>}
              </div>
            </>
          )}
        </div>

        <p className="mt-16 text-center text-xs text-stone-500">
          Most brands here sync automatically to your Shop App — a few may require a manual visit to check
          out.
        </p>
      </div>
    </main>
  );
}
