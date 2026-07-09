"use client";

import { useEffect, useState } from "react";
import { getSavedRecommendations, unsaveRecommendation, getStyleDNA, type SavedRecommendation } from "@/lib/ui/localPersistence";
import { AppHeader } from "@/components/AppHeader";

function HeartIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.6">
      <path
        d="M12 21s-7.5-4.6-10-9.3C0.4 8.4 2 4.5 5.7 4c2-.3 3.7.7 4.8 2.2C11.6 7.7 12 8.2 12 8.2s.4-.5 1.5-2C14.6 4.7 16.3 3.7 18.3 4c3.7.5 5.3 4.4 3.7 7.7C19.5 16.4 12 21 12 21z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SavedCard({ item, onRemove }: { item: SavedRecommendation; onRemove: () => void }) {
  return (
    <article className="flex flex-col">
      <div className="relative aspect-[4/5] overflow-hidden rounded-lg bg-stone-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.imageUrl} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove from saved"
          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-stone-900 text-white shadow-sm transition-colors hover:bg-stone-700"
        >
          <HeartIcon />
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

export default function SavedPage() {
  const [items, setItems] = useState<SavedRecommendation[]>([]);
  const [hasProfile, setHasProfile] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setItems([...getSavedRecommendations()].reverse());
    setHasProfile(getStyleDNA() !== null);
    setLoaded(true);
  }, []);

  function handleRemove(productId: string) {
    unsaveRecommendation(productId);
    setItems((prev) => prev.filter((i) => i.productId !== productId));
  }

  return (
    <main className="min-h-screen bg-white pb-16 text-stone-900">
      <AppHeader showEditPhotos={hasProfile} />
      <div className="mx-auto w-full max-w-6xl px-6 pt-4">
        <div className="border-b border-stone-200 pb-8 text-center">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-stone-400">Your matches</p>
          <h1 className="mt-3 text-2xl font-medium tracking-tight sm:text-3xl">Saved</h1>
        </div>

        <div className="pt-10">
          {!loaded ? null : items.length === 0 ? (
            <div className="mx-auto max-w-md text-center">
              <p className="text-sm text-stone-500">
                Nothing saved yet — items you save from your recommendations will show up here.
              </p>
              <a
                href={hasProfile ? "/recommendations" : "/profile"}
                className="mt-4 inline-flex items-center justify-center rounded-full bg-stone-900 px-7 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700"
              >
                {hasProfile ? "View My Matches" : "Build My StyleDNA"}
              </a>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-5 gap-y-9 sm:grid-cols-3 lg:grid-cols-4">
              {items.map((item) => (
                <SavedCard key={item.productId} item={item} onRemove={() => handleRemove(item.productId)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
