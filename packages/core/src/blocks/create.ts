import type { BlockMatcher, ImageIdentity, StoredImage } from "../types";
import { imageIdentity } from "../identity";
import { imageIdentityInputFromUri, parseDataUri } from "./dataUri";
import { anthropicDocumentMatcher } from "./anthropicDocument";

const ENVELOPE_CHARS = 96;

function estimateImageBlockChars(dataOrUrl: string): number {
  return dataOrUrl.length + ENVELOPE_CHARS;
}

function validDataOrUrl(raw: string): string | null {
  if (raw.length === 0) return null;
  if (raw.startsWith("data:")) {
    const parsed = parseDataUri(raw);
    if (!parsed || parsed.base64.length === 0) return null;
  }
  return imageIdentityInputFromUri(raw);
}

function storedFromUri(raw: string): StoredImage | null {
  const parsed = parseDataUri(raw);
  if (parsed) return { data: parsed.base64, mediaType: parsed.mimeType };
  // http(s)/file references carry no payload bytes — there is nothing to store,
  // and storing the URL string as base64 would corrupt a later restore.
  return null;
}

function dataUri(img: StoredImage): string {
  return `data:${img.mediaType};base64,${img.data}`;
}

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

export function createBuiltinMatchers(hasher: (data: string) => string): BlockMatcher[] {
  const identityCache = new WeakMap<object, ImageIdentity>();
  return [
    {
      formatId: "anthropic",
      match(block: unknown) {
        if (!block || typeof block !== "object") return null;
        const b = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } };
        if (b.type !== "image" || b.source?.type !== "base64" || typeof b.source.data !== "string" || b.source.data.length === 0) return null;
        return { identity: cachedIdentity(identityCache, block, b.source.data, hasher), approxChars: estimateImageBlockChars(b.source.data) };
      },
      replace(_block: unknown, text: string) { return { type: "text", text }; },
      extract(block: unknown) {
        if (!block || typeof block !== "object") return null;
        const b = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } };
        if (b.type !== "image" || b.source?.type !== "base64" || typeof b.source.data !== "string" || b.source.data.length === 0) return null;
        return { data: b.source.data, mediaType: typeof b.source.media_type === "string" ? b.source.media_type : "application/octet-stream" };
      },
      replaceWithImage(_block: unknown, img: StoredImage) { return { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } }; },
    },
    anthropicDocumentMatcher(hasher),
    {
      formatId: "openai-chat",
      match(block: unknown) {
        if (!block || typeof block !== "object") return null;
        const b = block as { type?: unknown; image_url?: unknown };
        if (b.type !== "image_url") return null;
        const raw = typeof b.image_url === "string" ? b.image_url :
          (b.image_url && typeof b.image_url === "object" ? (b.image_url as { url?: unknown }).url : undefined);
        if (typeof raw !== "string") return null;
        const input = validDataOrUrl(raw);
        if (input === null) return null;
        return { identity: cachedIdentity(identityCache, block, input, hasher), approxChars: estimateImageBlockChars(raw) };
      },
      replace(_block: unknown, text: string) { return { type: "text", text }; },
      extract(block: unknown) {
        if (!block || typeof block !== "object") return null;
        const b = block as { type?: unknown; image_url?: unknown };
        if (b.type !== "image_url") return null;
        const raw = typeof b.image_url === "string" ? b.image_url :
          (b.image_url && typeof b.image_url === "object" ? (b.image_url as { url?: unknown }).url : undefined);
        if (typeof raw !== "string") return null;
        return storedFromUri(raw);
      },
      replaceWithImage(block: unknown, img: StoredImage) {
        const raw = block && typeof block === "object" ? (block as { image_url?: unknown }).image_url : undefined;
        return { type: "image_url", image_url: raw && typeof raw === "object" ? { ...(raw as object), url: dataUri(img) } : dataUri(img) };
      },
    },
    {
      formatId: "openai-responses",
      match(block: unknown) {
        if (!block || typeof block !== "object") return null;
        const b = block as { type?: unknown; image_url?: unknown };
        if (b.type !== "input_image" || typeof b.image_url !== "string") return null;
        const input = validDataOrUrl(b.image_url);
        if (input === null) return null;
        return { identity: cachedIdentity(identityCache, block, input, hasher), approxChars: estimateImageBlockChars(b.image_url) };
      },
      replace(_block: unknown, text: string) { return { type: "input_text", text }; },
      extract(block: unknown) {
        if (!block || typeof block !== "object") return null;
        const b = block as { type?: unknown; image_url?: unknown };
        if (b.type !== "input_image" || typeof b.image_url !== "string") return null;
        return storedFromUri(b.image_url);
      },
      replaceWithImage(_block: unknown, img: StoredImage) { return { type: "input_image", image_url: dataUri(img) }; },
    },
  ];
}
