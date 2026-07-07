import type { BlockMatcher, CascadeAsyncOptions, CascadeOptions, CascadeResult, CascadeTelemetry, ClassifyContext, ImageClass, ImageIdentity, StoredImage, TierContext } from "./types";
import { createBuiltinMatchers } from "./blocks/create";
import { positionalStrategy } from "./classify/positionalStrategy";
import { defaultPlaceholder, restorablePlaceholder } from "./placeholder";
import { defaultTierPolicy } from "./store";

type FoundImage = {
  parent: unknown[];
  index: number;
  block: object;
  identity: ImageIdentity;
  approxChars: number;
  matcher: BlockMatcher;
  ctx: ClassifyContext;
};

type FoundImageAsync = FoundImage & { tierCtx: TierContext };

type StrategyName = "positional" | "tracker" | "custom";

type StrategyWithMeta = Function & { cascadeStrategyName?: StrategyName; cascadeTracker?: { remember(hash: string, meta: { seenInUserTurn: boolean }): void } };

type CollectResult = { found: FoundImage[]; traversalTruncated: boolean };
type CollectAsyncResult = { found: FoundImageAsync[]; traversalTruncated: boolean };

type Decision = { klass: ImageClass; identity: ImageIdentity; placeholderText?: string };
type InternalCascadeOptions = CascadeOptions & { hasher: (data: string) => string };
type InternalCascadeAsyncOptions = CascadeAsyncOptions & { hasher: (data: string) => string };
type StoreWithErrors = { __errorCount?: () => number };

const DEFAULT_MAX_NODES = 200_000;
const DEFAULT_MAX_DEPTH = 256;
const REPLACEMENT_ENVELOPE_CHARS = 32;

function clonePayload<T>(payload: T): T {
  if (typeof structuredClone === "function") return structuredClone(payload);
  return JSON.parse(JSON.stringify(payload)) as T;
}

function estimatedReplacementChars(text: string): number {
  return text.length + REPLACEMENT_ENVELOPE_CHARS;
}

function looksLikeContentArray(value: unknown[]): boolean {
  return value.some((item) => item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string");
}

function collect(root: unknown, matchers: BlockMatcher[], limits: Required<NonNullable<CascadeOptions["limits"]>>): CollectResult {
  const found: FoundImage[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let traversalTruncated = false;

  const overLimit = (depth: number): boolean => {
    if (depth > limits.maxDepth || nodes > limits.maxNodes) {
      traversalTruncated = true;
      return true;
    }
    return false;
  };

  type Frame = { value: unknown; messageIndex?: number; lastUserMessageIndex?: number; depth: number };
  const stack: Frame[] = [{ value: root, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { value, messageIndex, lastUserMessageIndex, depth } = frame;
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    nodes++;
    if (overLimit(depth)) break;

    if (Array.isArray(value)) {
      const hasMessages = value.some((item) => item && typeof item === "object" && "role" in item && "content" in item);
      if (hasMessages) {
        let arrayLastUserMessageIndex: number | undefined;
        for (let index = 0; index < value.length; index++) {
          const item = value[index];
          if (item && typeof item === "object" && (item as { role?: unknown }).role === "user") arrayLastUserMessageIndex = index;
        }
        for (let index = value.length - 1; index >= 0; index--) {
          const item = value[index];
          if (item && typeof item === "object" && "content" in item) {
            stack.push({ value: (item as { content?: unknown }).content, messageIndex: index, lastUserMessageIndex: arrayLastUserMessageIndex, depth: depth + 1 });
          }
        }
        continue;
      }

      if (looksLikeContentArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const block = value[i];
          if (!block || typeof block !== "object") continue;
          for (const matcher of matchers) {
            const match = matcher.match(block);
            if (match) {
              found.push({ parent: value, index: i, block, matcher, ...match, ctx: { messageIndex, lastUserMessageIndex } });
              break;
            }
          }
        }
      }
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], messageIndex, lastUserMessageIndex, depth: depth + 1 });
      continue;
    }

    const values = Object.values(value);
    for (let i = values.length - 1; i >= 0; i--) stack.push({ value: values[i], messageIndex, lastUserMessageIndex, depth: depth + 1 });
  }

  if (nodes > limits.maxNodes) traversalTruncated = true;
  return { found, traversalTruncated };
}

