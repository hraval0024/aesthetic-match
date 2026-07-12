import { NextRequest, NextResponse } from "next/server";
import { classifyIntent } from "@/lib/claude/classifyIntent";
import { checkRateLimit, getClientKey } from "@/lib/security/rateLimit";

export const runtime = "nodejs";

const MAX_TEXT_LENGTH = 200;
// Cheap per call, but still a real Claude charge per request and the only
// endpoint reachable with no other cost gate (unlike /api/profile, which is
// naturally throttled by requiring 5+ image uploads) -- confirmed live that
// 25 rapid requests all succeeded with zero throttling before this existed.
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

// Standalone classification for the landing page's "what are you shopping
// for today?" field -- returning users already have a StyleDNA and don't
// need to re-upload photos just to refresh their shopping intent, so this
// is a thin wrapper around the same classifyIntent() the profile-creation
// flow uses, without the rest of that pipeline.
export async function POST(request: NextRequest) {
  const rateLimit = checkRateLimit(`classify-intent:${getClientKey(request)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: { text?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body with a text field." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Missing text to classify." }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json({ error: `Text too long (max ${MAX_TEXT_LENGTH} characters).` }, { status: 400 });
  }

  const result = await classifyIntent(text);

  console.log(
    JSON.stringify({
      event: "intent_classified_standalone",
      textLength: text.length,
      ok: result.ok,
      occasion: result.ok ? result.intent.occasion : undefined,
      climate: result.ok ? result.intent.climate : undefined,
      failureReason: !result.ok ? result.reason : undefined,
    }),
  );

  if (!result.ok) {
    // Non-fatal from the caller's perspective too -- same posture as
    // profile creation: a classification miss just means "no intent
    // applied," not a hard error the user needs to retry.
    return NextResponse.json({ occasion: [], climate: null });
  }

  return NextResponse.json({ occasion: result.intent.occasion, climate: result.intent.climate });
}
