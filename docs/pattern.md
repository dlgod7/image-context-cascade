# Image Context Cascade Pattern

## Status

This document specifies the image-context-cascade pattern: request-level lifecycle management for images in AI coding-agent provider payloads.

It is intended to be cited independently from any one implementation.

The reference implementation in this repository is the normative implementation for the API names used here, but the pattern is broader than this package.

The tone is deliberately operational: this solves one payload problem, not all context-management problems.

## Problem statement

AI coding agents often keep resending image bytes after the model has already seen them.

That behavior is expensive, cache-hostile, and sometimes fatal to the session.

The problem is visible in public issue trackers:

- https://github.com/anthropics/claude-code/issues/9269 reports oversized image payloads producing `request_too_large` / 413-style failures that can brick a session.
- https://github.com/anthropics/claude-code/issues/16649 reports base64 screenshots breaking `/compact` itself, forcing manual session-file surgery.
- https://github.com/anthropics/claude-code/issues/24298 reports a UI-development session where screenshots consumed 86.3% of the context window, and discusses image-aware lifecycle controls.
- https://github.com/openai/codex/issues/28316 reports multi-megabyte request bodies and historical image resends, including a single PNG data URL with millions of characters.

These reports describe the same structural bug: pixels are ephemeral input, but many agents treat them as durable conversation history.

Text history is often durable.

Image bytes usually are not.

Once the model has received a screenshot, diagram, or pasted image and produced an answer, the original bytes normally do not need to be sent again on every later request.

If the user asks the model to inspect the original pixels again, the safe behavior is to ask for re-attachment or use a host-provided re-inspection path.

The pattern therefore acts before the provider request leaves the agent process.

That timing is the point.

Compaction cannot reliably solve this class of failure because the oversized request can fail before compaction runs, and images can break compaction itself.

Prompt instructions cannot solve it either because a prompt cannot remove bytes from the transport payload.

## Scope

The pattern manages image blocks inside provider request payloads.

It does not summarize arbitrary text.

It does not claim to recover downgraded pixels.

It does not require one framework or one provider SDK.

It does require a hook at request construction time, or an equivalent request proxy that can transform the payload before it is sent.

## Classification model

Every matched image block is classified into exactly one of three states.

### `current`

`current` means the image belongs to the active user turn and must remain intact.

The model has not necessarily seen it yet in this request cycle.

Touching it would break multimodal correctness.

The reference implementation treats `current` as a hard safety boundary.

### `historical`

`historical` means the image appeared in an earlier part of the transcript and is eligible to be replaced with a stable text placeholder.

The placeholder carries a short one-way identity prefix and an instruction that the original image was omitted from this provider request.

The model should use prior conversation context unless it needs the original pixels again.

### `unknown`

`unknown` means the implementation cannot prove whether the image has already been sent to the model.

The safe behavior is fail-open: retain the image intact.

In the reference implementation, `unknown` is used by `trackerStrategy({ currentTurnHashes, tracker })` when an image is neither current nor already known to the tracker.

After passing through intact once, the tracker can remember it and allow later downgrade.

## Strategy 1: positional classification

The positional strategy is the default reference strategy.

It is exposed as `positionalStrategy(): ClassifyStrategy`.

Semantics:

- If traversal can identify a message array with user-role messages, images at or after the last user message are `current`.
- Images before the last user message are `historical`.
- If no usable user-message boundary is available, the strategy fails open by returning `current`.

The safety argument is simple.

Any image located in an earlier message was necessarily present in an earlier provider request when that message was current.

Therefore the model has already had the chance to see the full image bytes.

Replacing that older block in a later request does not hide a newly attached image from the model.

This argument does not require cross-request state.

That is why positional classification is restart-safe and proxy-friendly.

A stateless HTTP proxy can receive one request, classify by message position, and produce the same safe result without knowing what happened before process start.

The failure mode is conservative.

If the payload shape does not expose a boundary, current-turn safety wins and the image remains intact.

The known limitation is transcript mutation outside the normal request lifecycle.

