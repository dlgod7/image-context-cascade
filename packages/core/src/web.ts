import { cascadeImages as coreCascadeImages } from "./cascade";
import type { CascadeOptions, CascadeResult } from "./types";

export { defaultPlaceholder } from "./placeholder";
export { InMemoryTracker } from "./tracker";
export { positionalStrategy } from "./classify/positionalStrategy";
export { trackerStrategy } from "./classify/trackerStrategy";
export { createBuiltinMatchers } from "./blocks/create";
export { anthropicDocumentMatcher as createAnthropicDocumentMatcher } from "./blocks/anthropicDocument";
export { parseDataUri } from "./blocks/dataUri";
export { imageIdentity } from "./identity";
export type {
  BlockMatcher,
  CascadeOptions,
  CascadeResult,
  CascadeTelemetry,
  ClassifyContext,
  ClassifyStrategy,
  ImageClass,
  ImageIdentity,
  ImageTracker,
} from "./types";

export type WebCascadeOptions = CascadeOptions & { hasher: (data: string) => string };

export function cascadeImages<T>(payload: T, options: WebCascadeOptions): CascadeResult<T> {
  return coreCascadeImages(payload, options);
}
