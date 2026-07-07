# image-context-cascade

**Request-level image lifecycle middleware for AI coding agents: keep current-turn images, downgrade historical ones to stable placeholders — before they hit your token bill, your prompt cache, or a 413.**

Zero runtime dependencies. Framework-agnostic. Works with Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses payload shapes, plus base64 data URIs and Anthropic document (PDF) attachments.

## Why

Agents keep resending pixels the model already saw. In one real UI-development session, screenshots consumed **86.3% of the context window**; oversized image payloads can break `/compact` or 413 the whole session. After the model has acted on a screenshot, those bytes are dead weight in every subsequent request — burning tokens and destabilizing prompt caches.

Compaction can't fix this: a 413 happens before compaction runs, and images can break compaction itself. The only layer where it's fully fixable is request construction. This library fixes it there.

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
// telemetry: counts and hashes only — never image data
```

The default **positional strategy** is stateless: images at or after the last user message are current, everything earlier is downgraded. Safe across restarts, correct for proxies. A `trackerStrategy` is available for hosts that know exactly which images belong to the current turn.

Measured on a real 1.3 MB PNG payload: **1,296,014 chars → 315 chars (−99.98%)**, with placeholders byte-identical across requests so prompt caches keep hitting.

## Guarantees

- Current-turn images are never touched (enforced by tests; fails open when no boundary is found).
- Placeholders are byte-stable — same image, same bytes, every request.
- Telemetry structurally cannot contain image data; only a 12-char one-way hash prefix enters the context.
- Zero runtime dependencies; `./web` subpath export for non-Node runtimes (bring your own hasher).

## Ecosystem

- **[GitHub repository](https://github.com/dlgod7/image-context-cascade)** — full README, pattern doc, adapter guide, security notes.
- **[@image-cascade/cli](https://www.npmjs.com/package/@image-cascade/cli)** — rescue oversized session files offline (works for Claude Code sessions).
- **[@image-cascade/conformance](https://www.npmjs.com/package/@image-cascade/conformance)** — conformance suite + language-neutral corpus for adapter authors.

Apache-2.0.
