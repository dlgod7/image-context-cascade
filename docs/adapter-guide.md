# Adapter Guide

## Goal

An adapter connects an agent host to `image-context-cascade` without reimplementing the cascade logic.

The adapter should be small.

It should call the core at provider-request time, forward the returned payload when mutated, and send telemetry to the host's normal logging surface.

The Pi reference adapter in `packages/adapters/pi/src/index.ts` is the model: framework glue around the core, not a fork of the core.

## What the core owns

The core owns image matching, traversal, classification, placeholder generation, identity, and telemetry structure.

Use these exported APIs instead of copying behavior:

- `cascadeImages<T>(payload: T, options?: CascadeOptions): CascadeResult<T>`
- `positionalStrategy(): ClassifyStrategy`
- `trackerStrategy(opts: { currentTurnHashes: ReadonlySet<string>; tracker: ImageTracker }): ClassifyStrategy`
- `InMemoryTracker`
- `builtinMatchers`
- `createBuiltinMatchers(hasher: (data: string) => string): BlockMatcher[]`
- `imageIdentity(data: string, hasher?: (data: string) => string): ImageIdentity`
- `defaultPlaceholder(id: ImageIdentity): string`

The main package entry supplies Node SHA-256 by default.

The `image-context-cascade/web` entry requires a caller-supplied synchronous `hasher` option.

## What the adapter owns

The adapter owns host integration:

- finding the hook that runs immediately before a provider request is sent;
- passing that provider payload to `cascadeImages`;
- returning or forwarding `result.payload` when `result.mutated` is true;
- deciding where to log `result.telemetry`;
- optionally collecting current-turn image hashes for tracker mode;
- optionally adding host-specific user guidance, such as asking the model to summarize a newly attached image.

Do not add network calls or image storage unless your host explicitly needs that feature.

The base adapter should only remove historical image bytes from the outgoing request.

## Minimal adapter: positional strategy

If your host exposes only a request-construction hook, use the default positional strategy.

This is the smallest safe adapter.

It is stateless, restart-safe, and works when the payload has a message array with user-role boundaries.

```ts
import {
  cascadeImages,
  type CascadeTelemetry,
} from "image-context-cascade";

type Host = {
  on(name: "beforeProviderRequest", cb: (event: { payload: unknown }) => unknown): void;
  on(name: "afterProviderResponse", cb: (event: { status?: number }) => void): void;
  log(name: string, value: unknown): void;
};

export function installImageContextCascade(host: Host): void {
  let pendingTelemetry: CascadeTelemetry | null = null;

  host.on("beforeProviderRequest", (event) => {
    const result = cascadeImages(event.payload);
    pendingTelemetry = result.telemetry;

    if (result.mutated) {
      return result.payload;
    }

    return undefined;
  });

  host.on("afterProviderResponse", (event) => {
    if (!pendingTelemetry) {
      return;
    }

    host.log("image-context-cascade.telemetry", {
      ...pendingTelemetry,
      status: event.status,
    });

    pendingTelemetry = null;
  });
}
```

This example is intentionally plain.

It relies on `cascadeImages` defaults: built-in matchers, `positionalStrategy()`, default placeholders, in-place mutation, and defensive traversal limits.

If your host expects immutable payloads, pass `{ clone: true }`.

## Tracker adapter pattern

Use tracker mode when your host can reliably list the images attached to the current turn.

The Pi adapter uses this shape:

