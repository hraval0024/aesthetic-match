"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { summarizeStyleDNA } from "@/lib/profile/summarize";
import {
  getStyleDNA,
  getShoppingIntentText,
  setShoppingIntent,
  setShoppingIntentText,
  clearShoppingIntent,
  clearShoppingIntentText,
  type StyleDNA,
} from "@/lib/ui/localPersistence";

// Small client island so the rest of the landing page can stay static --
// only this part needs to check localStorage for a returning user.
export function LandingCTA() {
  const router = useRouter();
  const [returning, setReturning] = useState<boolean | null>(null);
  const [styleDNA, setLocalStyleDNA] = useState<StyleDNA | null>(null);
  const [lastIntentText, setLastIntentText] = useState("");
  const [intentInput, setIntentInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dna = getStyleDNA();
    setLocalStyleDNA(dna);
    setReturning(dna !== null);
    setLastIntentText(getShoppingIntentText());
  }, []);

  async function handleSeeRecommendations() {
    setError(null);
    const text = intentInput.trim();

    // Explicit behavior: leaving this blank means "just my StyleDNA,
    // nothing else" -- it must NOT silently carry over whatever occasion
    // was classified last visit. Without this, a stale intent from days
    // ago would keep filtering results the user never asked for today.
    if (!text) {
      clearShoppingIntent();
      clearShoppingIntentText();
      router.push("/recommendations");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/classify-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Something went wrong.");
      setShoppingIntent({ occasion: json.occasion ?? [], climate: json.climate ?? null });
      setShoppingIntentText(text);
      router.push("/recommendations");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — check your connection and try again.");
      setSubmitting(false);
    }
  }

  // Avoid a flash of the wrong CTA before the localStorage check resolves.
  if (returning === null) {
    return <div className="h-[46px]" />;
  }

  if (returning && styleDNA) {
    return (
      <div className="flex flex-col items-center gap-5">
        <div className="text-center">
          <p className="text-sm text-stone-500">Welcome back. Your StyleDNA:</p>
          <p className="mt-2 text-lg font-medium capitalize tracking-tight text-stone-900">
            {styleDNA.archetypePrimary.replace(/_/g, " ")}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-stone-500">
            {summarizeStyleDNA(styleDNA)}
          </p>
        </div>

        <div className="w-full max-w-sm">
          {lastIntentText && (
            <p className="mb-1.5 text-xs text-stone-500">
              Last time you shopped for &ldquo;{lastIntentText}&rdquo;
            </p>
          )}
          <label htmlFor="landing-intent" className="block text-sm font-medium text-stone-900">
            What are you shopping for today? <span className="font-normal text-stone-500">(optional)</span>
          </label>
          <textarea
            id="landing-intent"
            value={intentInput}
            onChange={(e) => setIntentInput(e.target.value)}
            disabled={submitting}
            rows={2}
            maxLength={200}
            placeholder={"date night this weekend\nweekend brunch"}
            className="mt-2 w-full resize-none rounded-xl border border-stone-300 px-4 py-3 text-sm text-stone-900 placeholder:text-stone-400 transition-colors focus:border-stone-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:bg-stone-50 disabled:text-stone-400"
          />
          {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={handleSeeRecommendations}
            disabled={submitting}
            className="inline-flex items-center justify-center rounded-full bg-stone-900 px-8 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
          >
            {submitting ? "Curating…" : "View My Matches"}
          </button>
          <a
            href="/profile"
            className="inline-flex items-center justify-center rounded-full border border-stone-300 px-8 py-3 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100"
          >
            Build a New StyleDNA
          </a>
        </div>
        <p className="text-xs text-stone-500">
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
      <p className="text-xs text-stone-500">
        Most brands here sync automatically to your Shop App — a few may require a manual visit to check
        out.
      </p>
    </div>
  );
}
