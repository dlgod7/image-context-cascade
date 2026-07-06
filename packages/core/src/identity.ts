import type { ImageIdentity } from "./types";

export const HASH_PREFIX_LEN = 12;

export function imageIdentity(data: string, hasher: (data: string) => string): ImageIdentity {
  const hash = hasher(data);
  return { hash, shortHash: hash.slice(0, HASH_PREFIX_LEN) };
}
