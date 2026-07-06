# Build Report

## B1 Core hardening batch (2026-07-06)

- T1 Traversal engine: `collect` is now iterative with an explicit stack, `WeakSet` cycle protection, and configurable defensive limits (`limits.maxNodes`, `limits.maxDepth`; defaults 200000 / 256). Limit breaches fail open for the whole call: `mutated=false`, original payload returned, and `telemetry.traversalTruncated=true`.
- T2 Telemetry: added optional `traversalTruncated?: boolean`; it is only emitted as `true` for traversal limit breaches.
- T3 Duplicate block references: same object decisions are memoized with a `WeakMap`, so repeated references classify consistently and downgrade to the same placeholder text. Locked by `duplicate_block_reference_consistent`.
- T4 Identity cache: builtin matcher instances cache `ImageIdentity` by block object with `WeakMap`, including injected hasher scenarios without cross-matcher cache bleed. Locked by `identity_cache_reuses_same_block_for_injected_hasher`.
- T5 Size estimation: matcher `approxChars` uses O(1) data/url length plus fixed envelope; replacement estimate uses placeholder length plus fixed envelope, avoiding full block `JSON.stringify` in hot paths.
- T6 Web subpath: `image-context-cascade/web` export added with a hasher-required `cascadeImages` wrapper. Smoke verified via Bun from a workspace package with a custom hasher and one downgrade.
- T7 Malformed blocks: empty/non-string/undefined image data, malformed empty data URIs, and numeric/null `image_url` cases are covered and do not match or throw.
- T8 Corpus: added `packages/conformance/corpus/*.json` plus README. The conformance suite now runs a corpus-driven runner over 6 JSON cases while retaining existing hand-written checks.
- T9 Extreme tests: added named coverage for circular references, depth fail-open, node budget fail-open, duplicate references, identity cache, malformed blocks, and `benchmark_10k_images_under_2s`.
- T10 Report: this B1 section records completion status, benchmark evidence, and validation statistics.

Validation evidence:

- `bun test`: 30 pass / 0 fail / 1 snapshot / 74 expect calls across 2 files.
- Benchmark: `benchmark_10k_images_under_2s elapsed_ms=116.44` for 10,000 synthetic small image blocks on final validation run.
- `bun run typecheck`: `tsc --noEmit -p tsconfig.json` completed with zero TypeScript errors.
- `/web` smoke: `web_smoke ok downgraded=1 hash=h00000000000` using `import('image-context-cascade/web')` and a custom hasher.
- Corpus count: 6 JSON cases under `packages/conformance/corpus`; corpus runner asserted `cases >= 6` inside `corpus_conformance_suite`.

Guardrails checked:

- Placeholder snapshot text was not edited.
- `packages/core/package.json` keeps `dependencies` as `{}`.
- `README.md` was not modified by this batch.
- No publish/push was performed.

## B1 hasher layering rework (2026-07-06)

- Restored native Node SHA-256 as the default main-entry hasher via `packages/core/src/hasherNode.ts`; removed the hand-written TypeScript SHA-256 implementation.
- Split layering so core traversal/matcher/identity/web modules do not import Node's crypto module. The package main entry supplies the default hasher, while `/web` continues to require an explicit hasher.
- Tightened matcher construction: `createBuiltinMatchers(hasher)` now requires a hasher; `builtinMatchers` is produced only by the main entry with the Node default hasher.
- Moved `collect` node counting after `WeakSet` duplicate detection so cyclic re-visits do not inflate the node budget.
- Added `sha256_known_vectors` covering empty string, `abc`, a >64-byte cross-block input, and a UTF-8 Chinese input.
- Added `web_entry_dependency_graph_has_no_node_crypto`, a dependency-closure regression test for the `/web` entry.

Validation evidence:

- `bun test`: 32 pass / 0 fail / 1 snapshot / 88 expect calls across 2 files.
- Benchmark: `benchmark_10k_images_under_2s elapsed_ms=39.48` on the final validation run after restoring native hashing.
- `bun run typecheck`: `tsc --noEmit -p tsconfig.json` completed with zero TypeScript errors.
- `/web` smoke: `web_smoke ok downgraded=1 hash=h00000000000` using `import('image-context-cascade/web')` and a custom hasher.
- Static grep excluding `node_modules`: the former SHA-256 constant-table marker has 0 hits; the Node crypto import appears only in `packages/core/src/hasherNode.ts`.
- Snapshot status: existing snapshot remained unchanged during this rework.

## B2 Rescue CLI batch (2026-07-06)

- Added `packages/cli` as workspace package `@image-cascade/cli` with bin `image-cascade -> ./src/main.js`. Runtime dependencies are limited to the workspace `image-context-cascade`; argument parsing and file IO use Node/Bun built-ins only.
- Implemented `rescue <file>` with format selection: `.jsonl` uses a two-pass streaming algorithm, while single JSON documents are read once into memory and processed with default positional cascade semantics.
- JSONL rescue first pass records the last line whose parsed JSON contains `role === "user"` at any depth, including Claude Code `{ type, message: { role, content } }` session rows. Second pass downgrades only lines before that boundary using a forced historical strategy; boundary and later lines are emitted unchanged. `--all` downgrades all parseable rows.
- Default mode is dry-run and writes nothing. `--yes` writes via a temporary file and rename after creating a non-overwriting `.icc-backup` / `.icc-backup.N` backup. Malformed JSONL lines are passed through unchanged and counted as `skippedLines`.
- Added CLI e2e tests for two-pass boundary correctness, dry-run safety, backup/write, idempotent second run, malformed-line passthrough, large streaming rescue, and Claude Code session shape.

Validation evidence:

