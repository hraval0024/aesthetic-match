// Single source of truth for supported image formats -- tagImage.ts's own
// check (defense-in-depth) imports this rather than keeping a second copy.
export const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// 8MB per image: generous for real product/outfit photos (Phase 2 catalog
// images ran 300-600KB), bounded to avoid a single oversized upload blowing
// up request latency/cost. Revisit if deployment hits a platform body-size
// ceiling before this does (see profile route edge-case notes).
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ImageValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason: "empty" | "unsupported_media_type" | "too_large";
      detail?: string;
    };

export function validateImageBytes(bytes: Buffer, mediaType: string): ImageValidationResult {
  if (!bytes || bytes.length === 0) {
    return { valid: false, reason: "empty" };
  }
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
    return { valid: false, reason: "unsupported_media_type", detail: mediaType };
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return {
      valid: false,
      reason: "too_large",
      detail: `${(bytes.length / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`,
    };
  }
  return { valid: true };
}
