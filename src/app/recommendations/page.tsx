"use client";

import { useEffect, useState, useCallback } from "react";
import { COLOR_SWATCHES } from "@/lib/ui/colorSwatches";
import {
  getStyleDNA,
  clearStyleDNA,
  saveRecommendation,
  unsaveRecommendation,
  getSavedRecommendations,
  type StyleDNA,
} from "@/lib/ui/localPersistence";
import { AppHeader } from "@/components/AppHeader";

type Recommendation = {
  productId: string;
  title: string;
  store: string;
  productUrl: string;
  imageUrl: string;
  priceMin: number | null;
  score: number;
  tags: {
    archetypePrimary: string;
    archetypeSecondary: string | null;
    silhouette: string[];
    colorFamily: string[];
    formality: string;
  };
  rationale: string | null;
};

type RecommendationsResponse = {
  recommendations: Recommendation[];
  meta: {
    returned: number;
    totalCatalogSize: number;
    totalArchetypeRelevant: number;
    degraded: boolean;
    latencyMs: number;
  };
};

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
  return (
    <article className="flex flex-col">
      <div className="relative aspect-[4/5] overflow-hidden rounded-lg bg-stone-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.imageUrl} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
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
        <p className="text-[11px] uppercase tracking-wide text-stone-400">{item.store}</p>
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

export default function RecommendationsPage() {
  const [styleDNA, setLocalStyleDNA] = useState<StyleDNA | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missingProfile, setMissingProfile] = useState(false);
  const [data, setData] = useState<RecommendationsResponse | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [staleProfile, setStaleProfile] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchRecommendations = useCallback(async (profile: StyleDNA) => {
    setLoading(true);
    setError(null);
    setStaleProfile(false);
    try {
      const res = await fetch("/api/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ styleDNA: profile }),
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
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSavedIds(new Set(getSavedRecommendations().map((r) => r.productId)));
    const dna = getStyleDNA();
    if (!dna) {
      setMissingProfile(true);
      setLoading(false);
      return;
    }
    setLocalStyleDNA(dna);
    fetchRecommendations(dna);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <AppHeader showEditPhotos />
      <div className="mx-auto w-full max-w-6xl px-6 pt-4">
        <div className="border-b border-stone-200 pb-8 text-center">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-stone-400">Curated for you</p>
          {styleDNA && (
            <h1 className="mt-3 text-2xl font-medium capitalize tracking-tight sm:text-3xl">
              {styleDNA.archetypePrimary.replace(/_/g, " ")}
              {styleDNA.archetypeSecondary && (
                <span className="text-stone-400"> + {styleDNA.archetypeSecondary.replace(/_/g, " ")}</span>
              )}
            </h1>
          )}
          {styleDNA && styleDNA.colorFamily.length > 0 && (
            <div className="mt-3 flex items-center justify-center gap-1.5">
              {styleDNA.colorFamily.map((c) => (
                <span
                  key={c}
                  className="h-2.5 w-2.5 rounded-full border border-black/10"
                  style={{ backgroundColor: COLOR_SWATCHES[c] ?? "#ccc" }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="pt-10">
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
                  onClick={() => styleDNA && fetchRecommendations(styleDNA)}
                  className="mt-3 inline-flex items-center justify-center rounded-full border border-red-300 px-5 py-2 text-xs font-medium text-red-800 transition-colors hover:bg-red-100"
                >
                  Try again
                </button>
              )}
            </div>
          )}

          {!loading && !error && data && data.recommendations.length === 0 && (
            <div className="mx-auto max-w-md text-center">
              <p className="text-sm text-stone-500">
                We couldn&rsquo;t find matches for this style in the current catalog yet.
              </p>
              <a
                href="/profile"
                className="mt-4 inline-flex items-center justify-center rounded-full bg-stone-900 px-7 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700"
              >
                Try different photos
              </a>
            </div>
          )}

          {!loading && !error && data && data.recommendations.length > 0 && (
            <>
              {saveError && (
                <p className="mb-4 text-center text-xs text-red-700">{saveError}</p>
              )}
              {data.meta.degraded && (
                <p className="mb-6 text-center text-sm text-stone-500">
                  We found {data.meta.returned} strong matches for your aesthetic — fewer than usual, since
                  this style has less inventory across our current brands right now.
                </p>
              )}
              <div className="grid grid-cols-2 gap-x-5 gap-y-9 sm:grid-cols-3 lg:grid-cols-4">
                {data.recommendations.map((item) => (
                  <RecommendationCard
                    key={item.productId}
                    item={item}
                    saved={savedIds.has(item.productId)}
                    onToggleSave={() => handleToggleSave(item)}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <p className="mt-16 text-center text-xs text-stone-400">
          Most brands here sync automatically to your Shop App — a few may require a manual visit to check
          out.
        </p>
      </div>
    </main>
  );
}
