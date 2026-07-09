import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./client";

// Real-measured tradeoff (see conversation for the full comparison table):
// one Opus call for all 20 rationales took ~18.8s -- far over PROJECT.md's
// <3s recommendation NFR. Batching into parallel chunks (below) was the
// bigger lever (Opus: 18.8s -> 7.5s batched), but only Haiku 4.5 gets close
// to the target (10.3s -> 3.5s batched). Quality checked side-by-side
// against Opus/Sonnet on real output -- still genuinely grounded in the
// taxonomy, just more compact phrasing. User confirmed this choice given
// the real numbers rather than it being picked silently.
const MODEL = "claude-haiku-4-5";

const RATIONALE_TOOL_NAME = "generate_rationales";

const RATIONALE_TOOL = {
  name: RATIONALE_TOOL_NAME,
  description: "Write one-line \"why this matches\" rationales for a fashion recommendation feed.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      rationales: {
        type: "array",
        items: {
          type: "object",
          properties: {
            product_id: { type: "string" },
            rationale: {
              type: "string",
              description:
                "One sentence, under 25 words, naming the specific shared attributes given for that product. No generic phrases like 'perfect for you', 'you'll love this', 'a great match', 'this piece'.",
            },
          },
          required: ["product_id", "rationale"],
          additionalProperties: false,
        },
      },
    },
    required: ["rationales"],
    additionalProperties: false,
  },
} as const;

export type RationaleInput = { productId: string; title: string; matchedFacts: string[] };

async function callClaude(items: RationaleInput[]) {
  const itemsBlock = items
    .map((i) => `- id: ${i.productId}\n  title: ${i.title}\n  shared attributes: ${i.matchedFacts.join("; ") || "none"}`)
    .join("\n");

  const prompt = `Write a one-line "why this matches" rationale for each product below, for a fashion recommendation feed. Each rationale MUST reference the specific shared attributes listed for that product -- do not invent attributes that aren't listed, and do not use generic filler ("perfect for you", "you'll love this", "a great match"). Vary sentence structure across items so the feed doesn't read as templated.

Products:
${itemsBlock}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    thinking: { type: "disabled" },
    tool_choice: { type: "tool", name: RATIONALE_TOOL_NAME },
    tools: [RATIONALE_TOOL as unknown as Anthropic.Tool],
    messages: [{ role: "user", content: prompt }],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  return toolUse?.input as { rationales?: { product_id: string; rationale: string }[] } | undefined;
}

/**
 * Batched rationale generation: one Claude call for the whole ranked list,
 * not one per item. Retries once on schema/parse failure. Returns a map
 * missing any productId it couldn't get a rationale for, rather than
 * throwing -- callers render those without a rationale line instead of
 * failing the whole recommendations request over rationale copy.
 */
async function generateBatch(items: RationaleInput[]): Promise<Map<string, string>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const input = await callClaude(items);
      if (input?.rationales && Array.isArray(input.rationales)) {
        const map = new Map<string, string>();
        for (const r of input.rationales) {
          if (typeof r.product_id === "string" && typeof r.rationale === "string") {
            map.set(r.product_id, r.rationale);
          }
        }
        if (items.every((i) => map.has(i.productId))) {
          return map;
        }
      }
    } catch {
      // fall through to retry
    }
  }
  return new Map();
}

// Splitting one 20-item call into parallel batches is what actually cut
// latency (Haiku: 10.3s single-batch -> 3.5s at batch size 5; Opus: 18.8s ->
// 7.5s). Smaller batches also lose a little cross-item phrasing variety
// since "vary sentence structure" only sees 5 items at a time instead of 20
// -- acceptable tradeoff for the latency win.
const BATCH_SIZE = 5;

export async function generateRationales(items: RationaleInput[]): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();

  const batches: RationaleInput[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }

  const batchResults = await Promise.all(batches.map((batch) => generateBatch(batch)));
  const merged = new Map<string, string>();
  for (const result of batchResults) {
    for (const [k, v] of result) merged.set(k, v);
  }
  return merged;
}
