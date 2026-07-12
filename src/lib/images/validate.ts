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
      reason: "empty" | "unsupported_media_type" | "too_large" | "media_type_mismatch";
      detail?: string;
    };

// Detects the real format from the file's own magic bytes, independent of
// whatever Content-Type the browser/client claims. A client-supplied
// mediaType is just a string the caller chose -- trusting it alone (as this
// function used to) let a renamed .txt file with a spoofed "image/jpeg"
// header sail through our own validation and get forwarded to the Claude
// vision API, which rejected it, but only after spending a real API call
// on content that was never an image. Sniffing first rejects it for free.
function sniffImageFormat(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 6 && bytes.toString("ascii", 0, 3) === "GIF") {
    const version = bytes.toString("ascii", 3, 6);
    if (version === "87a" || version === "89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

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
  const sniffed = sniffImageFormat(bytes);
  if (!sniffed) {
    return {
      valid: false,
      reason: "unsupported_media_type",
      detail: "file content is not a recognized image format",
    };
  }
  if (sniffed !== mediaType) {
    return {
      valid: false,
      reason: "media_type_mismatch",
      detail: `declared as ${mediaType} but file content is actually ${sniffed}`,
    };
  }
  return { valid: true };
}
