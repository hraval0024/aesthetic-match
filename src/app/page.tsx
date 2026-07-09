const steps = [
  {
    number: "01",
    title: "Bring your looks",
    description: "Upload 5–10 screenshots of outfits you love.",
  },
  {
    number: "02",
    title: "We build your StyleDNA",
    description: "Archetype, silhouette, formality, and color palette — extracted by AI, not guessed.",
  },
  {
    number: "03",
    title: "Shop real matches",
    description: "Ranked recommendations pulled from real brand catalogs, each linking to the actual product page.",
  },
];

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white px-6 py-20 text-stone-900">
      <div className="w-full max-w-2xl">
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-stone-400">
            Aesthetic Match
          </p>
          <h1 className="mt-4 text-4xl font-medium tracking-tight text-stone-900 sm:text-5xl">
            Your aesthetic, always in stock.
          </h1>
          <p className="mx-auto mt-5 max-w-md text-[15px] leading-relaxed text-stone-500">
            Show us a few looks you love. We turn them into a persistent style
            profile and match it against real inventory from independent
            fashion brands — not a one-time &ldquo;similar items&rdquo; scan.
          </p>
        </div>

        <div className="mt-16 grid grid-cols-1 gap-8 border-t border-stone-200 pt-10 sm:grid-cols-3 sm:gap-6">
          {steps.map((step) => (
            <div key={step.number}>
              <div className="text-xs font-medium tracking-wide text-stone-300">{step.number}</div>
              <div className="mt-2 text-[15px] font-medium text-stone-900">{step.title}</div>
              <div className="mt-1 text-sm leading-relaxed text-stone-500">{step.description}</div>
            </div>
          ))}
        </div>

        <div className="mt-16 flex flex-col items-center gap-4">
          <a
            href="/profile"
            className="inline-flex items-center justify-center rounded-full bg-stone-900 px-8 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
          >
            Build My StyleDNA
          </a>
          <p className="text-xs text-stone-400">
            Most brands here sync automatically to your Shop App — a few may
            require a manual visit to check out.
          </p>
        </div>
      </div>
    </main>
  );
}
