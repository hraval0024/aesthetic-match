const steps = [
  {
    number: "1",
    title: "Bring your looks",
    description: "Upload screenshots or paste direct image URLs of 5–10 outfits you love.",
  },
  {
    number: "2",
    title: "We build your Style DNA",
    description:
      "Archetype, silhouette, formality, and color palette — extracted by AI, not guessed.",
  },
  {
    number: "3",
    title: "Shop real matches",
    description:
      "Ranked recommendations pulled from real brand catalogs, each linking to the actual product page.",
  },
];

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-stone-50 to-stone-100 px-6 py-12 text-stone-900">
      <div className="w-full max-w-3xl space-y-10 text-center">
        <div className="space-y-4">
          <p className="text-sm font-medium uppercase tracking-widest text-stone-500">
            Aesthetic Match
          </p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Your aesthetic, always in stock.
          </h1>
          <p className="mx-auto max-w-xl text-lg text-stone-600">
            Show us a few looks you love. We turn them into a persistent style
            profile and match it against real inventory from independent
            fashion brands — not a one-time &ldquo;similar items&rdquo; scan.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 text-left sm:grid-cols-3">
          {steps.map((step) => (
            <div
              key={step.number}
              className="rounded-2xl border border-stone-200 bg-white/60 p-5"
            >
              <div className="mb-2 text-sm font-semibold text-stone-400">
                {step.number}
              </div>
              <div className="mb-1 font-medium">{step.title}</div>
              <div className="text-sm text-stone-600">{step.description}</div>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center gap-3">
          <a
            href="/profile"
            className="inline-flex items-center justify-center rounded-full bg-stone-900 px-8 py-3 text-base font-medium text-white transition-colors hover:bg-stone-700"
          >
            Build My Style DNA
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
