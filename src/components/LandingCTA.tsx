"use client";

import { useEffect, useState } from "react";
import { getStyleDNA } from "@/lib/ui/localPersistence";

// Small client island so the rest of the landing page can stay static --
// only this part needs to check localStorage for a returning user.
export function LandingCTA() {
  const [returning, setReturning] = useState<boolean | null>(null);

  useEffect(() => {
    setReturning(getStyleDNA() !== null);
  }, []);

  // Avoid a flash of the wrong CTA before the localStorage check resolves.
  if (returning === null) {
    return <div className="h-[46px]" />;
  }

  if (returning) {
    return (
      <div className="flex flex-col items-center gap-4">
        <p className="text-sm text-stone-500">Welcome back.</p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <a
            href="/recommendations"
            className="inline-flex items-center justify-center rounded-full bg-stone-900 px-8 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
          >
            View My Matches
          </a>
          <a
            href="/profile"
            className="inline-flex items-center justify-center rounded-full border border-stone-300 px-8 py-3 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100"
          >
            Build a New StyleDNA
          </a>
        </div>
        <p className="text-xs text-stone-400">
          Most brands here sync automatically to your Shop App — a few may require a manual visit to check
          out.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <a
        href="/profile"
        className="inline-flex items-center justify-center rounded-full bg-stone-900 px-8 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
      >
        Build My StyleDNA
      </a>
      <p className="text-xs text-stone-400">
        Most brands here sync automatically to your Shop App — a few may require a manual visit to check
        out.
      </p>
    </div>
  );
}