```ts
import {
  builtinMatchers,
  cascadeImages,
  InMemoryTracker,
  trackerStrategy,
  type CascadeTelemetry,
} from "image-context-cascade";

type Host = {
  on(name: "turnStart", cb: (event: { images?: unknown[] }) => unknown): void;
  on(name: "beforeProviderRequest", cb: (event: { payload: unknown }) => unknown): void;
  on(name: "afterProviderResponse", cb: (event: { status?: number }) => void): void;
  log(name: string, value: unknown): void;
};

export function installImageContextCascadeWithTracker(host: Host): void {
  const tracker = new InMemoryTracker();
  let currentTurnHashes = new Set<string>();
  let pendingTelemetry: CascadeTelemetry | null = null;

  host.on("turnStart", (event) => {
    currentTurnHashes = new Set<string>();

    for (const image of event.images ?? []) {
      for (const matcher of builtinMatchers) {
        const match = matcher.match(image);
        if (!match) continue;
        currentTurnHashes.add(match.identity.hash);
        tracker.remember(match.identity.hash, { seenInUserTurn: true });
        break;
      }
    }
  });

  host.on("beforeProviderRequest", (event) => {
    const result = cascadeImages(event.payload, {
      strategy: trackerStrategy({ currentTurnHashes, tracker }),
    });

    pendingTelemetry = result.telemetry;
    if (result.mutated) return result.payload;
  });

  host.on("afterProviderResponse", (event) => {
    if (!pendingTelemetry) return;
    host.log("image-context-cascade.telemetry", {
      ...pendingTelemetry,
      status: event.status,
    });
    pendingTelemetry = null;
  });
}
```

Tracker mode preserves INV-1 and INV-2 from `docs/pattern.md` by construction.

Images explicitly present in `currentTurnHashes` are current.

Unrecognized images pass through as `unknown` once before becoming eligible for downgrade.

## Choosing positional or tracker

Use positional mode when:

- the payload has normal `messages` arrays with `role: "user"` boundaries;
- you want zero state;
- your adapter may restart frequently;
- you are building a request proxy.

Use tracker mode when:

- the host has a turn-start hook with current attachments;
- transcripts may be edited out of band;
- you need per-image lifecycle control later;
- you prefer unknown-intact-once behavior over positional inference.

Both modes should satisfy INV-1, INV-2, INV-3, INV-5, INV-8, and INV-12 from `docs/pattern.md`.

## Extending `BlockMatcher` for a new provider format

A provider format is supported by adding a `BlockMatcher`.

The interface is:

```ts
export interface BlockMatcher {
  formatId: string;
  match(block: unknown): { identity: ImageIdentity; approxChars: number } | null;
  replace(block: unknown, text: string): unknown;
}
```

Follow these steps.

### Step 1: identify the exact image block shape

Use provider documentation and real payload fixtures.

Do not match broad object patterns.

Require the provider's exact `type` field and the exact string fields that carry image bytes or image URLs.

Malformed blocks should return `null`, not throw.

This protects INV-7.

### Step 2: choose the identity input

For base64 data URI payloads, hash the base64 portion, not the whole data URI wrapper.

For raw base64 fields, hash the raw base64 string.

For remote image URLs, hash the URL string unless your host has already resolved the bytes.

If you need the built-in data URI parser, use `parseDataUri(uri: string)`.

### Step 3: compute identity with the core helper

In Node entry code, use `imageIdentity(data)`.

Inside matcher factories, accept a hasher and call `imageIdentity(data, hasher)` so web and edge runtimes can supply their own synchronous hash.

The built-in factory follows this pattern through `createBuiltinMatchers(hasher)`.

### Step 4: estimate original size cheaply

Return `approxChars` without serializing the whole block.

Use the image string length plus a small fixed envelope estimate.

Telemetry savings are estimates, not billing-grade accounting.

They should be directionally useful and cheap to compute.

### Step 5: replace with a valid text block for the same provider

`replace(block, text)` must return a block accepted by the provider in the same content array position.

Anthropic and OpenAI Chat use `{ type: "text", text }`.

OpenAI Responses uses `{ type: "input_text", text }`.

Your provider may use another text-block tag.

This protects INV-12.

### Step 6: pass the matcher to `cascadeImages`

```ts
const result = cascadeImages(payload, {
  formats: [...createBuiltinMatchers(sha256Hex), myProviderMatcher],
});
```

If you do not need the built-ins, pass only your matcher.

Do not edit traversal logic just to add a provider format.

### Step 7: add corpus fixtures

Add at least one historical/current fixture under `packages/conformance/corpus/` or your adapter's equivalent test directory.

Include expected counts for `current`, `downgraded`, and `unknownIntact`.

Add a near-miss fixture for malformed blocks if your format is easy to confuse with text blocks.

## Running conformance

