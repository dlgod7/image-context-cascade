import type { ImageIdentity } from "./types";

export function defaultPlaceholder(id: ImageIdentity, block?: unknown): string {
  if (block && typeof block === "object" && (block as { type?: unknown }).type === "document") {
    return `[Document ${id.shortHash} omitted from this provider request: it appeared in an earlier turn. Use the prior document summary in the conversation unless the user explicitly asks to inspect the original document again.]`;
  }
  return `[Image ${id.shortHash} omitted from this provider request: it appeared in an earlier turn. Use the prior image summary in the conversation unless the user explicitly asks to inspect the original image again.]`;
}

export function restorablePlaceholder(id: ImageIdentity, block?: unknown): string {
  if (block && typeof block === "object" && (block as { type?: unknown }).type === "document") {
    return `[Document ${id.shortHash} omitted; restorable via image-cascade restore ${id.shortHash}.]`;
  }
  return `[Image ${id.shortHash} omitted; restorable via image-cascade restore ${id.shortHash}.]`;
}
