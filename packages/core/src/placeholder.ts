import type { ImageIdentity } from "./types";

export function defaultPlaceholder(id: ImageIdentity): string {
  return `[Image ${id.shortHash} omitted from this provider request: it appeared in an earlier turn. Use the prior image summary in the conversation unless the user explicitly asks to inspect the original image again.]`;
}
