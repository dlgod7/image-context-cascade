import type { SourceStore, StoredImage } from "./types";

export async function restoreImage(store: SourceStore, hash: string): Promise<StoredImage | null> {
  try { return await store.get(hash); } catch { return null; }
}

export function buildImageBlock(formatId: "anthropic" | "openai-chat" | "openai-responses", img: StoredImage): unknown {
  if (formatId === "anthropic") return { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } };
  const uri = `data:${img.mediaType};base64,${img.data}`;
  if (formatId === "openai-chat") return { type: "image_url", image_url: { url: uri } };
  return { type: "input_image", image_url: uri };
}
