import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./client";
import { OCCASIONS, CLIMATES, isOccasion, isClimate, type Occasion, type Climate } from "./taxonomy";

// Same model/effort posture as the tagging calls -- forced tool_choice,
// closed enum, no open-ended reasoning needed. Text-only input keeps this
// fast even on Opus (no image tokens), so there's no latency reason to
// reach for a smaller model here.
const MODEL = "claude-opus-4-8";

const INTENT_TOOL_NAME = "classify_shopping_intent";

const INTENT_TOOL = {
  name: INTENT_TOOL_NAME,
  description:
    "Classify a free-text shopping intent phrase (e.g. 'summer trip to Italy', 'date night') into the closed occasion/climate taxonomy.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      occasion: {
        type: "array",
        items: { type: "string", enum: OCCASIONS },
        description:
          "Every occasion that genuinely applies to the phrase. Empty array if the phrase gives no clear occasion signal (e.g. it's just a style word, not a shopping context).",
      },
      climate: {
        type: "string",
        enum: [...CLIMATES, "none"],
        description: "The climate/season implied by the phrase, or 'none' if there's no clear signal.",
      },
    },
    required: ["occasion", "climate"],
    additionalProperties: false,
  },
} as const;

export type ClassifiedIntent = { occasion: Occasion[]; climate: Climate | null };

export type ClassifyIntentResult =
  | { ok: true; intent: ClassifiedIntent }
  | { ok: false; reason: "schema_validation_failed" | "api_error"; detail?: string };

function validate(input: unknown): ClassifiedIntent | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;

  if (!Array.isArray(raw.occasion) || raw.occasion.length > 4 || !raw.occasion.every(isOccasion)) {
    return null;
  }

  const climate = raw.climate === "none" ? null : raw.climate;
  if (climate !== null && !isClimate(climate)) return null;

  return { occasion: raw.occasion as Occasion[], climate };
}

async function callClaude(text: string) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    tool_choice: { type: "tool", name: INTENT_TOOL_NAME },
    tools: [INTENT_TOOL as unknown as Anthropic.Tool],
    messages: [
      {
        role: "user",
        content: `Classify this shopping intent phrase using the ${INTENT_TOOL_NAME} tool: "${text}"`,
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  return toolUse?.input;
}

/**
 * Classifies a free-text shopping-intent phrase into the same closed
 * occasion/climate enums products are tagged with, so the result can drive
 * the recommendations filters directly -- the user types their own words,
 * never sees a taxonomy value. Retries once on schema failure, same
 * not-throwing pattern as tagImage so a classification miss degrades to
 * "no intent applied" rather than failing profile creation.
 */
export async function classifyIntent(text: string): Promise<ClassifyIntentResult> {
  let lastFailure: ClassifyIntentResult = { ok: false, reason: "schema_validation_failed" };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rawInput = await callClaude(text);
      const intent = validate(rawInput);
      if (intent) return { ok: true, intent };
      lastFailure = { ok: false, reason: "schema_validation_failed" };
    } catch (err) {
      lastFailure = { ok: false, reason: "api_error", detail: String((err as Error)?.message ?? err) };
    }
  }

  return lastFailure;
}
