# image-context-cascade

English | [简体中文](README.zh-CN.md)

**Your agent resends every screenshot you've ever pasted — every single turn.** The model saw it on turn one; fifty turns later you're still paying for those pixels. Tokens burn, prompt caches destabilize, and eventually a 413 bricks the whole session.

`image-context-cascade` downgrades historical images to restorable lightweight placeholders *before* the request leaves your process — current-turn images stay intact. **One command takes a 50 MB session down to 2 MB, and every removed image is recoverable.**

Zero runtime dependencies · Framework-agnostic · Supports Anthropic / OpenAI Chat / OpenAI Responses payload shapes

---

## The problem

When you paste screenshots into Codex, Claude Code, or similar agents, every image lives in the session as base64 — **and gets resent in full on every subsequent request**. In one real session, screenshots ate 86.3% of the context window. On Codex, a single request body hit 8.34 MB with ~5.7M prompt tokens. Sessions balloon, `/compact` can't keep up, and oversized payloads 413 the session dead.

Compaction can't save you — and not for lack of trying. A 413 happens the moment the request leaves your process, before any compaction runs. Images can break compaction itself. The only layer where this is fully fixable is request construction. That's where this project lives.

## Key features

**Three-tier image lifecycle, automatic grading:**

| Tier | Target | Treatment |
|---|---|---|
| **Hot** | Current-turn images | Sent intact — the model sees what you just attached |
| **Warm** | Recent history | Optional thumbnails (host-injected `thumbnailer`) |
| **Cold** | Older history | Stable, restorable placeholders — recover originals by hash on demand |

**Design guarantees (every mode, every host):**

- **Archive, not delete** — every downgraded image is restorable by hash. Nothing is ever unrecoverable.
- **Text history untouched** — only images are managed. Your conversation stays verbatim.
- **Cache-friendly** — placeholders are stable; they don't destabilize prompt-cache prefixes.
- **Nothing resident** — no daemon, no watcher. Hooks run for milliseconds at session boundaries and no-op when there's nothing to archive.
- **No content judgement** — classification is positional and deterministic. No model decides which image "looks important."
- **Private by design** — image data never leaves the process boundary it was already in. Telemetry contains counts and hashes only, never image data.

**Measured results:** real 1.3 MB PNG → 315 chars (−99.98%). In a live session, downgrading four historical images dropped input tokens from 91,734 to 1,910 and recovered cache reads from 11,776 to 100,352.

## Known limitations

This project is useful, but it's not magic. Here's what you should know:

- **Images only, not text.** This is not general-purpose context compression.
- **Adapter depth varies by agent.** Pi and other open agents with request-construction hooks get fully automatic per-request handling. Claude Code gets automatic archiving at session boundaries via `SessionEnd` hook. Codex is semi-automatic (agent proposes, you approve). Agents without hooks fall back to manual CLI.
- **Middleware means possible install friction.** Different machines, agent configs, or custom modifications can cause issues — uncommon, but not impossible. The good news: most agents can self-repair or localize the setup.
- **Remote URL images are not stored.** Only base64/data-URI bytes already in the payload are processed; URLs are not fetched.
- **Exact-byte identity only.** The same image re-encoded or resized hashes differently. Perceptual hashing is future research.
- **Old-session resume is best-effort.** Rescue guarantees a lean, valid, restorable file — but not that the host will successfully resume it (Codex has been observed rejecting rescued files on unrelated validations).

## Quick start

### Option 1: paste one line to your agent (recommended)

Whatever coding agent you use, paste this — it reads the [setup guide](docs/setup/README.md), identifies its own host, and configures itself:

```text
Read and follow https://raw.githubusercontent.com/dlgod7/image-context-cascade/main/docs/setup/README.md
— identify which agent host YOU are running in, then apply the guide for YOUR host
(Pi / Claude Code / Codex / generic). This is configuration only: do NOT read, list,
or rewrite any session/transcript files. When done, report what you changed and how to undo it.
```

