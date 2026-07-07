import type { BlockMatcher, ImageIdentity } from "../types";
import { imageIdentity } from "../identity";

const ENVELOPE_CHARS = 96;

function cachedIdentity(
  cache: WeakMap<object, ImageIdentity>,
  block: object,
  data: string,
  hasher: (data: string) => string,
): ImageIdentity {
  const cached = cache.get(block);
  if (cached) return cached;
  const identity = imageIdentity(data, hasher);
  cache.set(block, identity);
  return identity;
}

export function anthropicDocumentMatcher(hasher: (data: string) => string): BlockMatcher {
  const identityCache = new WeakMap<object, ImageIdentity>();
  return {
    formatId: "anthropic-document",
    match(block: unknown) {
      if (!block || typeof block !== "object") return null;
      const b = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } };
      if (b.type !== "document" || b.source?.type !== "base64" || typeof b.source.data !== "string" || b.source.data.length === 0) return null;
      return { identity: cachedIdentity(identityCache, block, b.source.data, hasher), approxChars: b.source.data.length + ENVELOPE_CHARS };
    },
    replace(_block: unknown, text: string) { return { type: "text", text }; },
    extract(block: unknown) {
      if (!block || typeof block !== "object") return null;
      const b = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } };
      if (b.type !== "document" || b.source?.type !== "base64" || typeof b.source.data !== "string" || b.source.data.length === 0) return null;
      return { data: b.source.data, mediaType: typeof b.source.media_type === "string" ? b.source.media_type : "application/octet-stream" };
    },
    // No replaceWithImage: Anthropic document blocks are not image blocks, and thumbnailing PDFs is host-specific.
  };
}
