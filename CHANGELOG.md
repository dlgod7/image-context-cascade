# Changelog

## 0.2.1

- Added an `openai-image-generation` matcher: bare-base64 `result` fields on `image_generation_call` response items and `image_generation_end` events (Codex stores each generated image twice this way). Media type is sniffed from the base64 magic; non-image results are never touched.
- Fixed traversal so blocks are matched wherever they sit: item-level entries in a message array (e.g. a Responses `input` list) and blocks stored as object field values (e.g. a transcript line's `payload`) — previously only content-array members were matched, which missed Codex image-generation output entirely.
- Verified on a real 332-line Codex rollout session: 50.2 MB → 2.26 MB (−95.5%), all lines valid JSON, idempotent, restore round-trip byte-identical.
- Added an agent-paste setup section to the README so any coding agent can install and run the rescue flow unattended.
- Removed dead internal helper files (`blocks/anthropic.ts`, `blocks/openaiChat.ts`, `blocks/openaiResponses.ts`); they were never exported. Added `imageGenerationMatcher` to the public exports.

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
