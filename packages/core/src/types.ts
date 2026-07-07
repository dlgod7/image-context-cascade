export interface ImageIdentity {
  hash: string;
  shortHash: string;
}

export type ImageClass = "current" | "historical" | "unknown";

export interface ClassifyContext {
  messageIndex?: number;
  lastUserMessageIndex?: number;
}

export type ClassifyStrategy = (
  identity: ImageIdentity,
  ctx: ClassifyContext,
) => ImageClass;

export interface ImageTracker {
  has(hash: string): boolean;
  remember(hash: string, meta: { seenInUserTurn: boolean }): void;
  size(): number;
}

export interface StoredImage {
  data: string;
  mediaType: string;
  meta?: { source?: "user" | "tool" | "unknown"; approxChars?: number; formatId?: string };
}

export interface SourceStore {
  put(hash: string, image: StoredImage): Promise<void>;
  get(hash: string): Promise<StoredImage | null>;
  has(hash: string): Promise<boolean>;
  /** Resolve a hash prefix (e.g. the 12-char shortHash from a placeholder) to the unique full hash; null when absent or ambiguous. */
  resolve?(prefix: string): Promise<string | null>;
}

export type Thumbnailer = (image: StoredImage) => Promise<{ data: string; mediaType: string } | null>;

export interface TierContext { age: number; source: "user" | "tool" | "unknown" }
export type TierPolicy = (id: ImageIdentity, ctx: TierContext) => "thumbnail" | "placeholder";

export interface CascadeOptions {
  strategy?: ClassifyStrategy;
  formats?: BlockMatcher[];
  placeholder?: (id: ImageIdentity, block: unknown) => string;
  clone?: boolean;
  hasher?: (data: string) => string;
  limits?: {
    maxNodes?: number;
    maxDepth?: number;
  };
}

export interface CascadeAsyncOptions extends CascadeOptions {
  store?: SourceStore;
  thumbnailer?: Thumbnailer;
  tiers?: TierPolicy;
  dedupe?: boolean;
}

export interface CascadeResult<T = unknown> {
  payload: T;
  mutated: boolean;
  telemetry: CascadeTelemetry;
}

export interface BlockMatcher {
  formatId: string;
  match(block: unknown): { identity: ImageIdentity; approxChars: number } | null;
  replace(block: unknown, text: string): unknown;
  extract?(block: unknown): StoredImage | null;
  replaceWithImage?(block: unknown, img: StoredImage): unknown;
}

export interface CascadeTelemetry {
  found: number;
  current: number;
  downgraded: number;
  unknownIntact: number;
  estimatedOriginalChars: number;
  estimatedReplacementChars: number;
  estimatedSavedChars: number;
  byFormat: Record<string, number>;
  shortHashes: string[];
  strategy: "positional" | "tracker" | "custom";
  traversalTruncated?: boolean;
  stored?: number;
  thumbnailed?: number;
  dedupedRefs?: number;
  storeErrors?: number;
}
