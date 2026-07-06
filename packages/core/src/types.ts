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

export interface CascadeResult<T = unknown> {
  payload: T;
  mutated: boolean;
  telemetry: CascadeTelemetry;
}

export interface BlockMatcher {
  formatId: string;
  match(block: unknown): { identity: ImageIdentity; approxChars: number } | null;
  replace(block: unknown, text: string): unknown;
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
}
