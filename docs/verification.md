# Verification

## Purpose

This document explains how to reproduce the numbers and safety claims in the README.

It covers synthetic payload generation, tests, benchmarks, the 10k-image benchmark, the 1.3 MB image reduction check, and telemetry-based verification inside an adapter.

The commands assume the repository root is the current working directory.

No command requires real user images.

Use synthetic payloads for repeatable verification.

## Requirements

Install the project dependencies with your normal package-manager workflow for this repository.

The checked-in scripts use Bun and TypeScript.

The root scripts are:

```bash
bun test
bun run typecheck
```

`bun test` runs the core tests and the conformance tests.

`bun run typecheck` runs `tsc --noEmit -p tsconfig.json`.

## What is verified by tests

The test suite covers the important pattern invariants from `docs/pattern.md`:

- INV-1: current-turn images are never touched.
- INV-2: unknown images fail open in tracker mode.
- INV-3: placeholders are deterministic and snapshot-locked.
- INV-5: telemetry does not contain image data.
- INV-7: malformed and near-miss blocks are not matched.
- INV-8: cascade is idempotent.
- INV-9: duplicate block references classify consistently.
- INV-10: traversal limits fail open.
- INV-12: replacements use provider-valid text block shapes.

It also covers Node SHA-256 known vectors and the web-entry dependency boundary.

## Running the standard validation

Run:

```bash
bun test
bun run typecheck
```

Expected result for a healthy checkout is zero test failures and zero TypeScript errors.

The exact number of tests may change as the project grows.

The BUILD-REPORT snapshot for the B1 hardening batch recorded:

- `bun test`: 32 pass / 0 fail / 1 snapshot / 88 expect calls across 2 files.
- `bun run typecheck`: completed with zero TypeScript errors.
- final 10k-image benchmark: `benchmark_10k_images_under_2s elapsed_ms=39.48`.

Do not treat the exact elapsed time as a promise.

Use it as reproduction evidence for the README's measured benchmark claim on the recorded run.

## Synthetic payload generation method

Tests generate image payloads from base64 strings, not real images.

The helper pattern is:

```ts
const b64 = (label: string, bytes = 32) =>
  Buffer.from(`${label}:${"x".repeat(bytes)}`).toString("base64");

const uri = (data: string) => `data:image/png;base64,${data}`;

const anthropic = (data: string) => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
});

const responses = (data: string) => ({
  type: "input_image",
  image_url: uri(data),
});
```

This is enough because the cascade operates on payload bytes and provider block shapes.

It does not decode PNG pixels.

The byte-reduction behavior is driven by string size, not by image semantics.

## Reproducing the 10k-image benchmark

The core test named `benchmark_10k_images_under_2s` constructs 10,000 small Anthropic-style image blocks.

It places them in an older user message and adds a later user message as the positional current boundary.

Then it calls `cascadeImages(p)` and measures elapsed time with `performance.now()`.

Run:

```bash
bun test packages/core/test/cascade.test.ts -t benchmark_10k_images_under_2s
```

A passing run must finish under the test threshold of 2 seconds and downgrade 10,000 images.

The B1 BUILD-REPORT recorded the final run as:

```text
benchmark_10k_images_under_2s elapsed_ms=39.48
```

Earlier in the same hardening batch, before the hasher layering rework restored native Node hashing, a run recorded 116.44 ms.

Use 39.48 ms when quoting the final measured number from BUILD-REPORT.

Do not round it into a throughput guarantee.

## Reproducing the 1.3 MB reduction check

The README reports a real 1.3 MB PNG payload reduction of 1,296,014 chars to 315 chars, or -99.98%.

That exact pair is recorded project evidence and should not be regenerated from a different synthetic string and presented as the same measurement.

The repository test `large_payload_reduction_benchmark` verifies the same class of behavior synthetically.

Run:

```bash
bun test packages/core/test/cascade.test.ts -t large_payload_reduction_benchmark
```

The test creates a large base64-like payload, places it in a historical OpenAI Responses `input_image` block, keeps a tiny current image, and asserts the post-cascade payload is reduced by more than 99.9%.

For an explicit local reproduction of the README arithmetic using the recorded numbers:

