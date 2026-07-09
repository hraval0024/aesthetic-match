import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./client";
import { TAG_TOOL, TAG_TOOL_NAME, validateTags, type ImageTags } from "./taxonomy";
import { SUPPORTED_IMAGE_MEDIA_TYPES } from "../images/validate";

// Classification task with a forced single tool call and an enum-constrained
// schema -- no open-ended reasoning needed, so thinking is off and effort is
// low. Deliberate cost/latency choice for a few-hundred-call bulk workload;
// revisit if tagging quality looks weak on ambiguous images.
const MODEL = "claude-opus-4-8";

export type TagImageResult =
  | { ok: true; tags: ImageTags }
  | {
      ok: false;
      reason: "unsupported_media_type" | "schema_validation_failed" | "api_error";
      detail?: string;
    };

async function callClaude(imageBytes: Buffer, mediaType: string) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    tool_choice: { type: "tool", name: TAG_TOOL_NAME },
    tools: [TAG_TOOL as unknown as Anthropic.Tool],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: imageBytes.toString("base64"),
            },
          },
          {
            type: "text",
            text: "Classify this fashion image using the tag_fashion_image tool.",
          },
        ],
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  return toolUse?.input;
}

/**
 * Tags a single image against the fixed taxonomy. Forced tool_choice + schema
 * validation is the first safety net; validateTags() in code is the second.
 * Retries once on schema failure (PROJECT.md). Returns ok:false rather than
 * throwing so callers (catalog batch script, online profile tagging) can
 * track failure counts for the coverage report without a try/catch per call.
 */
export async function tagImage(
  imageBytes: Buffer,
  mediaType: string,
): Promise<TagImageResult> {
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
    return { ok: false, reason: "unsupported_media_type" };
  }

  let lastFailure: TagImageResult = { ok: false, reason: "schema_validation_failed" };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rawInput = await callClaude(imageBytes, mediaType);
      const tags = validateTags(rawInput);
      if (tags) return { ok: true, tags };
      lastFailure = { ok: false, reason: "schema_validation_failed" };
      // schema validation failed -- fall through to retry
    } catch (err) {
      lastFailure = {
        ok: false,
        reason: "api_error",
        detail: String((err as Error)?.message ?? err),
      };
      // API error -- fall through to retry
    }
  }

  return lastFailure;
}