function roleSource(role: unknown): TierContext["source"] | undefined {
  if (role === "user") return "user";
  if (role === "tool") return "tool";
  return undefined;
}

function objectSource(value: object, inherited: TierContext["source"]): TierContext["source"] {
  const v = value as { role?: unknown; type?: unknown };
  if (v.type === "tool_result") return "tool";
  return roleSource(v.role) ?? inherited;
}

function collectAsync(root: unknown, matchers: BlockMatcher[], limits: Required<NonNullable<CascadeOptions["limits"]>>): CollectAsyncResult {
  const found: FoundImageAsync[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let traversalTruncated = false;
  const overLimit = (depth: number): boolean => {
    if (depth > limits.maxDepth || nodes > limits.maxNodes) {
      traversalTruncated = true;
      return true;
    }
    return false;
  };
  type Frame = { value: unknown; messageIndex?: number; lastUserMessageIndex?: number; depth: number; source: TierContext["source"]; age: number };
  const stack: Frame[] = [{ value: root, depth: 0, source: "unknown", age: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { value, messageIndex, lastUserMessageIndex, depth, source, age } = frame;
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    nodes++;
    if (overLimit(depth)) break;
    const currentSource = objectSource(value, source);
    if (Array.isArray(value)) {
      const hasMessages = value.some((item) => item && typeof item === "object" && "role" in item && "content" in item);
      if (hasMessages) {
        let arrayLastUserMessageIndex: number | undefined;
        const suffixUsers = new Array<number>(value.length).fill(0);
        let usersAfter = 0;
        for (let index = value.length - 1; index >= 0; index--) {
          suffixUsers[index] = usersAfter;
          const item = value[index];
          if (item && typeof item === "object" && (item as { role?: unknown }).role === "user") {
            if (arrayLastUserMessageIndex === undefined) arrayLastUserMessageIndex = index;
            usersAfter++;
          }
        }
        for (let index = value.length - 1; index >= 0; index--) {
          const item = value[index];
          if (item && typeof item === "object" && "content" in item) {
            const msgSource = roleSource((item as { role?: unknown }).role) ?? currentSource;
            stack.push({ value: (item as { content?: unknown }).content, messageIndex: index, lastUserMessageIndex: arrayLastUserMessageIndex, depth: depth + 1, source: msgSource, age: suffixUsers[index] ?? 0 });
          }
        }
        continue;
      }
      if (looksLikeContentArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const block = value[i];
          if (!block || typeof block !== "object") continue;
          const blockSource = objectSource(block, currentSource);
          for (const matcher of matchers) {
            const match = matcher.match(block);
            if (match) {
              found.push({ parent: value, index: i, block, matcher, ...match, ctx: { messageIndex, lastUserMessageIndex }, tierCtx: { age, source: blockSource } });
              break;
            }
          }
        }
      }
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], messageIndex, lastUserMessageIndex, depth: depth + 1, source: currentSource, age });
      continue;
    }
    const values = Object.values(value);
    for (let i = values.length - 1; i >= 0; i--) stack.push({ value: values[i], messageIndex, lastUserMessageIndex, depth: depth + 1, source: currentSource, age });
  }
  if (nodes > limits.maxNodes) traversalTruncated = true;
  return { found, traversalTruncated };
}

function strategyName(strategy: unknown): StrategyName {
  return (strategy as StrategyWithMeta).cascadeStrategyName ?? "custom";
}

function emptyTelemetry(strategy: unknown, traversalTruncated?: boolean): CascadeTelemetry {
  return {
    found: 0,
    current: 0,
    downgraded: 0,
    unknownIntact: 0,
    estimatedOriginalChars: 0,
    estimatedReplacementChars: 0,
    estimatedSavedChars: 0,
    byFormat: {},
    shortHashes: [],
    strategy: strategyName(strategy),
    ...(traversalTruncated ? { traversalTruncated: true } : {}),
  };
}

