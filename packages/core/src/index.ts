import { cascadeImages as coreCascadeImages } from "./cascade";
import { createBuiltinMatchers } from "./blocks/create";
import { imageIdentity as coreImageIdentity } from "./identity";
import { sha256Hex } from "./hasherNode";
import type { CascadeOptions, CascadeResult } from "./types";

export function cascadeImages<T>(payload: T, options: CascadeOptions = {}): CascadeResult<T> {
  return coreCascadeImages(payload, { ...options, hasher: options.hasher ?? sha256Hex });
}

export function imageIdentity(data: string, hasher: (data: string) => string = sha256Hex) {
  return coreImageIdentity(data, hasher);
}

export { sha256Hex };
export const builtinMatchers = createBuiltinMatchers(sha256Hex);
export const anthropicMatcher = builtinMatchers[0]!;
export const openaiChatMatcher = builtinMatchers[1]!;
export const openaiResponsesMatcher = builtinMatchers[2]!;

export { defaultPlaceholder } from "./placeholder";
export { InMemoryTracker } from "./tracker";
export { positionalStrategy } from "./classify/positionalStrategy";
export { trackerStrategy } from "./classify/trackerStrategy";
export { createBuiltinMatchers } from "./blocks/create";
export { parseDataUri } from "./blocks/dataUri";
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
