# Changelog

## 0.2.0

- Added opt-in source store support for restorable downgraded images.
- Added tiered image memory: hot current originals, warm thumbnail interface, cold placeholders.
- Added `cascadeImagesAsync` with source store, tier policy, thumbnailer, and dedupe support.
- Added `restoreImage` and `buildImageBlock` APIs.
- Added CLI `rescue --store[=dir]` and `image-cascade restore <hash> [--store <dir>] [--out <file>]`.
- Added same-payload exact-byte dedupe for repeated image hashes.
- Added source-store and dedupe conformance corpus cases.
- Documented the Claude Code zero-component restore loop using shell + file tools.

BREAKING:

- `runCorpusConformance` now returns a `Promise` because corpus cases may exercise async cascade behavior.

## 0.1.1

- Added CLI `--version` / `-v` handling.
- Added package README files for npm package display.
- Fixed lockfile registry metadata to use `registry.npmjs.org`.

## 0.1.0

- Initial release.
- Added core `cascadeImages` API with positional and tracker strategies.
- Added built-in matchers for Anthropic image blocks, Anthropic document blocks, OpenAI Chat image URLs, and OpenAI Responses input images.
- Added stable placeholders, telemetry, traversal limits, duplicate-reference consistency, and conformance corpus.
- Added rescue CLI for oversized JSONL/session files.
