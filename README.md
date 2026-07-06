# image-context-cascade

**Request-level image lifecycle middleware for AI coding agents: keep current-turn images, downgrade historical ones to stable placeholders — before they hit your token bill, your prompt cache, or a 413.**

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

- **Current-turn images stay intact.** The model sees what you just attached.
- **Historical images become stable text placeholders.** Byte-identical across requests, so prompt caches keep hitting.
- **Everything is measured.** Telemetry reports counts and estimated savings — and never contains image data.

Measured on a real 1.3 MB PNG payload: **1,296,014 chars → 315 chars (−99.98%)**. In a live session, downgrading four historical images saved ~4.17M chars per request; input tokens fell from 91,734 to 1,910 while cache reads recovered from 11,776 to 100,352.

## What this is NOT

- **Not a prompt technique.** A prompt cannot delete bytes from the request payload; this is middleware.
- **Not generic context compression.** It only manages images. Your text history is untouched.
- **Not automatic for every agent.** Your agent needs a request-construction hook. Writing an adapter is ~40–60 lines (see the [Pi reference adapter](packages/adapters/pi/src/index.ts)); the conformance suite tells you when it's right.
- **Not image recovery (yet).** Placeholders instruct the model to ask the user to re-attach an image when the original is truly needed. See [Roadmap](#roadmap).

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

1. **Find** — walk the payload; match image blocks per provider format (Anthropic base64 blocks, OpenAI Chat `image_url`, OpenAI Responses `input_image`, data URIs).
2. **Classify** — each image is `current`, `historical`, or `unknown`, via a pluggable strategy.
3. **Replace** — historical images become a deterministic placeholder carrying a 12-char content hash. Same image, same bytes, every request — that's what keeps your prompt cache alive.
4. **Report** — telemetry with counts, per-format stats, and estimated savings. No base64, ever.

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

- If your workflow requires the model to re-examine original pixels across many turns (e.g. pixel-perfect visual diffing), downgrading historical images will hurt — keep those sessions short or retain images (custom strategy) until lifecycle policies land in v0.2.
- The model can no longer "look again" at a downgraded image on its own; the placeholder instructs it to ask the user to re-attach. Automatic re-inspection needs the source store planned for a later release.
- Closed agents without request-construction hooks (e.g. Claude Code today) cannot use the middleware directly; see the transcript rescue CLI on the roadmap.
- Exact-duplicate detection only: the same image re-encoded or resized hashes differently (perceptual hashing is future research).

## Roadmap

- **v0.1 (this release)** — core with positional + tracker strategies, three built-in provider matchers, Pi reference adapter, conformance harness, verified benchmarks.
- **v0.2** — transcript rescue CLI (offline rewrite of image-bloated session files — first aid for sessions that compaction can no longer save); request-proxy integration (zero-adapter path built on the positional strategy); lifecycle policies (`retain` / `ephemeral` / `summarize` / `drop`); image summary store (placeholders carry a compact description inline); official OpenAI / Anthropic SDK middleware adapters.
- **Future research** — perceptual hashing for near-duplicate images; source store + on-demand re-inspection tool; persistent cross-session trackers with safe privacy defaults.

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
