"use client";

import { useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";
import { summarizeStyleDNA } from "@/lib/profile/summarize";

const MIN_IMAGES = 5;
const MAX_IMAGES = 10;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Representative swatches for the color_family taxonomy -- this is actual
// product data (which family the AI assigned), not decorative UI color.
const COLOR_SWATCHES: Record<string, string> = {
  neutral_cream: "#E8DFC9",
  earth_tone: "#A9784F",
  monochrome_black: "#1A1A1A",
  pastel: "#F0C9D8",
  jewel_tone: "#6B2C5F",
  bright_bold: "#E0391B",
  denim_blue: "#3B5A82",
  metallic: "#B8B2A5",
};

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
  const [entries, setEntries] = useState<Entry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProfileResult | null>(null);

  const totalCount = entries.length;
  const canSubmit = totalCount >= MIN_IMAGES && totalCount <= MAX_IMAGES && !loading;

  function addFiles(fileList: FileList | File[]) {
    const picked = Array.from(fileList).filter((f) => ACCEPTED_TYPES.includes(f.type));
    if (picked.length === 0) return;
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

    const formData = new FormData();
    const clientIds: string[] = [];
    for (const entry of entries) {
      clientIds.push(entry.clientId);
      formData.append("images", entry.file);
    }
    formData.append("clientIds", JSON.stringify(clientIds));

    try {
      const res = await fetch("/api/profile", { method: "POST", body: formData });
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
            setResult(event);
          } else if (event.type === "error") {
            setError(event.error);
          }
        }
      }
    } catch {
      setError("Network error — check your connection and try again.");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  return (
    <main className="min-h-screen bg-white px-6 py-16 text-stone-900">
      <div className="mx-auto w-full max-w-xl">
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
            <div className="grid grid-cols-4 gap-3 sm:grid-cols-5">
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
            {result.skipped.invalid.length > 0 && (
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm text-stone-600">
                <p className="font-medium text-stone-800">
                  {result.skipped.invalid.length} of your {result.counts.submitted} photos couldn&rsquo;t be
                  used — your profile below is built from the rest.
                </p>
                <ul className="mt-1.5 space-y-0.5 text-xs text-stone-500">
                  {result.skipped.invalid.map((s, i) => (
                    <li key={i} className="truncate" title={s.label}>
                      &ldquo;{s.label}&rdquo; — {s.reason}
                      {s.detail ? ` (${s.detail})` : ""}
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
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