- `bun test`: 39 pass / 0 fail / 1 snapshot / 115 expect calls across 3 files.
- CLI large-file test: `rescue_large_file_streaming elapsed_ms=1631.31` for 20,000 JSONL lines / 5,000 image rows.
- Core benchmark still ran in the same suite: `benchmark_10k_images_under_2s elapsed_ms=47.82`.
- `bun run typecheck`: `tsc --noEmit -p tsconfig.json` completed with zero TypeScript errors.
- CLI help smoke: `bun packages/cli/src/main.js rescue --help` printed the rescue usage/options and exited 0.
- Dependency guard: `packages/cli/package.json` dependencies contain only `image-context-cascade: workspace:*`.

### B2 rescue CLI no-boundary fail-open rework (2026-07-06)

- Fixed JSONL default safety semantics: when no `role === "user"` boundary is found and `--all` is not supplied, rescue now processes zero rows instead of downgrading every image block.
- Human-readable stats now print: `no user-message boundary found; nothing downgraded. Use --all to downgrade all image blocks.` JSON output continues to represent this as `boundaryLine: null`.
- Updated `--all` help text to clarify it downgrades all image blocks, including files with no user-message boundary.
- Added `rescue_jsonl_no_user_boundary_noop_without_all`: verifies default `--yes` no-ops with no backup and unchanged bytes, then verifies `--all --yes` downgrades and creates a backup.

Validation evidence:

- `bun test`: 40 pass / 0 fail / 1 snapshot / 126 expect calls across 3 files; CLI large-file timing `rescue_large_file_streaming elapsed_ms=1431.35`.
- Targeted new test: `bun test packages/cli/test/rescue.test.ts -t rescue_jsonl_no_user_boundary_noop_without_all` => 1 pass / 0 fail / 11 expect calls.
- `bun run typecheck`: `tsc --noEmit -p tsconfig.json` completed with zero TypeScript errors.

## B4 Publish engineering batch (2026-07-06)

- Added package build pipeline: core and conformance compile TypeScript to `dist/` with JS, declarations, declaration maps, and sourcemaps; CLI copies to `dist/main.js` with `#!/usr/bin/env node` for Node execution.
- Updated package metadata for publish readiness: dist-based exports, `main`/`types`, `files`, `sideEffects:false`, `engines.node >=18`, Apache-2.0 license, repository/homepage/bugs, keywords, and unified `0.1.0` versions. The Pi adapter is marked `private:true`.
- Added root build scripts and CI workflow. CI installs with Bun, runs typecheck/test/build, then runs Node dist smoke jobs on Node 18/20/22.
- Added `.gitignore` coverage for `node_modules`, generated `dist`, rescue backups, and temporary files.
- Verified publish dry-runs for the three publishable packages include only dist/corpus/package metadata and exclude src/test/local machine data.

Validation evidence:

- `bun run build`: completed successfully for core, conformance, and CLI.
- Dist files generated:
  - core: `dist/index.js`, `dist/web.js`, `dist/*.d.ts`, sourcemaps, and block/classify/helper module outputs.
  - conformance: `dist/suite.js`, `dist/suite.d.ts`, sourcemaps.
  - CLI: `dist/main.js` with Node shebang.
- Pure Node smoke: `node --version` => `v24.14.1`; core dist smoke printed `core dist smoke downgraded=1`; `node packages/cli/dist/main.js rescue --help` printed the rescue usage/options.
- `bun test`: 40 pass / 0 fail / 1 snapshot / 126 expect calls across 3 files; CLI large-file timing `rescue_large_file_streaming elapsed_ms=1373.61`; core benchmark `benchmark_10k_images_under_2s elapsed_ms=36.71`.
- `bun run typecheck`: build plus `tsc --noEmit -p tsconfig.json` completed with zero TypeScript errors.
- `npm pack --dry-run`:
  - `image-context-cascade@0.1.0`: 61 files, dist + package metadata only.
  - `@image-cascade/conformance@0.1.0`: 12 files, dist + corpus + package metadata only.
  - `@image-cascade/cli@0.1.0`: 2 files, `dist/main.js` + package metadata only.
- Local git baseline created with commit message `chore: initial commit - image-context-cascade v0.1.0`; no remote configured or pushed.

## Anthropic document block support (2026-07-06)

- Added Anthropic base64 document matching for blocks shaped like `{ type: "document", source: { type: "base64", data } }`, with non-empty string data, media type left unrestricted, O(1) size estimation, and replacement to `{ type: "text", text }`.
- Added a document-specific default placeholder while preserving the existing image placeholder text byte-for-byte.
- Registered the document matcher in `createBuiltinMatchers` / main-entry `builtinMatchers`, and exported the document matcher factory for direct use.
- Added unit coverage for document matching, near misses, document placeholder snapshot, and positional historical downgrade/current retention.
- Added conformance corpus case `anthropic_document_positional_historical.json`; corpus JSON count is now 7.
- Updated `docs/pattern.md` Replacement model with the single Anthropic document replacement line.
- Rebuilt dist outputs; `packages/core/dist/blocks/anthropicDocument.*` is present.

Validation evidence:

- `bun run build`: completed successfully for core, conformance, and CLI.
- `bun test`: 44 pass / 0 fail / 2 snapshots / 138 expect calls across 3 files; `placeholder_snapshot_frozen` passed and snapshot diff only adds `document_placeholder_snapshot_frozen`.
- `bun run typecheck`: build plus `tsc --noEmit -p tsconfig.json` completed with zero TypeScript errors.
- Corpus count: `corpus_json_count 7`.
- Node dist document smoke: `document dist smoke downgraded=1 type=text`.
