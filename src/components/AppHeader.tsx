"use client";

import { useEffect, useState } from "react";
import { getSavedRecommendations } from "@/lib/ui/localPersistence";

export function AppHeader({ showEditPhotos = false }: { showEditPhotos?: boolean }) {
  const [savedCount, setSavedCount] = useState(0);

  useEffect(() => {
    setSavedCount(getSavedRecommendations().length);
  }, []);

  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 pb-2 pt-6">
      <a
        href="/"
        className="text-xs font-medium uppercase tracking-[0.2em] text-stone-500 transition-colors hover:text-stone-600"
      >
        Aesthetic Match
      </a>
      <nav className="flex items-center gap-5 text-xs text-stone-500">
        {showEditPhotos && (
          <a href="/profile" className="transition-colors hover:text-stone-900">
            Edit Photos
          </a>
        )}
        <a href="/saved" className="transition-colors hover:text-stone-900">
          Saved{savedCount > 0 ? ` (${savedCount})` : ""}
        </a>
      </nav>
    </header>
  );
}