If a host injects a never-sent image into an older transcript position, positional classification may treat it as historical.

Hosts with that behavior should use tracker classification or a custom `ClassifyStrategy`.

## Strategy 2: tracker classification

The tracker strategy is exposed as `trackerStrategy(opts: { currentTurnHashes: ReadonlySet<string>; tracker: ImageTracker }): ClassifyStrategy`.

It is for hosts that can identify images attached at turn start.

Semantics:

- If `identity.hash` is in `currentTurnHashes`, the image is `current`.
- Else if `tracker.has(identity.hash)` is true, the image is `historical`.
- Else the image is `unknown` and remains intact for this request.

The reference `InMemoryTracker` implements `ImageTracker` with an LRU map and a default capacity of 200 entries.

The tracker strategy is useful when transcripts may be edited out of band, when an adapter has exact current-turn attachment data, or when later lifecycle policies need per-image control.

It has one cost: process restart loses in-memory history unless the host provides a persistent tracker.

That cost is safe, because lost tracker state causes `unknown` images to pass through intact rather than be dropped.

## Replacement model

Historical images are not deleted silently.

They are replaced with deterministic text blocks appropriate for the provider format.

The default placeholder is produced by `defaultPlaceholder(id: ImageIdentity): string`.

It uses `id.shortHash`, which is the first 12 characters of a SHA-256 identity.

The default text is stable for the same input identity and contains no timestamp, counter, filename, path, or image data.

Built-in provider matchers replace blocks as follows:

- Anthropic image blocks become `{ type: "text", text }`.
- Anthropic document (base64) blocks become { type: 'text', text } with a document placeholder.
- OpenAI Chat `image_url` blocks become `{ type: "text", text }`.
- OpenAI Responses `input_image` blocks become `{ type: "input_text", text }`.

The exact matching and replacement rules are implemented by `BlockMatcher` values.

## Required invariants

These invariants define correct behavior for this pattern.

They are numbered so adapters, tests, and security reviews can refer to them precisely.

### INV-1: Current images are never transformed

An image classified as `current` must remain byte-for-byte equivalent in the outgoing provider payload.

Current-turn image preservation takes priority over savings.

### INV-2: Unknown images fail open

An image classified as `unknown`, or an image found when traversal cannot establish required safety context, must remain intact.

Failure to prove safe downgrade is not permission to downgrade.

### INV-3: Historical placeholders are byte-stable

For the same image identity and placeholder configuration, replacement text must be byte-identical across calls, processes, and restarts.

Do not include timestamps, sequence numbers, relative turn counts, random IDs, host paths, filenames, or mutable labels.

### INV-4: Placeholder identity is one-way and short

Only a short one-way hash prefix may enter the model context as image identity.

The reference implementation exposes `ImageIdentity.shortHash`, the first 12 characters of a SHA-256 identity, in the default placeholder.

The full hash may appear in internal state or telemetry when needed for correlation, but image bytes, local paths, and filenames must not be added to the placeholder.

### INV-5: Telemetry has no image-data capacity

Telemetry must not contain raw base64, data URIs, image bytes, filenames, local paths, full payload snapshots, or replacement block snapshots.

A telemetry type should be shaped so it can express counts, estimates, format IDs, strategy names, truncation flags, and short hashes without having any field intended for image data.

The reference `CascadeTelemetry` type follows that rule.

### INV-6: Cascade does not create a new image-data egress path

A cascade implementation may remove image bytes from a provider-bound payload.

It must not upload images, write images to a new sink, send them to an extra service, or copy them into telemetry.

Adapters remain responsible for their own logs and host behavior, but the cascade operation itself must not create an additional channel through which image data leaves the boundary it was already in.

### INV-7: Traversal limit breaches fail open for the whole call

If traversal exceeds configured defensive limits, such as maximum node count or maximum depth, the whole cascade call must leave the payload unmodified.

Partial replacement after a traversal-limit breach is not allowed.

The operation should report the condition through telemetry, such as `traversalTruncated: true`, so the host can diagnose the missed saving without risking data loss.

