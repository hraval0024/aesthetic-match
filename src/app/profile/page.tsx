"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { summarizeStyleDNA } from "@/lib/profile/summarize";
import { COLOR_SWATCHES } from "@/lib/ui/colorSwatches";
import { saveImages, loadImages, clearImages } from "@/lib/ui/imageStore";
import { setStyleDNA } from "@/lib/ui/localPersistence";
import { AppHeader } from "@/components/AppHeader";

const MIN_IMAGES = 5;
const MAX_IMAGES = 10;
// Cache-hit-heavy requests can genuinely finish in well under a second,
// which reads as suspicious rather than trustworthy for an "AI analyzed
// your photos" moment. This holds the real progress steps on screen for at
// least this long before revealing the result -- a reveal-timing choice,
// not fabricated content: every step shown already happened for real.
const MIN_DISPLAY_MS = 1800;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const STAGE_ORDER = ["processing_images", "generating_tags", "creating_profile"];

type Entry = { clientId: string; file: File; thumb: string };

type ProfileResult = {
  styleDNA: {
    archetypePrimary: string;
    archetypeSecondary: string | null;
    silhouette: string[];
    colorFamily: string[];
    formality: string;
    sourceImageCount: number;
  };
  skipped: {
    invalid: { clientId: string; label: string; reason: string; detail?: string }[];
    duplicates: { clientId: string; label: string; duplicateOfHash: string }[];
    tagFailed: { clientId: string; label: string; reason: string }[];
  };
  counts: Record<string, number>;
};

type Progress = { stage: string; message: string; completed?: number; total?: number };

