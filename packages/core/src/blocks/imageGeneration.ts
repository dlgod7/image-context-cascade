import type { BlockMatcher, ImageIdentity, StoredImage } from "../types";
import { imageIdentity } from "../identity";

const ENVELOPE_CHARS = 96;

// Codex persists image-generation tool output as a *bare* base64 string in
// `result` (no data: prefix), duplicated across `image_generation_call`
// response items and `image_generation_end` event messages. A single
// generated image can add ~3 MB per copy to the session file.
const MIN_RESULT_CHARS = 256;

const MAGIC_PREFIXES: Array<[string, string]> = [
  ["iVBORw0KGgo", "image/png"],
  ["/9j/", "image/jpeg"],
  ["R0lGOD", "image/gif"],
  ["UklGR", "image/webp"],
];

function sniffMediaType(base64: string): string | null {
  for (const [prefix, mediaType] of MAGIC_PREFIXES) {
    if (base64.startsWith(prefix)) return mediaType;
  }
  return null;
}

function matchable(block: unknown): { result: string; mediaType: string } | null {
  if (!block || typeof block !== "object") return null;
  const b = block as { type?: unknown; result?: unknown };
  if (b.type !== "image_generation_call" && b.type !== "image_generation_end") return null;
  if (typeof b.result !== "string" || b.result.length < MIN_RESULT_CHARS) return null;
  const mediaType = sniffMediaType(b.result);
  if (mediaType === null) return null;
  return { result: b.result, mediaType };
}

export function imageGenerationMatcher(hasher: (data: string) => string): BlockMatcher {
  const identityCache = new WeakMap<object, ImageIdentity>();
  return {
    formatId: "openai-image-generation",
    match(block: unknown) {
      const found = matchable(block);
      if (found === null) return null;
      let identity = identityCache.get(block as object);
      if (!identity) {
        identity = imageIdentity(found.result, hasher);
        identityCache.set(block as object, identity);
      }
      return { identity, approxChars: found.result.length + ENVELOPE_CHARS };
    },
    // Keep the item shape (call_id, status, revised_prompt, saved_path) so the
    // transcript entry stays structurally valid; only the pixel payload goes.
    replace(block: unknown, text: string) {
      return { ...(block as object), result: text };
    },
    extract(block: unknown) {
      const found = matchable(block);
      if (found === null) return null;
      return { data: found.result, mediaType: found.mediaType };
    },
    replaceWithImage(block: unknown, img: StoredImage) {
      return { ...(block as object), result: img.data };
    },
  };
}
