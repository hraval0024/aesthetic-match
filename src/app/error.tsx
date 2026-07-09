"use client";

import { useEffect } from "react";

// Root error boundary (Next.js App Router convention) -- catches any
// uncaught render exception on any page (e.g. a corrupted localStorage
// StyleDNA reaching a .replace() on undefined) so a bug shows a recoverable
// screen instead of a blank white page.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({ event: "unhandled_render_error", message: error.message, digest: error.digest }),
    );
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white px-6 text-center text-stone-900">
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-stone-400">Something went wrong</p>
      <h1 className="mt-3 text-2xl font-medium tracking-tight">We hit a snag loading this page.</h1>
      <p className="mx-auto mt-3 max-w-sm text-[15px] text-stone-500">
        Your saved photos and style profile are safe — this was just a display error.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center justify-center rounded-full bg-stone-900 px-7 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700"
        >
          Try again
        </button>
        <a
          href="/"
          className="inline-flex items-center justify-center rounded-full border border-stone-300 px-7 py-2.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100"
        >
          Back to home
        </a>
      </div>
    </main>
  );
}