### INV-8: Cascade is idempotent

Running cascade repeatedly over an already-cascaded payload must not keep changing the payload.

Text placeholders are not image blocks and must not be reprocessed as images.

Idempotence matters for retry paths, middleware chains, and transcript rescue tools.

### INV-9: Duplicate object references classify consistently

If the same image block object is encountered more than once in a payload graph, decisions for that object must be consistent within the call.

The same object should not be retained in one location and downgraded in another location because of traversal order.

The reference implementation memoizes decisions for repeated object references.

### INV-10: Defensive traversal only mutates positively recognized image blocks

Traversal must be conservative.

A cascade implementation should mutate only blocks positively recognized by a `BlockMatcher` and only while traversal stays within defensive limits.

Malformed image-like objects, near-miss provider blocks, ordinary text blocks, unsupported formats, circular references, and over-budget traversal paths must not cause speculative rewrites.

This invariant works with INV-7: defensive traversal either completes safely and mutates recognized historical images, or fails open without modifying the payload.

### INV-11: Provider text shape is preserved after replacement

Replacement blocks must be valid text blocks for the provider format being transformed.

Anthropic and OpenAI Chat image blocks become `{ type: "text", text }` in the reference matchers.

OpenAI Responses `input_image` blocks become `{ type: "input_text", text }`.

A custom provider matcher must return the equivalent text block for that provider.

### INV-12: The pattern does not compress ordinary text history

Image Context Cascade is image lifecycle middleware, not generic context compression.

It must not summarize or rewrite normal text messages as part of image downgrade.

Hosts may add separate summarization behavior, but that behavior is outside this pattern.

## Conformance expectations

A conforming implementation should demonstrate the invariants with executable tests, not only with documentation.

The repository provides `image-context-cascade-conformance` for adapter-level checks and a language-neutral JSON corpus under `packages/conformance/corpus/`.

The core test suite also covers matcher behavior, classification, placeholder stability, telemetry privacy, traversal limits, and benchmark guardrails.

Important named tests and corpus cases include:

- `current_turn_images_never_touched`, covering INV-1.
- `unknown_intact_once_then_downgraded`, covering INV-2 for tracker mode.
- `placeholder_snapshot_frozen`, covering INV-3 and INV-4.
- `telemetry_never_contains_base64`, covering INV-5.
- `deep_nesting_beyond_limit_fails_open` and `node_budget_exceeded_fails_open`, covering INV-7 and INV-10.
- `cascade_idempotent`, covering INV-8.
- `duplicate_block_reference_consistent`, covering INV-9.
- `replace_produces_format_correct_text_block`, covering INV-11.
- `payload_without_images_untouched`, covering INV-12.
- `anthropic_positional_historical.json`, `openai_chat_positional_historical.json`, and `openai_responses_positional_historical.json`, covering provider-format downgrade.
- `tracker_current_hash_retained.json`, covering explicit current-image retention in tracker mode.
- `nested_boundary_regression.json`, covering positional boundary safety in nested transcript-like data.

Adapter authors should run `bun test`, `bun run typecheck`, and an adapter harness through `runConformance` from `image-context-cascade-conformance`.

## Why this belongs at request time

The request-construction layer sees the exact payload that will go over the wire.

It can preserve current-turn images and downgrade older images before they affect request size, token accounting, and prompt-cache keys.

That is earlier than compaction.

It is also more precise than transcript-wide cleanup, because the adapter can act on the provider payload shape actually being sent.

## Non-goals

This pattern does not decide what the assistant should remember about an image.

A host may add a separate instruction asking the model to summarize visual facts after using an image, but that is not required for byte removal.

This pattern does not provide source storage or automatic re-inspection in version 0.1.

It also does not make closed agents extensible if they expose no request hook and cannot be used behind a request proxy.

## Summary

Image Context Cascade is a small rule with strict boundaries.

Keep current images.

Replace historical images with stable placeholders.

Fail open when unsure.

Measure without leaking image data.

Those rules are enough to remove the repeated-pixel tax without pretending to solve all memory or context problems.