From the repository root:

```bash
bun test
bun run typecheck
```

The test suite includes the conformance suite and the corpus runner.

The corpus currently covers:

- Anthropic positional historical downgrade.
- OpenAI Chat positional historical downgrade.
- OpenAI Responses positional historical downgrade.
- A no-image payload.
- Tracker current-hash retention.
- A nested-boundary regression.

Adapter authors can also call the conformance API directly:

```ts
import { runConformance } from "image-context-cascade-conformance";
import { myAdapterHarness } from "./my-adapter-harness";

const result = await runConformance(myAdapterHarness);
if (!result.passed) {
  throw new Error(result.checks.join("\n"));
}
```

A harness implements the adapter-facing shape expected by the conformance package:

```ts
export interface AdapterHarness {
  name: string;
  runTwoTurnImageRequest(payloads: { first: unknown; second: unknown }):
    Promise<{ firstPayload: unknown; secondPayload: unknown; telemetry: unknown[] }> |
    { firstPayload: unknown; secondPayload: unknown; telemetry: unknown[] };
}
```

The reference harness verifies current retention, historical downgrade, and telemetry privacy.

## Telemetry handling

`CascadeTelemetry` is safe to log by design.

It includes counts, estimated character savings, `byFormat`, `shortHashes`, `strategy`, and optional `traversalTruncated`.

It does not include image bytes.

Still, keep telemetry inside your normal application telemetry boundary.

Do not append full payloads to debug logs while testing this adapter.

A host that logs the full pre-cascade payload can still leak image data; the library cannot prevent that.

## Common mistakes

Do not run cascade after sending the request.

Do not run it only during transcript compaction.

Do not classify by message count alone if the host can insert old tool transcripts after the latest user message.

Do not use unstable placeholders such as `Image from 3 turns ago`.

Do not store base64 in telemetry to make debugging easier.

Do not fork the built-in traversal for every provider.

Do not silently downgrade when traversal reports `traversalTruncated`.

Do not violate INV-1, INV-2, INV-3, INV-5, INV-7, or INV-10 from `docs/pattern.md` while chasing larger savings.

## Release checklist for an adapter

Before proposing an adapter, verify the following:

- It calls `cascadeImages` at the last hook before provider send.
- It forwards `result.payload` when `result.mutated` is true.
- It logs `result.telemetry`, not the full provider payload.
- It uses `positionalStrategy()` or `trackerStrategy({ currentTurnHashes, tracker })` rather than custom classification unless there is a documented reason.
- It imports `builtinMatchers` or `createBuiltinMatchers` rather than copying built-in matcher logic.
- It keeps current-turn images intact in a manual smoke test.
- It passes `bun test` and `bun run typecheck`.
- It passes `runConformance` if it lives outside the repository's existing tests.

## Instructions for AI implementers

Implement an adapter for the target agent by calling `cascadeImages<T>(payload: T, options?: CascadeOptions): CascadeResult<T>` at the last hook before the provider request is sent. Use the default `positionalStrategy()` unless the host exposes exact current-turn image attachments; in that case create one `InMemoryTracker`, collect current image hashes with `builtinMatchers` or `imageIdentity`, and pass `trackerStrategy({ currentTurnHashes, tracker })`. Forward `result.payload` only when `result.mutated` is true, and log only `result.telemetry`. If adding a provider format, implement a `BlockMatcher` with `match(block)` and `replace(block, text)`, then pass it through `formats`; do not rewrite traversal. Required acceptance commands are `bun test` and `bun run typecheck`, plus an adapter harness using `runConformance` from `image-context-cascade-conformance` when the adapter lives outside the core tests. Do not reimplement matcher behavior already covered by `builtinMatchers`, placeholder generation, image classification, identity hashing, traversal, telemetry fields, or the current/unknown/historical safety rules; import the core APIs instead.

## Summary

A good adapter is thin.

It connects host hooks to the core, preserves current images, downgrades historical images, logs safe telemetry, and lets conformance tests catch drift.

If the adapter starts copying matcher, placeholder, classification, or traversal code, stop and move that behavior back behind the core API.