Prefer to read it yourself? [Pi](docs/setup/pi.md) · [Claude Code](docs/setup/claude-code.md) · [Codex](docs/setup/codex.md) · [other hosts](docs/setup/generic.md)

### Option 2: CLI rescue for existing sessions

```bash
npm install -g @image-cascade/cli

image-cascade rescue session.jsonl                 # dry-run: see what you'd save
image-cascade rescue session.jsonl --yes --store   # backup + rewrite + archive originals
image-cascade restore a1b2c3d4e5f6 --out img.png   # bring any archived image back
```

### What you get per agent

| Host | Mechanism | Result |
|---|---|---|
| **Pi** | bundled adapter → `before_provider_request` | **Fully automatic, every request, in-process** — reference integration |
| Your own agent / framework | `cascadeImages()` at request construction | Fully automatic, every request |
| Claude Code | `SessionEnd` hook → `image-cascade hook claude-code` | Auto-archive at session end; resumes load the lean transcript |
| Codex | `AGENTS.md` guidance + manual `rescue` | Semi-automatic — agent proposes, you approve |
| Anything else | `npx @image-cascade/cli rescue` | Manual, works on any JSON/JSONL transcript |

**Real-world measurements:**
- Claude Code, 381-line session: **6.26 MB → 1.36 MB (−78%)**, 35 historical attachments downgraded
- Codex, 332-line rollout: **50.2 MB → 2.26 MB (−95.5%)** (Codex stores each generated image twice, so image-heavy sessions collapse dramatically)

> ⚠️ **Never rewrite a session that's currently open.** The agent process may still be appending. Close the session first, or work on a copy. Rescuing *other* sessions while an agent runs is fine.

## Bringing a downgraded image back

With `rescue --yes --store`, the short hash in a cold placeholder is your restore key. No MCP server needed — if your agent has a shell tool and a file-reading tool:

```text
User: Please look again at Image a1b2c3d4e5f6.
Assistant: image-cascade restore a1b2c3d4e5f6 --out restored.png
           (reads restored.png, answers from the restored current-turn content)
```

Restore appends new content — it doesn't rewrite old transcript bytes, so it won't destroy existing prompt-cache prefixes.

## Measure it on your sessions (optional)

Want to see what you'd save before committing? Paste this to your agent — it lists your largest session files, dry-runs the numbers, and only rewrites what you approve (with backups):

```text
Show me what image-context-cascade would save on my existing agent sessions.
Heads-up: this task lists my session files and rewrites the ones I approve (with backups).

1. Ensure the CLI is available (image-cascade --version, or use npx @image-cascade/cli).
2. Find MY host's session directory (Claude Code: ~/.claude/projects/*/*.jsonl; Codex:
   ~/.codex/sessions/*/*/*/rollout-*.jsonl; other hosts: locate your transcript directory —
   on Windows these live under %USERPROFILE%). List the 5 largest files by size.
3. Safety: never touch the session file of THIS conversation, and skip any session that
   might be open in another window (ask me if unsure).
4. Dry-run each candidate: image-cascade rescue <file>   (writes nothing; note the numbers)
5. Show me the dry-run table and ask which files to apply. For approved files only:
   image-cascade rescue <file> --yes --store
6. Report: file, bytes before → after, images archived, backup path. Do not delete backups.
```

---

## Under the hood

The sections below are for developers who want to understand the internals or integrate directly. Most users won't need to go past Quick start.

### How it works

```
                      ┌────────────────────────────────────────────┐
 agent loop           │  provider request payload                  │
 ───────────►  build  │  [ msg1(img A) msg2 msg3(img B) msg4(img C)│──► cascade ──► wire
                      └────────────────────────────────────────────┘        │
                                                                            ▼
                                              img A, B → [Image a1b2c3d4e5f6 omitted …]
                                              img C (current turn) → sent intact
```

