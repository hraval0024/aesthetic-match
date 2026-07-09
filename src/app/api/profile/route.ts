import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { tagImage } from "@/lib/claude/tagImage";
import { validateImageBytes } from "@/lib/images/validate";
import { hashImage } from "@/lib/images/hash";
import { createLimiter } from "@/lib/concurrency/limiter";
import { aggregateStyleDNA } from "@/lib/profile/aggregation";
import type { ImageTags } from "@/lib/claude/taxonomy";

export const runtime = "nodejs";

const MIN_IMAGES = 5;
const MAX_IMAGES = 10;
const CONCURRENCY = 5;

type ResolvedInput = { clientId: string; label: string; bytes: Buffer; mediaType: string };
type FailedInput = {
  clientId: string;
  label: string;
  stage: "download" | "validation";
  reason: string;
  detail?: string;
};
type Resolution =
  | { ok: true; input: ResolvedInput }
  | { ok: false; failure: FailedInput };

async function resolveFile(clientId: string, file: File): Promise<Resolution> {
  const label = file.name || "uploaded image";
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const mediaType = file.type || "application/octet-stream";
    const v = validateImageBytes(bytes, mediaType);
    if (!v.valid) {
      return { ok: false, failure: { clientId, label, stage: "validation", reason: v.reason, detail: v.detail } };
    }
    return { ok: true, input: { clientId, label, bytes, mediaType } };
  } catch (err) {
    return {
      ok: false,
      failure: {
        clientId,
        label,
        stage: "download",
        reason: "read_failed",
        detail: String((err as Error)?.message ?? err),
      },
    };
  }
}

function tagsFromCacheRow(cached: {
  archetypePrimary: string;
  archetypeSecondary: string | null;
  silhouette: string;
  formality: string;
  colorFamily: string;
  fabric: string | null;
  textureNotes: string | null;
  confidence: number | null;
}): ImageTags {
  return {
    archetypePrimary: cached.archetypePrimary as ImageTags["archetypePrimary"],
    archetypeSecondary: cached.archetypeSecondary as ImageTags["archetypeSecondary"],
    silhouette: JSON.parse(cached.silhouette),
    formality: cached.formality as ImageTags["formality"],
    colorFamily: JSON.parse(cached.colorFamily),
    fabric: cached.fabric ?? "",
    textureNotes: cached.textureNotes ?? "",
    confidence: cached.confidence ?? 0,
  };
}

