# Security and Privacy

## Summary

`image-context-cascade` reduces image exposure in provider requests.

It does not add a new image-processing service.

It does not upload images.

It does not store image bytes.

It walks a payload that already exists inside the agent process, replaces historical image blocks with short text placeholders, and returns telemetry that cannot carry image data by type.

This document expands the README privacy and safety guarantees and ties them to the invariants in `docs/pattern.md`.

## Threat model

The protected data is image payload data inside an agent's provider request.

That includes raw base64 fields, `data:image/...;base64,...` URLs, and provider-specific image blocks.

It may also include remote image URLs when a provider accepts URL references.

The library operates in the same process boundary where the host already constructs the provider request.

It receives the payload from the host adapter.

It returns a possibly modified payload and `CascadeTelemetry`.

It does not decide where the host sends either value.

### Data flow: normal request

1. The user attaches an image or the agent produces an image-containing tool result.
2. The host builds a provider payload.
3. The adapter calls `cascadeImages(payload, options)` before sending the payload.
4. The core traverses the object graph in memory.
5. Built-in or supplied `BlockMatcher` values recognize image blocks.
6. The configured `ClassifyStrategy` returns `current`, `historical`, or `unknown`.
7. Current and unknown images remain intact.
8. Historical images are replaced with provider-valid text placeholders.
9. The adapter sends the returned payload to the provider.
10. The adapter may log `CascadeTelemetry`.

### Data flow: identity

For matched images, the core computes an `ImageIdentity`.

`ImageIdentity.hash` is the full hash used internally and in telemetry.

`ImageIdentity.shortHash` is the first 12 characters used in placeholders.

The placeholder does not include base64, filenames, local paths, or pixel data.

### Data flow: telemetry

`CascadeTelemetry` contains counts, estimates, format counts, strategy name, short hashes, and optional traversal truncation.

It does not contain original blocks.

It does not contain replacement payload snapshots.

It does not contain image bytes.

This supports INV-5 from `docs/pattern.md`.

## Trust boundaries

The first boundary is the host process.

The library runs inside that boundary and sees payload objects the host already created.

The second boundary is the provider request.

The library reduces what crosses that boundary by replacing historical image bytes.

The third boundary is host logging or telemetry.

The library returns safe telemetry, but the host can still leak data if it logs full payloads before cascade or logs user attachments elsewhere.

The fourth boundary is the model context.

Only text placeholders for downgraded images enter context after cascade.

The current-turn images still enter context because preserving them is required for correctness.

## Guarantee 1: no image data leaves a boundary it was not already crossing

The library only transforms an existing provider payload.

It does not open sockets.

It does not call external APIs.

It does not write image data to disk.

It does not create a side channel for image bytes.

For historical images, it removes bytes from the provider payload.

For current and unknown images, it leaves the payload as the host provided it.

This implements INV-1, INV-2, and INV-6 from `docs/pattern.md`.

## Guarantee 2: telemetry cannot contain image data by type

The public telemetry type is:

```ts
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
```

There is no field for original image data.

There is no field for payload snapshots.

There is no field for user filenames or local paths.

The test suite also serializes telemetry and checks that it does not contain `data:image` or long base64-like strings.

This is a type boundary, not just a logging convention.

Adapters should preserve that boundary by logging `result.telemetry`, not `result.payload`.

## Guarantee 3: only a short one-way hash prefix enters context

Historical image placeholders use `ImageIdentity.shortHash`.

The reference prefix length is 12 hex characters.

The default placeholder is produced by `defaultPlaceholder(id: ImageIdentity): string`.

It says that an image was omitted from this provider request and that the model should use prior image summary unless the user asks to inspect the original again.

The placeholder does not include the full hash.

It does not include filenames.

It does not include paths.

It does not include MIME metadata unless a custom placeholder adds it.

Custom placeholders must preserve INV-3, INV-4, and INV-5 from `docs/pattern.md`.

## Guarantee 4: current-turn images are never touched

The pattern's first safety rule is that current images remain intact.

The default `positionalStrategy()` returns `current` for images at or after the last user message.

When no user boundary is available, it fails open by returning `current`.

The `trackerStrategy({ currentTurnHashes, tracker })` returns `current` for hashes explicitly collected at turn start.

Core tests cover current-turn retention.