1. **Find** — walk the payload; match image blocks per provider format (Anthropic base64 blocks, OpenAI Chat `image_url`, OpenAI Responses `input_image`, data URIs, bare-base64 `image_generation_call` results), plus Anthropic base64 `document` attachments (e.g. PDFs). Blocks are matched wherever they sit: content arrays, item-level entries, object fields.
2. **Classify** — each image is `current`, `historical`, or `unknown` via a pluggable strategy.
3. **Tier** — current images stay hot; historical images become warm thumbnails or cold placeholders per the tier policy and thumbnailer.
4. **Store & restore** — with a source store enabled, original bytes are saved locally by content hash; cold placeholders can be restored with `image-cascade restore <hash>`.
5. **Report** — telemetry with counts, per-format stats, tiers, dedupe, store errors, and estimated savings. Never any base64.

### Default strategy: positional

Classifies by position — images at or after the last user message are current; everything earlier is historical. **Why this is safe:** any image in an earlier message was necessarily sent in full in an earlier request — the model has already seen it. No cross-request state needed, so restarts lose nothing. When no boundary can be found, it fails open and retains everything.

### Use the library (agent & framework authors)

```bash
npm install image-context-cascade
```

```ts
import { cascadeImages } from "image-context-cascade";

const { payload, mutated, telemetry } = cascadeImages(requestPayload);
// payload: historical images replaced with stable placeholders, current-turn intact
// telemetry: { found, current, downgraded, estimatedSavedChars, ... } — counts and hashes only
```

If your agent knows exactly which images belong to the current turn (e.g. a turn-start hook), use `trackerStrategy` for finer control. See the [Pi reference adapter](packages/adapters/pi/src/index.ts) — 99 lines including full store/restore wiring.

### Writing an adapter

To support a new provider format, implement a `BlockMatcher` (`match` / `replace`) and pass it via `formats`. **Do not** reimplement classification, placeholders, or traversal — that's how behavior drifts. Run the conformance suite (`@image-cascade/conformance`) to verify correctness.

### Privacy & safety

- Image data never leaves the process boundary it was already in — the library only *removes* image bytes and adds short text placeholders.
- The `CascadeTelemetry` type is structurally incapable of carrying image data; conformance tests additionally assert this.
- Only a 12-character one-way hash prefix enters the context — no filenames, paths, or pixel data.
- Current-turn images are never touched — enforced by tests; the positional strategy fails open when it can't establish a boundary.

### CLI reference

```bash
image-cascade rescue <file>                    # dry-run
image-cascade rescue <file> --yes              # backup + rewrite
image-cascade rescue <file> --yes --store      # also archive originals
image-cascade restore <hash> --out <file>      # restore an archived image
image-cascade hook claude-code                 # SessionEnd hook entry point
```

Two streaming passes, O(1) memory, automatic backup, atomic write, malformed lines passed through, idempotent. `--store` writes to `~/.image-cascade/store` (override with `ICC_STORE_DIR`). `ICC_DISABLE=1` disables all hook-triggered processing.

## Releases & packages

Version history and source archives: [GitHub Releases](https://github.com/dlgod7/image-context-cascade/releases). npm packages: [`image-context-cascade`](https://www.npmjs.com/package/image-context-cascade) (core) · [`@image-cascade/cli`](https://www.npmjs.com/package/@image-cascade/cli) (CLI).

## Prior art & acknowledgements

The Claude Code and Codex communities independently articulated this problem and sketched similar solutions — image-aware compaction, ephemeral image flags, `/drop-images`, sha256 placeholders. This project turns those sketches into a correct, installable, framework-agnostic implementation. **If coding agents ship native image lifecycle management, this project has done its job.**

Related projects solving *different* problems: [pi-vision-proxy](https://github.com/pungggi/pi-vision-proxy) and [opencode-vision-paste](https://github.com/wsaaaqqq/opencode-vision-paste) route images through a vision model so *text-only* models can use them — they make images readable; `image-context-cascade` manages the lifecycle of images a *multimodal* model has already read. The two are complementary.

Thanks to the [linux.do](https://linux.do) community for feedback and discussions, and to Fable-5 (under Claude Code) for contributions to the project.

## License

[Apache-2.0](LICENSE). Contributions welcome — see the adapter guide and conformance suite for the fastest path to supporting a new agent or provider format.
