import type { BlockMatcher, ImageIdentity, StoredImage } from "../types";
import { imageIdentity } from "../identity";

const ENVELOPE_CHARS = 96;

// Codex persists image-generation tool output as a *bare* base64 string in
// `result` (no data: prefix), duplicated across `image_generation_call`
// response items and `image_generation_end` event messages. A single
// generated image can add ~3 MB per copy to the session file.
const MIN_RESULT_CHARS = 256;

// A bare string carries no structural marker saying "this is an image", so
// content sniffing is the only safe gate: without it, any long text sitting in
// a `result` field would be destroyed. Magic bytes are checked on *decoded*
// bytes (not base64 prefixes) so byte alignment can never hide a match. SVG is
// deliberately excluded: it is XML text with no magic, and sniffing `<svg`
// would misfire on ordinary XML tool output. Structured blocks (Anthropic
// image/document, OpenAI image_url / input_image) are format-agnostic and do
// not pass through this gate.
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i++) B64_INDEX[B64_ALPHABET[i]!] = i;

function decodeBase64Head(base64: string, maxBytes: number): Uint8Array {
  const out = new Uint8Array(maxBytes);
  let outLen = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < base64.length && outLen < maxBytes; i++) {
    const v = B64_INDEX[base64[i]!];
    if (v === undefined) break;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outLen++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outLen);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

const ISO_BMFF_BRANDS: Record<string, string> = {
  avif: "image/avif",
  avis: "image/avif",
  heic: "image/heic",
  heix: "image/heic",
  hevc: "image/heic",
  heif: "image/heif",
  mif1: "image/heif",
};

function sniffMediaType(base64: string): string | null {
  const b = decodeBase64Head(base64, 16);
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(b, 0, 4) === "GIF8") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return "image/tiff";
  if (ascii(b, 4, 8) === "ftyp") return ISO_BMFF_BRANDS[ascii(b, 8, 12)] ?? null;
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