```bash
bun -e 'const before=1296014, after=315; console.log(`${before} -> ${after}; saved=${before-after}; reduction=${((1-after/before)*100).toFixed(2)}%`)'
```

Expected output:

```text
1296014 -> 315; saved=1295699; reduction=99.98%
```

If you create your own synthetic 1.3 MB payload, the exact before and after character counts will differ because JSON envelope size, provider format, and placeholder envelope differ.

That is fine for local verification.

Do not replace the README number unless you have a new measured real payload and record the method.

## Inspecting placeholder stability

Run:

```bash
bun test packages/core/test/cascade.test.ts -t placeholder_snapshot_frozen
```

The snapshot pins the default placeholder text.

The default is generated by `defaultPlaceholder(id: ImageIdentity): string`.

For the same `shortHash`, it must remain byte-stable unless a deliberate breaking change is documented.

This supports prompt-cache stability and INV-3 from `docs/pattern.md`.

## Inspecting telemetry privacy

Run:

```bash
bun test packages/core/test/cascade.test.ts -t telemetry_never_contains_base64
bun test packages/core/test/cascade.test.ts -t telemetry_size_bounded
```

The first test serializes telemetry and asserts it does not contain `data:image` or long base64-like strings.

The second test checks serialized telemetry remains bounded even for many images.

Telemetry should answer operational questions without becoming a copy of the payload.

## Running the conformance corpus

Run:

```bash
bun test packages/conformance/src/suite.test.ts
```

The corpus runner loads JSON cases from `packages/conformance/corpus/`.

Current corpus cases include:

- `anthropic_positional_historical.json`
- `openai_chat_positional_historical.json`
- `openai_responses_positional_historical.json`
- `no_image_payload.json`
- `tracker_current_hash_retained.json`
- `nested_boundary_regression.json`

The corpus asserts expected mutation status and telemetry counts.

It also checks that downgraded placeholders are stable when applicable.

## Verifying a new adapter

A new adapter should pass both project validation and an adapter harness.

Use `runConformance(adapterHarness)` from `@image-cascade/conformance`.

The harness should simulate two turns:

1. first request with a current image;
2. second request where the same image is historical and a later user message is current text.

The conformance suite checks:

- first payload still contains the current image;
- second payload contains the default historical placeholder;
- serialized telemetry does not contain a `data:image` URI.

Also run:

```bash
bun test
bun run typecheck
```

If the adapter is in another repository, run its native test command plus the conformance harness.

## Using telemetry in your own agent

Log only `CascadeTelemetry`.

For each provider request, inspect:

- `found`
- `current`
- `downgraded`
- `unknownIntact`
- `estimatedOriginalChars`
- `estimatedReplacementChars`
- `estimatedSavedChars`
- `byFormat`
- `strategy`
- `traversalTruncated`

A healthy positional integration with historical images should show `downgraded > 0` and positive `estimatedSavedChars`.

A first-turn request with only new images should usually show `current > 0` and `downgraded === 0`.

A tracker integration after restart may show `unknownIntact > 0` for images that the tracker has not yet seen.

That is a safe fail-open result.

If `traversalTruncated === true`, treat savings as unavailable for that request and inspect payload size or traversal limits.

The core returns the original payload unmodified in that case.

## Example telemetry sanity check

A simple adapter-side check can be:

```ts
const { payload, mutated, telemetry } = cascadeImages(requestPayload);

if (telemetry.traversalTruncated) {
  host.log("image-context-cascade.warning", telemetry);
} else if (telemetry.found > 0) {
  host.log("image-context-cascade.telemetry", telemetry);
}

send(mutated ? payload : requestPayload);
```

Do not log `requestPayload` to prove savings.

Use `estimatedOriginalChars`, `estimatedReplacementChars`, and `estimatedSavedChars`.

This validates savings without violating INV-5 from `docs/pattern.md`.

## Verifying savings against provider usage

Provider token accounting differs by model and API.

The library reports character estimates, not provider bills.

To verify end-to-end savings in your own agent:

