# image-context-cascade

English | [简体中文](README.zh-CN.md)

**Request-level image lifecycle middleware for AI coding agents: keep current-turn images hot, downgrade recent history to optional thumbnails, move old pixels to restorable placeholders — before they hit your token bill, your prompt cache, or a 413.**

Zero runtime dependencies. Framework-agnostic core. Works with Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses payload shapes.

---

## The problem

**Your agent is resending pixels the model already saw.**

In one real UI-development session, screenshots consumed **86.3% of the context window** — 6,988 KB of base64 against 235 KB of actual assistant responses ([claude-code#24298]). Codex users have observed **8.34 MB request bodies** and ~5.7M prompt tokens, where a single historical tool message carried a 7.68M-char PNG data URL ([codex#28316]). Pasted screenshots have broken `/compact` itself, leaving sessions unrecoverable short of deleting the session file ([claude-code#16649]), and oversized image payloads can 413 and permanently brick a session ([claude-code#9269]).

Images are ephemeral input. After the model has seen and acted on a screenshot, the pixels are dead weight — but most agents keep them in every subsequent request, burning tokens, destabilizing prompt caches, and eventually hitting request-size limits.

Compaction can't save you here, for a structural reason: **a 413 happens the moment the request leaves your process — before any compaction runs — and images can break compaction itself** ([claude-code#16649]). The only layer where this problem is fully fixable is request construction.

`image-context-cascade` fixes it there.

## What it does

On every provider request:

- **Hot: current-turn images stay intact.** The model sees what you just attached.
- **Warm: recent historical images can become thumbnails.** Hosts can inject a deterministic `thumbnailer`; core does not ship image-processing dependencies.
- **Cold: older images become stable, restorable placeholders.** With an opt-in source store, the placeholder hash is also a restore key. Without a store, the default placeholder remains byte-compatible with v0.1.
- **Everything is measured.** Telemetry reports counts, tiers, dedupe, store errors, and estimated savings — and never contains image data.

Measured on a real 1.3 MB PNG payload: **1,296,014 chars → 315 chars (−99.98%)**. In a live session, downgrading four historical images saved ~4.17M chars per request; input tokens fell from 91,734 to 1,910 while cache reads recovered from 11,776 to 100,352.

## What this is NOT

- **Not a prompt technique.** A prompt cannot delete bytes from the request payload; this is middleware.
- **Not generic context compression.** It only manages images. Your text history is untouched.
- **Not automatic for every agent.** For fully automatic per-request handling, the host must provide request-construction hooks (Pi does; your own custom agent does too). For hosts that lack these—like Claude Code, Codex, etc.—the fallback is to use session-boundary hooks or the CLI — the [per-host table](#what-runs-day-to-day-per-host) .

## Get started — one paste to your agent

Whatever coding agent you use, paste this and let it set itself up. It reads the [setup guides](docs/setup/README.md), identifies its own host, and applies the matching guide:

```text
Read and follow https://raw.githubusercontent.com/dlgod7/image-context-cascade/main/docs/setup/README.md
— identify which agent host YOU are running in, then apply the guide for YOUR host
(Pi / Claude Code / Codex / generic). This is configuration only: do NOT read, list,
or rewrite any session/transcript files. When done, report what you changed and how to undo it.
```

Per-host guides, if you'd rather read them yourself: [Pi](docs/setup/pi.md) · [Claude Code](docs/setup/claude-code.md) · [Codex](docs/setup/codex.md) · [everything else](docs/setup/generic.md). If your agent can't fetch URLs, open the guide in a browser and paste it in.

### Optional demo — measure it on your existing sessions

Setup never reads a session file. This second paste **does** — it lists your session files and, only after showing you numbers, rewrites the ones you approve (with backups):

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
   (.icc-backup is created next to each file; --store makes every removed image restorable
   via `image-cascade restore <hash>`.)
6. Report: file, bytes before → after, images archived, backup path. Do not delete backups.
```

## What runs day-to-day (per host)

| Host | Mechanism | What you get |
|---|---|---|
| **Pi** | bundled adapter → `before_provider_request` | **Fully automatic, every request, in-process**, with restorable archive — the reference integration |
| Your own agent / framework | `cascadeImages()` at request construction | Fully automatic, every request |
| Claude Code | `SessionEnd` hook → `image-cascade hook claude-code` | Automatic at every session end; resumes load the lean transcript |
| Codex | `AGENTS.md` guidance + manual `rescue` | Semi-automatic — the agent proposes, you approve |
| Anything else | `npx @image-cascade/cli rescue` | Manual, works on any JSON/JSONL transcript |

Design guarantees that hold in every mode:

- **Archive, not delete.** Hook-triggered runs always use the source store plus a `.icc-backup`; every archived image is restorable by hash. Nothing is ever unrecoverable.
- **No content judgement.** Classification is positional and deterministic — the current turn is always kept intact. No model decides which of your images "look important".
- **Nothing resident.** No daemon, no watcher; hooks run for milliseconds at session boundaries and are a no-op when there is nothing to archive (idempotent).
- **Concurrent-write guard.** `rescue` re-checks the file's size/mtime before swapping in the rewrite and aborts if another process touched it mid-flight.
- **Kill switch.** `ICC_DISABLE=1` disables hook-triggered processing (manual commands still work); `ICC_STORE_DIR` relocates the default store. Uninstall = delete the hook entry or marked block.

## CLI reference

The CLI covers hosts without a request hook, one-off rescues of oversized sessions, and restores:

```bash
npm install -g @image-cascade/cli        # binary: image-cascade (npx @image-cascade/cli also works)

image-cascade rescue session.jsonl                 # dry-run: shows what would be saved
image-cascade rescue session.jsonl --yes           # backs up the original, then rewrites
image-cascade rescue session.jsonl --yes --store   # also archives originals for restore
image-cascade restore a1b2c3d4e5f6 --out img.png   # bring any archived image back
image-cascade hook claude-code                     # SessionEnd hook entry point (stdin payload)
```

Two streaming passes, O(1) memory, automatic backup, atomic write, malformed lines passed through untouched, idempotent. `--store` writes a local content-addressed store under `~/.image-cascade/store` (override with `ICC_STORE_DIR`). The placeholder hash identifies the stored object — it is the hash of the original base64 text, not the byte hash of the restored file.

Where session files live:

- **Claude Code**: `~/.claude/projects/<project>/*.jsonl` — measured on a real 381-line session: **6.26 MB → 1.36 MB (−78%)**, 35 historical attachments downgraded, every line still valid JSON.
- **Codex**: `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl` — measured on a real 332-line rollout: **50.2 MB → 2.26 MB (−95.5%)**. Codex stores each generated image *twice* as bare base64 (`image_generation_call` response item + `image_generation_end` event), so image-heavy Codex sessions collapse dramatically.

**Do not rewrite a session that is currently open.** The agent process may be appending to the file. Close the session first, or work on a copy. Rescuing *other* sessions while an agent is running is fine.

## Bring a downgraded image back

With `rescue --yes --store`, a cold placeholder contains the short hash needed to restore the original bytes. Claude Code does not need an MCP server for the loop: if the agent has a shell tool and a file-reading/image-reading tool, it can restore the image as a normal file and inspect it as current-turn content.

Example flow:

```text
User: Please look again at Image a1b2c3d4e5f6.
Assistant shell: image-cascade restore a1b2c3d4e5f6 --out restored-a1b2c3d4e5f6.png
Assistant: reads restored-a1b2c3d4e5f6.png with the host file/image tool, then answers from the restored current-turn content.
```

Restore appends new current content. It does not rewrite old transcript bytes, so it does not destroy prompt-cache prefixes.

## Use the library (agent & framework authors)

If your agent has a request-construction hook, run the cascade in-process — that's the fully-automatic tier in the table above:

```bash
npm install image-context-cascade
```

```ts
import { cascadeImages } from "image-context-cascade";

// Wherever your agent builds the provider request:
const { payload, mutated, telemetry } = cascadeImages(requestPayload);

// payload: historical images replaced with stable placeholders,
//          current-turn images untouched
// telemetry: { found, current, downgraded, estimatedSavedChars, ... }
//            — counts and hashes only, never image data
```

That's the default **positional strategy**: images at or after the last user message are current; everything earlier is downgraded. It is stateless — safe across restarts, and correct for proxies that see each request fresh.

## How it works

```
                      ┌────────────────────────────────────────────┐
 agent loop           │  provider request payload                  │
 ───────────►  build  │  [ msg1(img A) msg2 msg3(img B) msg4(img C)│──► cascade ──► wire
                      └────────────────────────────────────────────┘        │
                                                                            ▼
                                              img A, B → [Image a1b2c3d4e5f6 omitted …]
                                              img C (current turn) → sent intact
```

1. **Find** — walk the payload; match image blocks per provider format (Anthropic base64 blocks, OpenAI Chat `image_url`, OpenAI Responses `input_image`, data URIs, and bare-base64 `image_generation_call` results), plus Anthropic base64 `document` attachments (e.g. PDFs), which cause the same historical-resend problem. Blocks are matched wherever they sit — content arrays, item-level entries in a message list, or object fields in a transcript line.
2. **Classify** — each image is `current`, `historical`, or `unknown`, via a pluggable strategy.
3. **Tier** — current images remain hot; historical images can be warm thumbnails or cold placeholders, according to an injected tier policy and thumbnailer.
4. **Store and restore** — when a source store is enabled, original bytes are stored locally by content hash, and cold placeholders can be restored later with `image-cascade restore <hash>`.
5. **Report** — telemetry with counts, per-format stats, tiers, dedupe, store errors, and estimated savings. No base64, ever.

## Strategies

### `positionalStrategy()` — the default

Classifies by position: images at or after the last user message in a message array are current; earlier ones are historical.

**Why this is safe:** any image sitting in an earlier message was necessarily sent in full in an earlier request — the model has already seen it. No cross-request state is needed, so restarts lose nothing and stateless proxies work. When no user-message boundary can be found, it fails open and retains everything.

### `trackerStrategy({ currentTurnHashes, tracker })`

For hosts that know exactly which images belong to the current turn (e.g. an agent framework with a turn-start hook):

```ts
import { cascadeImages, trackerStrategy, InMemoryTracker } from "image-context-cascade";

const tracker = new InMemoryTracker();          // LRU, 200 entries
// at turn start: collect hashes of newly attached images into currentTurnHashes

const result = cascadeImages(payload, {
  strategy: trackerStrategy({ currentTurnHashes, tracker }),
});
```

Tracker mode adds one safety refinement: an image that is neither current nor previously tracked is **unknown**, and passes through intact once before becoming eligible for downgrade. Use it when transcripts may be edited out-of-band or when you need per-image lifecycle control.

## Writing an adapter

An adapter is the glue between your agent's hooks and the core — the [Pi reference adapter](packages/adapters/pi/src/index.ts) is 99 lines including the full store/restore wiring:

1. On request construction, call `cascadeImages(payload, options)` and forward the (possibly mutated) payload.
2. Optionally, on turn start, record current-turn image hashes and use `trackerStrategy`.
3. Send `telemetry` wherever your host logs — it is safe by construction (no image data fields exist in its type).

New provider format? Implement a `BlockMatcher` (`match(block)` / `replace(block, text)`) and pass it via `formats`. Do **not** reimplement classification, placeholders, or traversal — that's how behavior drift happens. Run the conformance suite (`@image-cascade/conformance`) to verify your adapter preserves current-turn images, downgrades historical ones, keeps placeholders byte-stable, and leaks nothing into telemetry.

## Privacy & safety guarantees

- **No image data leaves the process boundary it was already in.** The library only ever *removes* image bytes from payloads; it adds nothing but short text placeholders.
- **Telemetry cannot contain image data.** The `CascadeTelemetry` type has no field that could hold base64; a conformance test additionally asserts the serialized telemetry never matches image-data patterns.
- **Only a 12-char one-way hash prefix enters the context.** No filenames, no paths, no pixel data.
- **Current-turn images are never touched.** Enforced by tests (`current_turn_images_never_touched`), and the positional strategy fails open when it cannot establish a boundary.

## Limitations

- Remote URL references are not stored. The source store persists base64/data-URI bytes that are present in the payload; it does not fetch URLs.
- Exact-byte identity only: the same image re-encoded or resized hashes differently. Perceptual hashing is future research.
- Warm thumbnails require a host-injected deterministic `thumbnailer`. Core and CLI do not depend on Sharp or any other image-processing library.
- Closed agents without request-construction hooks cannot run the middleware in-process. Claude Code gets the next-best thing — automatic archiving at session boundaries via its `SessionEnd` hook; Codex is manual/agent-suggested today (its new hooks system has no session-end event yet, and transcript rewrite mid-session is riskier than at boundaries).
- Rescue guarantees the rewritten file is lean, valid JSONL, and fully restorable — it does not guarantee the host will *resume* an old session. Field test: a 17.4 MB Codex rollout that 413'd on resume (dead) became sendable after rescue (2.5 MB), but Codex then refused it on a validation unrelated to our rewrite (zero image fields left in the file; the trigger sits in encrypted reasoning). Old-session resume is best-effort; the `.icc-backup` always restores the original bytes.

## Roadmap

- **v0.1** — core with positional + tracker strategies, built-in matchers for three provider image formats plus Anthropic document attachments, session rescue CLI, Pi reference adapter, conformance harness with a language-neutral corpus, verified benchmarks.
- **v0.2** — opt-in source store, hot/warm/cold tiered downgrade model, injected thumbnailer interface, restorable placeholders, `image-cascade restore`, same-payload byte dedupe, and the Claude Code zero-component restore loop through shell + file tools.
- **v0.2.1** — Codex rollout sessions verified end-to-end; new matcher for bare-base64 `image_generation_call` / `image_generation_end` results; traversal now catches item-level and object-field blocks, not just content-array members.
- **v0.2.2 (this release)** — hands-free Claude Code integration (`image-cascade hook claude-code` + SessionEnd hook), `ICC_DISABLE` kill switch, `ICC_STORE_DIR`, concurrent-write guard, decoded-byte magic sniffing (adds BMP/TIFF/AVIF/HEIC, fixes RIFF false positives), format-derived restore filenames.
- **v0.3 planned** — budget-driven downgrade, more lifecycle-hook hosts (Cursor ships `sessionEnd`; Codex hooks are new and still lack one), an optional MCP server for hosts without a shell tool, and a local proxy mode for request-time downgrade under any agent.
- **Future research** — perceptual hashing for near-duplicate images; persistent cross-session trackers with safe privacy defaults.

## Prior art & acknowledgements

The Claude Code and Codex communities independently articulated this problem and sketched similar solutions — image-aware compaction, ephemeral image flags, `/drop-images`, and sha256 placeholders ([claude-code#24298], [codex#28316]). This project exists to turn those sketches into a correct, installable, framework-agnostic implementation. **If coding agents ship native image lifecycle management, this project has done its job.**

Related projects solving *different* problems:

- [pi-vision-proxy](https://github.com/pungggi/pi-vision-proxy) and [opencode-vision-paste](https://github.com/wsaaaqqq/opencode-vision-paste) route images through a vision model so *text-only* models can use them. They make images readable; `image-context-cascade` manages the lifecycle of images a *multimodal* model has already read. The two are complementary.
- [context-cascade](https://github.com/DNYoussef/context-cascade) is a Claude Code plugin architecture for layered context loading — no relation beyond the name.

## Acknowledgments
1. Thanks to the [linux.do](https://linux.do) community for the feedback, discussions, and inspiration during the development process.
2. Thanks to Fable-5 (under Claude Code) for their contributions to the project.

## License

[Apache-2.0](LICENSE). Contributions welcome — see the adapter guide and conformance suite for the fastest path to supporting a new agent or provider format.

[claude-code#9269]: https://github.com/anthropics/claude-code/issues/9269
[claude-code#16649]: https://github.com/anthropics/claude-code/issues/16649
[claude-code#24298]: https://github.com/anthropics/claude-code/issues/24298
[codex#28316]: https://github.com/openai/codex/issues/28316