This guarantee protects model correctness over token savings.

A library that removes the new screenshot the user just attached is worse than no library.

## Telemetry as a privacy boundary

Telemetry is intentionally narrow.

The values are sufficient to answer operational questions:

- How many images were found?
- How many were current?
- How many were downgraded?
- How many were unknown and retained?
- Which provider formats were present?
- Which short identities were involved?
- What is the estimated character saving?
- Did traversal hit defensive limits?

Those questions do not require image bytes.

That is why telemetry is a privacy boundary rather than an observability dump.

If a host needs deeper debugging, prefer synthetic fixtures or local-only redacted payload snapshots.

Do not expand `CascadeTelemetry` to include blocks or snippets.

Doing so would break the design even if the field is optional.

## Defensive traversal behavior

Traversal uses positive matcher recognition.

Near-miss blocks are ignored.

Malformed image fields are ignored.

Unsupported provider formats are ignored until a `BlockMatcher` is added.

If traversal exceeds configured `limits.maxNodes` or `limits.maxDepth`, cascade fails open for the whole call.

The returned payload is original and unmodified.

Telemetry reports `traversalTruncated: true`.

This protects INV-7 and INV-10 from `docs/pattern.md`.

## Placeholder stability and privacy

Stable placeholders are not only a cache optimization.

They are also a privacy control.

Unstable placeholders tempt implementers to include human-readable metadata, timestamps, or file labels.

Those fields can reveal more than the model needs.

The reference default includes only a short hash prefix and a generic instruction.

Keeping placeholders boring is intentional.

## Known non-protections

This library does not stop the host from logging full payloads before calling cascade.

It does not stop a provider SDK from logging request bodies after the adapter passes them on.

It does not delete images already stored in transcript files.

It does not redact images from screenshots, terminal logs, browser devtools, crash reports, or OS-level telemetry.

It does not prevent the model from retaining information it already inferred from a current-turn image.

It does not protect against a malicious adapter that copies payloads elsewhere.

It does not protect against a malicious custom `BlockMatcher`, custom `placeholder`, custom `hasher`, or custom `ClassifyStrategy`.

It does not make remote image URLs private; if a current or unknown URL image remains in the payload, provider-side URL handling is governed by the provider and host.

It does not provide cryptographic anonymity for short hash prefixes.

A 12-character prefix is an identity hint for cache-stable placeholders, not a secret.

## Adapter responsibilities

Adapters must call cascade before the provider request is sent.

Adapters should avoid logging pre-cascade payloads.

Adapters should log only `CascadeTelemetry` unless users explicitly opt into local debugging.

Adapters should use `result.payload` only as the outgoing provider payload, not as a persistent transcript rewrite unless that behavior is intended and documented.

Adapters should not add image bytes to telemetry.

Adapters should not replace `defaultPlaceholder` with a template containing filenames or paths.

Adapters should run conformance tests after changing matcher or classification behavior.

## Custom strategy risk

`ClassifyStrategy` is intentionally pluggable.

That power can break safety.

A custom strategy that marks current images as historical violates INV-1.

A custom strategy that marks uncertain images as historical violates INV-2.

A custom strategy that changes decisions based on wall-clock time may break INV-3 indirectly by producing inconsistent replacement sets.

If you write a custom strategy, document why it is safe and add fixtures that prove current images survive.

## Custom matcher risk

A broad matcher can rewrite non-image content.

A matcher that accepts malformed fields can throw at runtime or hash the wrong data.

A matcher that returns a provider-invalid text block can break requests.

A matcher that includes raw image data in `formatId` or replacement text violates privacy.

Keep matchers narrow and boring.

## Incident checklist

If you suspect image leakage:

1. Check whether the host logged the payload before cascade.
2. Check whether telemetry contains only the `CascadeTelemetry` fields listed above.
3. Check whether a custom placeholder included metadata.
4. Check whether a custom matcher placed source data into replacement text.
5. Check whether current or unknown images were correctly retained by design.
6. Check whether the provider SDK has request logging enabled.
7. Reproduce with `bun test` and add a regression fixture.

## Summary

The security model is deliberately small.

The library reduces provider-bound image bytes.

It preserves current images.

It fails open when unsure.

It exposes telemetry that has no image-data field.

Privacy still depends on the host not logging or copying the original payload elsewhere.