function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function UploadIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 16V4m0 0L7 9m5-5l5 5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function StepIndicator({ progress }: { progress: Progress | null }) {
  const steps = [
    { key: "processing_images", label: "Processing images" },
    { key: "generating_tags", label: "Generating tags" },
    { key: "creating_profile", label: "Creating your profile" },
  ];
  const currentIndex = progress ? STAGE_ORDER.indexOf(progress.stage) : -1;

  return (
    <div className="space-y-3 py-2">
      {steps.map((step) => {
        const stepIndex = STAGE_ORDER.indexOf(step.key);
        const state = stepIndex < currentIndex ? "done" : stepIndex === currentIndex ? "active" : "pending";
        const label =
          step.key === "generating_tags" && progress?.stage === "generating_tags" && progress.total
            ? `Generating tags (${progress.completed}/${progress.total})`
            : step.label;
        return (
          <div key={step.key} className="flex items-center gap-3 text-sm">
            <span
              className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
                state === "done" ? "bg-stone-900" : state === "active" ? "bg-stone-900" : "bg-stone-200"
              }`}
            >
              {state === "active" && (
                <span className="absolute inset-0 rounded-full bg-stone-900 motion-safe:animate-ping motion-safe:opacity-60" />
              )}
            </span>
            <span className={state === "pending" ? "text-stone-400" : "text-stone-800"}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProfileResult | null>(null);

  const totalCount = entries.length;
  const canSubmit = totalCount >= MIN_IMAGES && totalCount <= MAX_IMAGES && !loading;

  // Reload any previously-uploaded photos on mount -- this is what makes
  // "Edit your photos" (linked from /recommendations) come back to an
  // actually-populated page instead of a blank upload area. Object URLs
  // are page-instance-scoped (invalidated on navigation), so they're
  // regenerated fresh from the persisted File blobs rather than reused.
  const hasLoadedRef = useRef(false);
  useEffect(() => {
    loadImages()
      .then((stored) => {
        hasLoadedRef.current = true;
        if (stored.length > 0) {
          setEntries(stored.map((s) => ({ clientId: s.clientId, file: s.file, thumb: URL.createObjectURL(s.file) })));
        }
      })
      .catch(() => {
        // IndexedDB unavailable (e.g. private browsing) -- degrade to
        // in-memory-only for this session rather than getting stuck with
        // the persist effect permanently blocked below.
        hasLoadedRef.current = true;
      });
  }, []);

  // Persist on every change so the working set survives navigation away and
  // back. Skipped until the initial load resolves, so a fresh mount doesn't
  // race a "save empty" over whatever was just loaded. Failure is non-fatal
  // -- "edit photos" continuity just won't survive navigation this session.
  useEffect(() => {
    if (!hasLoadedRef.current) return;
    saveImages(entries.map((e) => ({ clientId: e.clientId, file: e.file }))).catch(() => {});
  }, [entries]);

  // A StyleDNA result reflects the exact photo set it was built from --
  // changing that set (add or remove) makes the displayed result stale and
  // silently wrong, not just outdated. Invalidate it immediately rather
  // than leaving it on screen until the user notices and re-submits.
  function invalidateStaleResult() {
    if (result) setResult(null);
    if (error) setError(null);
  }

  function addFiles(fileList: FileList | File[]) {
    // Guard against editing while a submission is in flight -- its FormData
    // snapshot is already locked in, so an edit here wouldn't affect that
    // request but WOULD create the same stale-result mismatch once it
    // completes, just via a different path than the one just fixed above.
    if (loading) return;
    const all = Array.from(fileList);
    const picked = all.filter((f) => ACCEPTED_TYPES.includes(f.type));
    const rejectedCount = all.length - picked.length;

    invalidateStaleResult();

    // Previously a drop with zero supported files (e.g. HEIC photos
    // straight off an iPhone, which have MIME type image/heic -- not in
    // ACCEPTED_TYPES) did nothing at all: no photos appeared, no message,
    // no clue why. Same for a mixed batch where some files were rejected.
    if (picked.length === 0) {
      if (all.length > 0) {
        setError(
          "Those files aren't in a supported format (JPG, PNG, GIF, or WEBP). If they're HEIC photos from an iPhone, export or screenshot them as JPG first.",
        );
      }
      return;
    }
    if (rejectedCount > 0) {
      setError(
        `${rejectedCount} file${rejectedCount > 1 ? "s" : ""} skipped — unsupported format (JPG, PNG, GIF, WEBP only).`,
      );
    }

    const newEntries: Entry[] = picked.map((file) => ({
      clientId: newClientId(),
      file,
      thumb: URL.createObjectURL(file),
    }));
    setEntries((prev) => [...prev, ...newEntries].slice(0, MAX_IMAGES));
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = "";
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  }

  function handleSeeRecommendations() {
    if (!result) return;
    const saved = setStyleDNA(result.styleDNA);
    if (!saved) {
      setError(
        "We couldn't save your StyleDNA in this browser (private browsing or storage may be disabled). Try a normal browsing window.",
      );
      return;
    }
    router.push("/recommendations");
  }

  function removeEntry(clientId: string) {
    if (loading) return;
    invalidateStaleResult();
    setEntries((prev) => {
      const target = prev.find((e) => e.clientId === clientId);
      if (target) URL.revokeObjectURL(target.thumb);
      return prev.filter((e) => e.clientId !== clientId);
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setProgress(null);
    setLoading(true);

    const startedAt = Date.now();
    const formData = new FormData();
    const clientIds: string[] = [];
    for (const entry of entries) {
      clientIds.push(entry.clientId);
      formData.append("images", entry.file);
    }
    formData.append("clientIds", JSON.stringify(clientIds));

    let pendingResult: ProfileResult | null = null;
    let pendingError: string | null = null;

    try {
      const res = await fetch("/api/profile", { method: "POST", body: formData });

      // The route always streams NDJSON with a 200 status, even for
      // in-band failures (those arrive as a "type: error" event) -- so a
      // non-OK status here means something failed *before* the app got a
      // chance to respond in-band: a platform body-size limit (413), a
      // proxy timeout, etc. The body in that case is often an HTML error
      // page, not NDJSON, so it must not be fed to the line parser below.
      if (!res.ok) {
        if (res.status === 413) {
          throw new Error("Your photos are too large to upload together. Try removing a few or using smaller images.");
        }
        let message = `Upload failed (${res.status}). Please try again.`;
        try {
          const text = await res.text();
          const parsed = JSON.parse(text);
          if (parsed?.error) message = parsed.error;
        } catch {
          // Response wasn't JSON (e.g. an HTML error page) -- keep the default message.
        }
        throw new Error(message);
      }
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "progress") {
            setProgress(event);
          } else if (event.type === "done") {
            pendingResult = event;
          } else if (event.type === "error") {
            pendingError = event.error;
          }
        }
      }

      // The connection can close (proxy/platform timeout, dropped network)
      // before either a "done" or "error" event was ever sent. reader.read()
      // then just returns done:true -- no exception is thrown, so this was
      // previously falling through with both pendingResult and pendingError
      // null, leaving the user staring at a form that silently stopped
      // loading with zero explanation.
      if (!pendingResult && !pendingError) {
        pendingError = "The connection was interrupted before we finished. Please try again.";
      }

      // Only the success path gets held to the minimum display time -- a
      // real failure should surface immediately, not be delayed for pacing.
      if (pendingResult) {
        const remaining = MIN_DISPLAY_MS - (Date.now() - startedAt);
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining));
        }
      }
    } catch (err) {
      pendingError = err instanceof Error ? err.message : "Network error — check your connection and try again.";
    } finally {
      if (pendingResult) setResult(pendingResult);
      if (pendingError) setError(pendingError);
      setLoading(false);
      setProgress(null);
    }
  }

  return (
    <main className="min-h-screen bg-white pb-16 text-stone-900">
      <AppHeader />
      <div className="mx-auto w-full max-w-xl px-6 pt-10">
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-stone-400">StyleDNA</p>
          <h1 className="mt-3 text-3xl font-medium tracking-tight sm:text-4xl">Build your profile</h1>
          <p className="mx-auto mt-3 max-w-sm text-[15px] text-stone-500">
            Upload {MIN_IMAGES}–{MAX_IMAGES} fashion inspiration photos — screenshots of outfits you love.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-10 space-y-6">
          {entries.length === 0 ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`relative flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-16 text-center transition-colors ${
                isDragging ? "border-stone-900 bg-stone-50" : "border-stone-300 hover:border-stone-400"
              }`}
            >
              <input
                type="file"
                accept={ACCEPTED_TYPES.join(",")}
                multiple
                onChange={handleFileChange}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Upload photos"
              />
              <div className="text-stone-400">
                <UploadIcon />
              </div>
              <p className="mt-3 text-sm font-medium text-stone-900">Drag photos here, or click to browse</p>
              <p className="mt-1 text-xs text-stone-400">JPG, PNG, GIF, or WEBP</p>
            </div>
          ) : (
            <div
              className={`grid grid-cols-4 gap-3 transition-opacity sm:grid-cols-5 ${loading ? "pointer-events-none opacity-50" : ""}`}
            >
              {entries.map((entry) => (
                <div
                  key={entry.clientId}
                  className="group relative aspect-[4/5] overflow-hidden rounded-lg bg-stone-100"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={entry.thumb} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeEntry(entry.clientId)}
                    className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-stone-700 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label="Remove photo"
                  >
                    &times;
                  </button>
                </div>
              ))}
              {entries.length < MAX_IMAGES && (
                <label className="relative flex aspect-[4/5] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-stone-300 text-stone-400 transition-colors hover:border-stone-400 hover:text-stone-600">
                  <input
                    type="file"
                    accept={ACCEPTED_TYPES.join(",")}
                    multiple
                    onChange={handleFileChange}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    aria-label="Add more photos"
                  />
                  <PlusIcon />
                  <span className="text-[11px]">Add more</span>
                </label>
              )}
            </div>
          )}

          <div className="flex flex-col items-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center justify-center rounded-full bg-stone-900 px-7 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
            >
              Build My StyleDNA
            </button>
            <span className={`text-xs ${totalCount > MAX_IMAGES ? "text-red-700" : "text-stone-400"}`}>
              {totalCount} of {MIN_IMAGES}–{MAX_IMAGES} photos
            </span>
          </div>

          {loading && <StepIndicator progress={progress} />}
        </form>

        {error && (
          <div className="mt-8 rounded-lg border border-red-200 bg-red-50/60 p-4 text-sm text-red-800">
            {error}
          </div>
        )}

        {result && (
          <div className="mt-12 space-y-6">
            {(result.skipped.invalid.length > 0 ||
              result.skipped.duplicates.length > 0 ||
              result.skipped.tagFailed.length > 0) && (
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm text-stone-600">
                <p className="font-medium text-stone-800">
                  {result.skipped.invalid.length + result.skipped.duplicates.length + result.skipped.tagFailed.length}{" "}
                  of your {result.counts.submitted} photos couldn&rsquo;t be used — your profile below is built
                  from the rest.
                </p>
                <ul className="mt-1.5 space-y-0.5 text-xs text-stone-500">
                  {result.skipped.invalid.map((s, i) => (
                    <li key={`invalid-${i}`} className="truncate" title={s.label}>
                      &ldquo;{s.label}&rdquo; — {s.reason}
                      {s.detail ? ` (${s.detail})` : ""}
                    </li>
                  ))}
                  {result.skipped.duplicates.map((s, i) => (
                    <li key={`dup-${i}`} className="truncate" title={s.label}>
                      &ldquo;{s.label}&rdquo; — duplicate of another photo you uploaded
                    </li>
                  ))}
                  {result.skipped.tagFailed.map((s, i) => (
                    <li key={`tagfailed-${i}`} className="truncate" title={s.label}>
                      &ldquo;{s.label}&rdquo; — couldn&rsquo;t be classified, try a clearer photo
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <section className="border-t border-stone-200 pt-10 text-center">
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-stone-400">Your StyleDNA</p>
              <h2 className="mt-3 text-4xl font-medium capitalize tracking-tight sm:text-5xl">
                {result.styleDNA.archetypePrimary.replace(/_/g, " ")}
              </h2>
              {result.styleDNA.archetypeSecondary && (
                <p className="mt-2 text-sm text-stone-500">
                  with a touch of{" "}
                  <span className="font-medium text-stone-700">
                    {result.styleDNA.archetypeSecondary.replace(/_/g, " ")}
                  </span>
                </p>
              )}
              <p className="mx-auto mt-5 max-w-md text-[15px] leading-relaxed text-stone-600">
                {summarizeStyleDNA(result.styleDNA)}
              </p>

              <div className="mx-auto mt-10 grid max-w-md grid-cols-1 gap-8 border-t border-stone-200 pt-8 text-left sm:grid-cols-3 sm:gap-6">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Silhouette</p>
                  <p className="mt-2 text-sm capitalize text-stone-700">
                    {result.styleDNA.silhouette.length
                      ? result.styleDNA.silhouette.map((s) => s.replace(/_/g, " ")).join(", ")
                      : "Mixed"}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Palette</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {result.styleDNA.colorFamily.length ? (
                      result.styleDNA.colorFamily.map((c) => (
                        <span key={c} className="flex items-center gap-1.5">
                          <span
                            className="h-3 w-3 rounded-full border border-black/10"
                            style={{ backgroundColor: COLOR_SWATCHES[c] ?? "#ccc" }}
                          />
                          <span className="text-sm capitalize text-stone-700">{c.replace(/_/g, " ")}</span>
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-stone-700">Mixed</span>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Formality</p>
                  <p className="mt-2 text-sm capitalize text-stone-700">
                    {result.styleDNA.formality.replace(/_/g, " ")}
                  </p>
                </div>
              </div>

              <p className="mt-10 text-xs text-stone-400">
                Based on {result.styleDNA.sourceImageCount} photos
              </p>

              <div className="mt-8 flex flex-col items-center gap-3">
                <button
                  type="button"
                  onClick={handleSeeRecommendations}
                  className="inline-flex items-center justify-center rounded-full bg-stone-900 px-8 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
                >
                  See My Recommendations
                </button>
                <button
                  type="button"
                  onClick={() => {
                    entries.forEach((e) => URL.revokeObjectURL(e.thumb));
                    setEntries([]);
                    setResult(null);
                    setError(null);
                    clearImages().catch(() => {});
                  }}
                  className="text-xs text-stone-400 underline decoration-stone-300 underline-offset-4 transition-colors hover:text-stone-600"
                >
                  Start over with different photos
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