export function cascadeImages<T>(payload: T, options: InternalCascadeOptions): CascadeResult<T> {
  const target = options.clone ? clonePayload(payload) : payload;
  const strategy = options.strategy ?? positionalStrategy();
  const formats = options.formats ?? createBuiltinMatchers(options.hasher);
  const placeholder = options.placeholder ?? defaultPlaceholder;
  const limits = {
    maxNodes: options.limits?.maxNodes ?? DEFAULT_MAX_NODES,
    maxDepth: options.limits?.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
  const { found, traversalTruncated } = collect(target, formats, limits);

  if (traversalTruncated) {
    return { payload, mutated: false, telemetry: emptyTelemetry(strategy, true) };
  }

  const telemetry: CascadeTelemetry = {
    found: found.length,
    current: 0,
    downgraded: 0,
    unknownIntact: 0,
    estimatedOriginalChars: 0,
    estimatedReplacementChars: 0,
    estimatedSavedChars: 0,
    byFormat: {},
    shortHashes: [],
    strategy: strategyName(strategy),
  };

  let mutated = false;
  const decisions = new WeakMap<object, Decision>();
  for (const image of found) {
    telemetry.byFormat[image.matcher.formatId] = (telemetry.byFormat[image.matcher.formatId] ?? 0) + 1;
    telemetry.shortHashes.push(image.identity.shortHash);
    telemetry.estimatedOriginalChars += image.approxChars;

    let decision = decisions.get(image.block);
    if (!decision) {
      const klass = strategy(image.identity, image.ctx);
      decision = { klass, identity: image.identity };
      if (klass === "historical") decision.placeholderText = placeholder(image.identity, image.block);
      decisions.set(image.block, decision);
    }

    if (decision.klass === "current") {
      telemetry.current++;
      continue;
    }
    if (decision.klass === "unknown") {
      telemetry.unknownIntact++;
      (strategy as StrategyWithMeta).cascadeTracker?.remember(decision.identity.hash, { seenInUserTurn: false });
      continue;
    }
    const text = decision.placeholderText ?? placeholder(decision.identity, image.block);
    image.parent[image.index] = image.matcher.replace(image.block, text);
    telemetry.downgraded++;
    telemetry.estimatedReplacementChars += estimatedReplacementChars(text);
    mutated = true;
  }
  telemetry.estimatedSavedChars = Math.max(0, telemetry.estimatedOriginalChars - telemetry.estimatedReplacementChars);
  return { payload: target, mutated, telemetry };
}

function storeErrors(store: unknown): number {
  return typeof (store as StoreWithErrors | undefined)?.__errorCount === "function" ? (store as StoreWithErrors).__errorCount!() : 0;
}

async function safePut(store: NonNullable<CascadeAsyncOptions["store"]>, hash: string, image: StoredImage): Promise<number> {
  const before = storeErrors(store);
  try { await store.put(hash, image); } catch { return 1; }
  return Math.max(0, storeErrors(store) - before);
}

function withMeta(image: StoredImage, found: FoundImageAsync): StoredImage {
  return { ...image, meta: { ...(image.meta ?? {}), source: found.tierCtx.source, approxChars: found.approxChars, formatId: found.matcher.formatId } };
}

export async function cascadeImagesAsync<T>(payload: T, options: InternalCascadeAsyncOptions): Promise<CascadeResult<T>> {
  const target = options.clone ? clonePayload(payload) : payload;
  const strategy = options.strategy ?? positionalStrategy();
  const formats = options.formats ?? createBuiltinMatchers(options.hasher);
  const placeholder = options.placeholder ?? (options.store ? restorablePlaceholder : defaultPlaceholder);
  const tierPolicy = options.tiers ?? defaultTierPolicy();
  const limits = {
    maxNodes: options.limits?.maxNodes ?? DEFAULT_MAX_NODES,
    maxDepth: options.limits?.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
  const { found, traversalTruncated } = collectAsync(target, formats, limits);
  if (traversalTruncated) return { payload, mutated: false, telemetry: emptyTelemetry(strategy, true) };
  const telemetry: CascadeTelemetry = {
    found: found.length,
    current: 0,
    downgraded: 0,
    unknownIntact: 0,
    estimatedOriginalChars: 0,
    estimatedReplacementChars: 0,
    estimatedSavedChars: 0,
    byFormat: {},
    shortHashes: [],
    strategy: strategyName(strategy),
    ...(options.store ? { stored: 0, thumbnailed: 0, dedupedRefs: 0, storeErrors: 0 } : {}),
  };
  // First pass: classify every image so dedupe can know which hashes have a
  // current-turn original. A historical duplicate may only be replaced by a
  // reference when the original it points to is current — a historical image
  // must never survive as an original just because it is the newest duplicate.
  const decisions = new WeakMap<object, Decision>();
  const currentHashes = new Set<string>();
  for (const image of found) {
    let decision = decisions.get(image.block);
    if (!decision) {
      decision = { klass: strategy(image.identity, image.ctx), identity: image.identity };
      decisions.set(image.block, decision);
    }
    if (decision.klass === "current") currentHashes.add(image.identity.hash);
  }
  let mutated = false;
  for (const image of found) {
    telemetry.byFormat[image.matcher.formatId] = (telemetry.byFormat[image.matcher.formatId] ?? 0) + 1;
    telemetry.shortHashes.push(image.identity.shortHash);
    telemetry.estimatedOriginalChars += image.approxChars;
    if (options.store && image.matcher.extract) {
      const extracted = image.matcher.extract(image.block);
      if (extracted) {
        const errors = await safePut(options.store, image.identity.hash, withMeta(extracted, image));
        telemetry.storeErrors = (telemetry.storeErrors ?? 0) + errors;
        if (errors === 0) telemetry.stored = (telemetry.stored ?? 0) + 1;
      }
    }
    const decision = decisions.get(image.block)!;
    if (decision.klass === "current") { telemetry.current++; continue; }
    if (decision.klass === "unknown") {
      telemetry.unknownIntact++;
      (strategy as StrategyWithMeta).cascadeTracker?.remember(decision.identity.hash, { seenInUserTurn: false });
      continue;
    }
    if (options.dedupe !== false && currentHashes.has(image.identity.hash)) {
      const text = `[Image ${image.identity.shortHash} duplicate omitted; the original appears in the current turn of this payload.]`;
      image.parent[image.index] = image.matcher.replace(image.block, text);
      telemetry.dedupedRefs = (telemetry.dedupedRefs ?? 0) + 1;
      telemetry.downgraded++;
      telemetry.estimatedReplacementChars += estimatedReplacementChars(text);
      mutated = true;
      continue;
    }
    let replaced = false;
    if (tierPolicy(image.identity, image.tierCtx) === "thumbnail" && options.thumbnailer && image.matcher.extract && image.matcher.replaceWithImage) {
      const extracted = image.matcher.extract(image.block);
      if (extracted) {
        const thumb = await options.thumbnailer(withMeta(extracted, image));
        if (thumb) {
          image.parent[image.index] = image.matcher.replaceWithImage(image.block, { ...extracted, data: thumb.data, mediaType: thumb.mediaType });
          telemetry.thumbnailed = (telemetry.thumbnailed ?? 0) + 1;
          telemetry.downgraded++;
          telemetry.estimatedReplacementChars += thumb.data.length + REPLACEMENT_ENVELOPE_CHARS;
          mutated = true;
          replaced = true;
        }
      }
    }
    if (!replaced) {
      const text = placeholder(image.identity, image.block);
      image.parent[image.index] = image.matcher.replace(image.block, text);
      telemetry.downgraded++;
      telemetry.estimatedReplacementChars += estimatedReplacementChars(text);
      mutated = true;
    }
  }
  telemetry.estimatedSavedChars = Math.max(0, telemetry.estimatedOriginalChars - telemetry.estimatedReplacementChars);
  return { payload: target, mutated, telemetry };
}