type TaggedResult = {
  clientId: string;
  label: string;
  hash: string;
  status: "cache_hit" | "tagged" | "tag_failed";
  tags?: ImageTags;
  reason?: string;
  claudeLatencyMs?: number;
};

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const totalStart = Date.now();
      let closed = false;

      function send(event: Record<string, unknown>) {
        if (closed) return;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      }
      function fail(error: string, extra?: Record<string, unknown>) {
        // Centralized so every failure path is observable -- previously only
        // the success path logged anything, so a real user-facing error left
        // zero server-side trace to debug from.
        console.error(JSON.stringify({ event: "profile_creation_failed", error, ...extra }));
        send({ type: "error", error, ...extra });
        closed = true;
        controller.close();
      }

      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        fail("Expected multipart/form-data with 'images' file fields.");
        return;
      }

      const files = formData.getAll("images").filter((v): v is File => v instanceof File);
      const clientIdsRaw = formData.get("clientIds");
      const clientIds: string[] = clientIdsRaw ? JSON.parse(clientIdsRaw as string) : files.map((f) => f.name);

      const totalSubmitted = files.length;

      if (totalSubmitted === 0) {
        fail(`No images provided. Upload ${MIN_IMAGES}-${MAX_IMAGES} images.`);
        return;
      }
      if (totalSubmitted > MAX_IMAGES) {
        fail(`Too many images submitted (${totalSubmitted}). Maximum is ${MAX_IMAGES}.`);
        return;
      }

      send({
        type: "progress",
        stage: "processing_images",
        message: `Processing ${totalSubmitted} uploaded image${totalSubmitted > 1 ? "s" : ""}...`,
      });

      const resolutions = await Promise.all(
        files.map((file, i) => resolveFile(clientIds[i] ?? `input-${i}`, file)),
      );

      const resolved = resolutions
        .filter((r): r is { ok: true; input: ResolvedInput } => r.ok)
        .map((r) => r.input);
      const failed: FailedInput[] = resolutions
        .filter((r): r is { ok: false; failure: FailedInput } => !r.ok)
        .map((r) => r.failure);

      if (resolved.length < MIN_IMAGES) {
        fail(
          `Only ${resolved.length} of ${totalSubmitted} submitted images were valid; at least ${MIN_IMAGES} are required.`,
          { failed },
        );
        return;
      }

      // Dedupe by content hash, preserving order -- a repeated image still
      // counts toward the minimum above, but only its first occurrence gets
      // tagged/weighted in aggregation.
      const hashed = resolved.map((r) => ({ ...r, hash: hashImage(r.bytes) }));
      const seenHashes = new Set<string>();
      const uniqueInputs: (typeof hashed)[number][] = [];
      const duplicates: { clientId: string; label: string; duplicateOfHash: string }[] = [];
      for (const h of hashed) {
        if (seenHashes.has(h.hash)) {
          duplicates.push({ clientId: h.clientId, label: h.label, duplicateOfHash: h.hash });
          continue;
        }
        seenHashes.add(h.hash);
        uniqueInputs.push(h);
      }

      send({
        type: "progress",
        stage: "generating_tags",
        message: `Generating tags... (0/${uniqueInputs.length})`,
        completed: 0,
        total: uniqueInputs.length,
      });

      const limit = createLimiter(CONCURRENCY);
      const taggingStart = Date.now();
      let taggedCount = 0;

      const taggedResults: TaggedResult[] = await Promise.all(
        uniqueInputs.map((input) =>
          limit(async (): Promise<TaggedResult> => {
            const cached = await prisma.tagCache.findUnique({ where: { imageHash: input.hash } });

            let result: TaggedResult;
            if (cached) {
              result = {
                clientId: input.clientId,
                label: input.label,
                hash: input.hash,
                status: "cache_hit",
                tags: tagsFromCacheRow(cached),
              };
            } else {
              const start = Date.now();
              const tagResult = await tagImage(input.bytes, input.mediaType);
              const claudeLatencyMs = Date.now() - start;

              if (!tagResult.ok) {
                result = {
                  clientId: input.clientId,
                  label: input.label,
                  hash: input.hash,
                  status: "tag_failed",
                  reason: tagResult.detail ? `${tagResult.reason}: ${tagResult.detail}` : tagResult.reason,
                  claudeLatencyMs,
                };
              } else {
                await prisma.tagCache.upsert({
                  where: { imageHash: input.hash },
                  create: {
                    imageHash: input.hash,
                    archetypePrimary: tagResult.tags.archetypePrimary,
                    archetypeSecondary: tagResult.tags.archetypeSecondary,
                    silhouette: JSON.stringify(tagResult.tags.silhouette),
                    formality: tagResult.tags.formality,
                    colorFamily: JSON.stringify(tagResult.tags.colorFamily),
                    fabric: tagResult.tags.fabric,
                    textureNotes: tagResult.tags.textureNotes,
                    confidence: tagResult.tags.confidence,
                  },
                  update: {},
                });
                result = {
                  clientId: input.clientId,
                  label: input.label,
                  hash: input.hash,
                  status: "tagged",
                  tags: tagResult.tags,
                  claudeLatencyMs,
                };
              }
            }

            taggedCount++;
            send({
              type: "progress",
              stage: "generating_tags",
              message: `Generating tags... (${taggedCount}/${uniqueInputs.length})`,
              completed: taggedCount,
              total: uniqueInputs.length,
            });
            return result;
          }),
        ),
      );
      const taggingLatencyMs = Date.now() - taggingStart;

      const successfullyTagged = taggedResults.filter(
        (r): r is TaggedResult & { tags: ImageTags } => r.status !== "tag_failed" && r.tags !== undefined,
      );

      if (successfullyTagged.length < MIN_IMAGES) {
        fail(
          `Only ${successfullyTagged.length} of ${uniqueInputs.length} images could be classified; at least ${MIN_IMAGES} are required. Try different images.`,
          { images: taggedResults, failed },
        );
        return;
      }

      send({ type: "progress", stage: "creating_profile", message: "Creating your StyleDNA..." });

      const styleDNA = aggregateStyleDNA(successfullyTagged.map((r) => r.tags));

      const cacheHits = taggedResults.filter((r) => r.status === "cache_hit").length;
      const freshlyTagged = taggedResults.filter((r) => r.status === "tagged").length;
      const tagFailed = taggedResults.filter((r) => r.status === "tag_failed").length;
      const totalLatencyMs = Date.now() - totalStart;

      console.log(
        JSON.stringify({
          event: "profile_created",
          submitted: totalSubmitted,
          valid: resolved.length,
          invalid: failed.length,
          duplicates: duplicates.length,
          uniqueTagged: uniqueInputs.length,
          cacheHits,
          freshlyTagged,
          tagFailed,
          cacheHitRate: uniqueInputs.length ? cacheHits / uniqueInputs.length : 0,
          totalLatencyMs,
          taggingLatencyMs,
          archetypePrimary: styleDNA.archetypePrimary,
          archetypeSecondary: styleDNA.archetypeSecondary,
          // full detail on anything skipped, even though the request
          // succeeded overall -- keeps quiet partial failures observable
          skippedDetail: failed.length ? failed : undefined,
        }),
      );

      send({
        type: "done",
        styleDNA,
        images: taggedResults,
        skipped: { invalid: failed, duplicates },
        counts: {
          submitted: totalSubmitted,
          valid: resolved.length,
          uniqueTagged: uniqueInputs.length,
          duplicates: duplicates.length,
          cacheHits,
          freshlyTagged,
          tagFailed,
        },
        latencyMs: { total: totalLatencyMs, tagging: taggingLatencyMs },
      });
      closed = true;
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}
