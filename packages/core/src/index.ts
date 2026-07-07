import { cascadeImages as coreCascadeImages, cascadeImagesAsync as coreCascadeImagesAsync } from "./cascade";
import { createBuiltinMatchers } from "./blocks/create";
import { imageIdentity as coreImageIdentity } from "./identity";
import { sha256Hex } from "./hasherNode";
import type { CascadeOptions, CascadeResult } from "./types";

export function cascadeImages<T>(payload: T, options: CascadeOptions = {}): CascadeResult<T> {
  return coreCascadeImages(payload, { ...options, hasher: options.hasher ?? sha256Hex });
}

export function cascadeImagesAsync<T>(payload: T, options: import("./types").CascadeAsyncOptions = {}): Promise<CascadeResult<T>> {
  return coreCascadeImagesAsync(payload, { ...options, hasher: options.hasher ?? sha256Hex });
}

export function imageIdentity(data: string, hasher: (data: string) => string = sha256Hex) {
  return coreImageIdentity(data, hasher);
}

export { sha256Hex };
export const builtinMatchers = createBuiltinMatchers(sha256Hex);
export const anthropicMatcher = builtinMatchers[0]!;
export const anthropicDocumentMatcher = builtinMatchers[1]!;
export const openaiChatMatcher = builtinMatchers[2]!;
export const openaiResponsesMatcher = builtinMatchers[3]!;

export { defaultPlaceholder, restorablePlaceholder } from "./placeholder";
export { InMemoryTracker } from "./tracker";
export { positionalStrategy } from "./classify/positionalStrategy";
export { trackerStrategy } from "./classify/trackerStrategy";
export { createBuiltinMatchers } from "./blocks/create";
export { anthropicDocumentMatcher as createAnthropicDocumentMatcher } from "./blocks/anthropicDocument";
export { parseDataUri } from "./blocks/dataUri";
export { defaultTierPolicy, fsSourceStore } from "./store";
export { buildImageBlock, restoreImage } from "./restore";
export type {
  BlockMatcher,
  CascadeAsyncOptions,
  CascadeOptions,
  CascadeResult,
  CascadeTelemetry,
  ClassifyContext,
  ClassifyStrategy,
  ImageClass,
  ImageIdentity,
  ImageTracker,
  SourceStore,
  StoredImage,
  Thumbnailer,
  TierContext,
  TierPolicy,
} from "./types";
