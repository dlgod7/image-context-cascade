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
- **Not automatic for every agent.** Your agent needs a request-construction hook. Writing an adapter is ~40–60 lines (see the [Pi reference adapter](packages/adapters/pi/src/index.ts)); the conformance suite tells you when it's right.

## Quick start

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

## Rescue an oversized session (CLI)

For agents without a request-construction hook — Claude Code included — the CLI rewrites bloated session files offline:

```bash
npx @image-cascade/cli rescue path/to/session.jsonl                 # dry-run: shows what would be saved
npx @image-cascade/cli rescue path/to/session.jsonl --yes           # backs up the original, then rewrites
npx @image-cascade/cli rescue path/to/session.jsonl --yes --store   # also stores downgraded originals locally

# Later: restore by the placeholder hash.
npx @image-cascade/cli restore a1b2c3d4e5f6 --out restored.png
```

Or install globally with `npm install -g @image-cascade/cli` — the binary is named `image-cascade`.

Two streaming passes, O(1) memory, automatic backup, atomic write, malformed lines passed through untouched, idempotent. `--store` is opt-in and writes a local content-addressed source store under `~/.image-cascade/store` unless you pass a directory. Measured on a real 381-line Claude Code session: **6.26 MB → 1.36 MB (−78%)**, 35 historical attachments downgraded, every line still valid JSON, current-turn content untouched.

## Bring a downgraded image back

With `rescue --yes --store`, a cold placeholder contains the short hash needed to restore the original bytes. Claude Code does not need an MCP server for the loop: if the agent has a shell tool and a file-reading/image-reading tool, it can restore the image as a normal file and inspect it as current-turn content.

Example flow:

```text
User: Please look again at Image a1b2c3d4e5f6.
Assistant shell: image-cascade restore a1b2c3d4e5f6 --out restored-a1b2c3d4e5f6.png
Assistant: reads restored-a1b2c3d4e5f6.png with the host file/image tool, then answers from the restored current-turn content.
```

Restore appends new current content. It does not rewrite old transcript bytes, so it does not destroy prompt-cache prefixes.

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

1. **Find** — walk the payload; match image blocks per provider format (Anthropic base64 blocks, OpenAI Chat `image_url`, OpenAI Responses `input_image`, data URIs), plus Anthropic base64 `document` attachments (e.g. PDFs), which cause the same historical-resend problem.
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

An adapter is the glue between your agent's hooks and the core — the [Pi reference adapter](packages/adapters/pi/src/index.ts) is 57 lines:

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
- Closed agents without request-construction hooks (e.g. Claude Code today) cannot run the middleware in-process; use the [rescue CLI](#rescue-an-oversized-session-cli) to rewrite session files offline instead.

## Roadmap

- **v0.1** — core with positional + tracker strategies, built-in matchers for three provider image formats plus Anthropic document attachments, session rescue CLI, Pi reference adapter, conformance harness with a language-neutral corpus, verified benchmarks.
- **v0.2 (this release)** — opt-in source store, hot/warm/cold tiered downgrade model, injected thumbnailer interface, restorable placeholders, `image-cascade restore`, same-payload byte dedupe, and the Claude Code zero-component restore loop through shell + file tools.
- **v0.3 planned** — budget-driven downgrade, richer host adapters, and an optional MCP server for hosts that do not expose a shell tool.
- **Future research** — perceptual hashing for near-duplicate images; persistent cross-session trackers with safe privacy defaults.

## Prior art & acknowledgements

The Claude Code and Codex communities independently articulated this problem and sketched similar solutions — image-aware compaction, ephemeral image flags, `/drop-images`, and sha256 placeholders ([claude-code#24298], [codex#28316]). This project exists to turn those sketches into a correct, installable, framework-agnostic implementation. **If coding agents ship native image lifecycle management, this project has done its job.**

Related projects solving *different* problems:

- [pi-vision-proxy](https://github.com/pungggi/pi-vision-proxy) and [opencode-vision-paste](https://github.com/wsaaaqqq/opencode-vision-paste) route images through a vision model so *text-only* models can use them. They make images readable; `image-context-cascade` manages the lifecycle of images a *multimodal* model has already read. The two are complementary.
- [context-cascade](https://github.com/DNYoussef/context-cascade) is a Claude Code plugin architecture for layered context loading — no relation beyond the name.

## License

[Apache-2.0](LICENSE). Contributions welcome — see the adapter guide and conformance suite for the fastest path to supporting a new agent or provider format.

[claude-code#9269]: https://github.com/anthropics/claude-code/issues/9269
[claude-code#16649]: https://github.com/anthropics/claude-code/issues/16649
[claude-code#24298]: https://github.com/anthropics/claude-code/issues/24298
[codex#28316]: https://github.com/openai/codex/issues/28316
