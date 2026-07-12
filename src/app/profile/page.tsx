"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { saveImages, loadImages, clearImages } from "@/lib/ui/imageStore";
import {
  setStyleDNA,
  setShoppingIntent,
  setProfileNotice,
  getShoppingIntentText,
  setShoppingIntentText as persistShoppingIntentText,
} from "@/lib/ui/localPersistence";
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
  shoppingIntent: { occasion: string[]; climate: string | null } | null;
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
            <span className={state === "pending" ? "text-stone-500" : "text-stone-800"}>{label}</span>
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
  const [shoppingIntentText, setShoppingIntentText] = useState("");

  const totalCount = entries.length;
  const canSubmit = totalCount >= MIN_IMAGES && totalCount <= MAX_IMAGES && !loading;

  // Reload any previously-uploaded photos on mount -- this is what makes
  // "Edit your photos" (linked from /recommendations) come back to an
  // actually-populated page instead of a blank upload area. Object URLs
  // are page-instance-scoped (invalidated on navigation), so they're
  // regenerated fresh from the persisted File blobs rather than reused.
  const hasLoadedRef = useRef(false);
  useEffect(() => {
    // Rehydrate the raw shopping-intent phrase too, not just photos -- this
    // is what makes "Edit photos or intent" (linked from /recommendations)
    // actually let someone edit their intent: without it, the textarea was
    // always blank on return even if they'd typed something before.
    setShoppingIntentText(getShoppingIntentText());
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

  function addFiles(fileList: FileList | File[]) {
    // Guard against editing while a submission is in flight -- its FormData
    // snapshot is already locked in, so an edit here wouldn't affect that
    // request.
    if (loading) return;
    const all = Array.from(fileList);
    const picked = all.filter((f) => ACCEPTED_TYPES.includes(f.type));
    const rejectedCount = all.length - picked.length;

    if (error) setError(null);

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

  function removeEntry(clientId: string) {
    if (loading) return;
    if (error) setError(null);
    setEntries((prev) => {
      const target = prev.find((e) => e.clientId === clientId);
      if (target) URL.revokeObjectURL(target.thumb);
      return prev.filter((e) => e.clientId !== clientId);
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
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
    formData.append("shoppingIntent", shoppingIntentText.trim());

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
      setLoading(false);
      setProgress(null);

      if (pendingResult) {
        const saved = setStyleDNA(pendingResult.styleDNA);
        // Always set, even when null/empty -- a stale intent from an
        // earlier profile shouldn't linger just because this submission
        // didn't type a new one. Same for the raw text (used to rehydrate
        // this field on return, and to show "Showing results for ..." on
        // recommendations) -- an empty submission should clear a stale
        // phrase from before, not leave it lingering.
        setShoppingIntent(pendingResult.shoppingIntent ?? { occasion: [], climate: null });
        persistShoppingIntentText(shoppingIntentText.trim());

        const skippedCount =
          pendingResult.skipped.invalid.length +
          pendingResult.skipped.duplicates.length +
          pendingResult.skipped.tagFailed.length;
        if (skippedCount > 0) {
          setProfileNotice(
            `${skippedCount} of your ${pendingResult.counts.submitted} photos couldn't be used — your StyleDNA is built from the rest.`,
          );
        }

        if (saved) {
          router.push("/recommendations");
        } else {
          setError(
            "We couldn't save your StyleDNA in this browser (private browsing or storage may be disabled). Try a normal browsing window.",
          );
        }
      } else if (pendingError) {
        setError(pendingError);
      }
    }
  }

  return (
    <main className="min-h-screen bg-white pb-16 text-stone-900">
      <AppHeader />
      <div className="mx-auto w-full max-w-xl px-6 pt-10">
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-stone-500">StyleDNA</p>
          <h1 className="mt-3 text-3xl font-medium tracking-tight sm:text-4xl">Build your profile</h1>
          <p className="mx-auto mt-3 max-w-sm text-[15px] text-stone-500">
            Upload {MIN_IMAGES}–{MAX_IMAGES} outfits you love. We&rsquo;ll identify the patterns that define
            your personal style.
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
              <div className="text-stone-500">
                <UploadIcon />
              </div>
              <p className="mt-3 text-sm font-medium text-stone-900">Drag photos here, or click to browse</p>
              <p className="mt-1 text-xs text-stone-500">JPG, PNG, GIF, or WEBP</p>
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
                <label className="relative flex aspect-[4/5] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-stone-300 text-stone-500 transition-colors hover:border-stone-400 hover:text-stone-600">
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

          <div>
            <label htmlFor="shopping-intent" className="block text-sm font-medium text-stone-900">
              What are you shopping for? <span className="font-normal text-stone-500">(optional)</span>
            </label>
            <p className="mt-1 text-[13px] text-stone-500">
              Tell us the occasion and we&rsquo;ll tailor your matches to it — no need to browse categories.
            </p>
            <textarea
              id="shopping-intent"
              value={shoppingIntentText}
              onChange={(e) => setShoppingIntentText(e.target.value)}
              disabled={loading}
              rows={2}
              maxLength={200}
              placeholder={"summer trip to Italy\ndate night this weekend"}
              className="mt-3 w-full resize-none rounded-xl border border-stone-300 px-4 py-3 text-sm text-stone-900 placeholder:text-stone-400 transition-colors focus:border-stone-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:bg-stone-50 disabled:text-stone-400"
            />
          </div>

          <div className="flex flex-col items-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center justify-center rounded-full bg-stone-900 px-7 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
            >
              Find my outfits
            </button>
            <span className={`text-xs ${totalCount > MAX_IMAGES ? "text-red-700" : "text-stone-500"}`}>
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
      </div>
    </main>
  );
}
