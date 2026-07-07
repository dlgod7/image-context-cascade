# Set up image-context-cascade in any other agent

Not Pi, not Claude Code, not Codex? Your integration depth depends on what your host exposes. Walk this decision tree top to bottom and take the first branch that matches.

**Hard rule for this task:** do not read, list, or rewrite any session/transcript files. Configuration only.

## First, install the CLI (all branches use it)

```bash
npm install -g @image-cascade/cli
```

Verify: `image-cascade --version`. If global installs are not allowed, use `npx @image-cascade/cli` instead of `image-cascade` everywhere below.

## Branch A — your host has a request-construction hook

(You can run code on the outgoing provider payload before it is sent — a middleware layer, a plugin API with a pre-request event, or you *are* the framework author.)

This is the best case: fully automatic, every request. Use the library instead of the CLI:

```bash
npm install image-context-cascade
```

```ts
import { cascadeImages } from "image-context-cascade";
const { payload, mutated, telemetry } = cascadeImages(requestPayload);
// send `payload` instead of the original
```

The default positional strategy is stateless and safe across restarts. Writing a full adapter is ~40–60 lines — follow the [adapter guide](../adapter-guide.md) and validate with the conformance suite (`@image-cascade/conformance`). Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses payload shapes are matched out of the box.

## Branch B — your host has a session-lifecycle hook that passes a transcript path

(Something like `sessionEnd` / `onSessionClose` that runs a command with the session file path — Cursor ships `sessionEnd`, for example.)

Wire the CLI into it so every finished session is archived automatically:

```bash
image-cascade rescue <transcript-path> --yes --store
```

- `--store` makes every archived image restorable via `image-cascade restore <hash>`.
- A `.icc-backup` is written next to the file; the rewrite is atomic and idempotent.
- Give the hook a generous timeout (60s) for large first-time archives.
- If your host's hook payload format matches Claude Code's (JSON with a `transcript_path` field on stdin), `image-cascade hook claude-code` works as-is.

## Branch C — neither

Manual mode. The CLI works on any JSON/JSONL transcript regardless of host:

```bash
image-cascade rescue <file>                # dry-run: shows savings, writes nothing
image-cascade rescue <file> --yes --store  # backup, rewrite, archive originals
image-cascade restore <hash> --out img.png # bring any archived image back
```

Then teach your host about it: if it reads an instruction file (AGENTS.md or equivalent), append a marked block like the one in the [Codex guide](codex.md) so the agent proposes rescues when sessions get heavy. **Never rewrite the currently open session** — the host process may be appending to it.

## Verify (all branches)

- Branch A: paste an image, next turn check `telemetry.downgraded >= 1` and that the current-turn image was untouched.
- Branch B: end a session with images, confirm the transcript now holds placeholders, an `.icc-backup` exists, and originals are in `~/.image-cascade/store`.
- Branch C: dry-run any *closed* image-heavy transcript copy and confirm it reports savings.

## Kill switch & uninstall

- `ICC_DISABLE=1` disables hook-triggered processing; `ICC_STORE_DIR` relocates the store.
- Uninstall: remove whatever you added (middleware call, hook entry, or marked block), then optionally `npm uninstall -g @image-cascade/cli`.

## Tell us what host you set up

If you got a new host working — especially Branch A or B — a short issue at <https://github.com/dlgod7/image-context-cascade/issues> with the host name and what hook you used helps the next person (and the roadmap).
