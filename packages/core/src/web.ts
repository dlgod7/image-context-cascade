import { cascadeImages as coreCascadeImages, cascadeImagesAsync as coreCascadeImagesAsync } from "./cascade";
import type { CascadeOptions, CascadeResult } from "./types";

export { defaultPlaceholder, restorablePlaceholder } from "./placeholder";
export { InMemoryTracker } from "./tracker";
export { positionalStrategy } from "./classify/positionalStrategy";
export { trackerStrategy } from "./classify/trackerStrategy";
export { createBuiltinMatchers } from "./blocks/create";
export { anthropicDocumentMatcher as createAnthropicDocumentMatcher } from "./blocks/anthropicDocument";
export { parseDataUri } from "./blocks/dataUri";
export { buildImageBlock, restoreImage } from "./restore";
export { imageIdentity } from "./identity";
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

export type WebCascadeOptions = CascadeOptions & { hasher: (data: string) => string };

export function cascadeImages<T>(payload: T, options: WebCascadeOptions): CascadeResult<T> {
  return coreCascadeImages(payload, options);
}

export function cascadeImagesAsync<T>(payload: T, options: WebCascadeOptions): Promise<CascadeResult<T>> {
  return coreCascadeImagesAsync(payload, options);
}
