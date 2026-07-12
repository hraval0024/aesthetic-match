// In-memory sliding-window limiter, keyed per-route by client IP. Every
// route this guards makes a real, billed Claude API call -- confirmed live
// during testing that 25 concurrent requests to classify-intent all
// succeeded with zero throttling, each one a real charge. No accounts exist
// in this app (see localPersistence.ts), so IP is the only identity signal
// available; this is intentionally simple rather than a distributed
// store -- single dev-server-process scope is the deployment model today,
// and an in-memory Map is sufficient for that. If this ever runs across
// multiple serverless instances, each instance gets its own counter, which
// under-enforces the limit rather than over-enforcing it -- a safe failure
// direction for a rate limiter.
type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();

// Opportunistic cleanup so `buckets` doesn't grow unbounded across many
// distinct IPs over a long-running process -- runs on a small fraction of
// requests rather than a separate timer, since this app has no other
// background-job infrastructure.
const CLEANUP_PROBABILITY = 0.01;
function maybeCleanup(now: number, maxWindowMs: number) {
  if (Math.random() > CLEANUP_PROBABILITY) return;
  for (const [key, bucket] of buckets) {
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < maxWindowMs);
    if (bucket.timestamps.length === 0) buckets.delete(key);
  }
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  maybeCleanup(now, windowMs);

  const bucket = buckets.get(key) ?? { timestamps: [] };
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    buckets.set(key, bucket);
    return { allowed: false, retryAfterSeconds };
  }

  bucket.timestamps.push(now);
  buckets.set(key, bucket);
  return { allowed: true };
}

// Next.js's NextRequest dropped the old `.ip` convenience field -- reading
// the proxy header directly works both behind a real proxy (Vercel sets
// x-forwarded-for) and falls back to a constant for local/direct requests,
// which just means all direct-connection traffic shares one bucket (fine
// for local dev, where there's only ever one real client anyway).
export function getClientKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}