1. Log `CascadeTelemetry` per request.
2. Log provider usage fields from the provider response, if available.
3. Compare requests with similar text history before and after enabling cascade.
4. Check that `estimatedSavedChars` rises when historical images exist.
5. Check that input tokens or request body size fall in the same direction.
6. Check that prompt-cache reads recover or remain stable when using stable placeholders.

Do not expect a universal chars-to-tokens conversion.

The README's live-session numbers are measured evidence for that session, not a billing formula.

## Reproducing the README live-session numbers

The README includes these measured values:

- four historical images saved about 4.17M chars per request;
- input tokens fell from 91,734 to 1,910;
- cache reads recovered from 11,776 to 100,352.

Those numbers require the original live session and provider usage records.

They are not part of the public synthetic corpus.

To reproduce an equivalent result in your environment, use the telemetry workflow above and record your own before/after provider usage.

Do not claim the same token counts unless you are measuring the same payload and provider accounting path.

## Validating web or edge usage

The web entry does not import Node crypto.

Use `image-context-cascade/web` and pass a synchronous hasher:

```ts
import { cascadeImages } from "image-context-cascade/web";

const result = cascadeImages(payload, {
  hasher: (data) => mySha256Hex(data),
});
```

Run:

```bash
bun test packages/core/test/cascade.test.ts -t web_entry_dependency_graph_has_no_node_crypto
```

This verifies the dependency boundary.

## Troubleshooting failed verification

If historical images are not downgraded, inspect the payload shape and matcher coverage.

If current images are downgraded, stop and fix classification before shipping.

If telemetry contains image-looking strings, check custom telemetry wrappers, custom placeholders, and host logs.

If benchmark time regresses sharply, check hash implementation, matcher identity caching, and accidental `JSON.stringify` calls in hot paths.

If typecheck fails, check that adapter code imports public APIs from `image-context-cascade` rather than deep internal paths.

If traversal reports `traversalTruncated: true`, verify whether payload depth or node count exceeded the defensive defaults described in BUILD-REPORT.md.

## Reporting new numbers

When adding benchmark numbers to README or docs, include:

- command used;
- payload generation method;
- provider block format;
- image count and approximate image string size;
- before and after character counts, if claiming reduction;
- elapsed time, if claiming performance;
- enough environment context to interpret the number, without local usernames or private paths.

Do not replace the BUILD-REPORT values with numbers from a different workload.

Do not include private filesystem paths in published docs.

## Summary

Use `bun test` and `bun run typecheck` for baseline validation.

Use the focused benchmark tests for README-class claims.

Use conformance for adapters.

Use telemetry to verify savings in a real agent.

Quote recorded numbers only when the method and source match.

## v0.2 validation

Run the full release checks from the repository root:

```bash
bun install --frozen-lockfile
bun run build
bun test
bun run typecheck
```

`bun run build` compiles the package dist outputs used by pure Node consumers.

The v0.2 tests add coverage for:

- `inv15_async_without_new_options_matches_sync_output`
- `store_io_failure_fail_open_with_store_errors`
- `url_referenced_images_never_enter_store`
- `dedupe_all_historical_same_hash_all_downgraded`
- `dedupe_historical_ref_when_current_copy_exists`
- `restore_accepts_short_hash_from_placeholder`
- CLI `rescue --store` plus `restore` end-to-end behavior

The corpus runner is asynchronous in v0.2 because corpus cases may exercise `cascadeImagesAsync`:

```ts
import { runCorpusConformance } from "@image-cascade/conformance";

const result = await runCorpusConformance();
if (!result.passed) throw new Error(result.checks.join("\n"));
```

The v0.2 corpus additions are:

- `v02_store_restorable_placeholder.json` — store-enabled cold placeholder shape.
- `v02_dedupe_same_hash_latest_retained.json` — same-payload same-hash dedupe with the latest original retained.
- `anthropic_document_positional_historical.json` — Anthropic base64 document/PDF historical downgrade.

## Verifying restore from dist

After `bun run build`, verify the pure Node CLI path with synthetic data:

```bash
node packages/cli/dist/main.js rescue session.jsonl --all --yes --store ./store --json
node packages/cli/dist/main.js restore <hash-or-hash12> --store ./store --out restored.png --json
```

The restored file should byte-match the original synthetic image bytes used in the session fixture.
