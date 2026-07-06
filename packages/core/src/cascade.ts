import type { BlockMatcher, CascadeOptions, CascadeResult, CascadeTelemetry, ClassifyContext, ImageClass, ImageIdentity } from "./types";
import { createBuiltinMatchers } from "./blocks/create";
import { positionalStrategy } from "./classify/positionalStrategy";
import { defaultPlaceholder } from "./placeholder";

type FoundImage = {
  parent: unknown[];
  index: number;
  block: object;
  identity: ImageIdentity;
  approxChars: number;
  matcher: BlockMatcher;
  ctx: ClassifyContext;
};

type StrategyName = "positional" | "tracker" | "custom";

type StrategyWithMeta = Function & { cascadeStrategyName?: StrategyName; cascadeTracker?: { remember(hash: string, meta: { seenInUserTurn: boolean }): void } };

type CollectResult = { found: FoundImage[]; traversalTruncated: boolean };

type Decision = { klass: ImageClass; identity: ImageIdentity; placeholderText?: string };
type InternalCascadeOptions = CascadeOptions & { hasher: (data: string) => string };

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
