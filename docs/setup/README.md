# Agent setup — start here

You are an AI coding agent asked to set up `image-context-cascade` for your user. Follow this file top to bottom.

**What this does for your user:** their agent sessions stop accumulating stale base64 image payloads. Current-turn images stay intact; historical images become small restorable placeholders. Fewer tokens, stabler prompt cache, no 413s.

**Hard rules for the whole task:**

1. This is configuration only. Do **not** read, list, or rewrite any session/transcript files.
2. When editing config files: merge, never overwrite. Keep everything that is already there.
3. When you are done, report exactly what you changed, where, and how to undo it.

## Step 1 — identify your host

Determine which agent host **you** are running in right now. Do not guess from the examples below — check your actual environment (your system prompt, your tool names, your config paths).

## Step 2 — open the guide for your host and follow it

| Your host | Guide | Raw URL (fetch this) |
|---|---|---|
| Pi (`pi-coding-agent`) | [pi.md](pi.md) | `https://raw.githubusercontent.com/dlgod7/image-context-cascade/main/docs/setup/pi.md` |
| Claude Code | [claude-code.md](claude-code.md) | `https://raw.githubusercontent.com/dlgod7/image-context-cascade/main/docs/setup/claude-code.md` |
| Codex | [codex.md](codex.md) | `https://raw.githubusercontent.com/dlgod7/image-context-cascade/main/docs/setup/codex.md` |
| Anything else | [generic.md](generic.md) | `https://raw.githubusercontent.com/dlgod7/image-context-cascade/main/docs/setup/generic.md` |

If you cannot fetch URLs, tell your user to open the guide in a browser and paste it to you.

## Step 3 — report

After finishing your host guide, tell your user:

- what you installed and what you changed (exact file paths),
- how to undo it (each guide has an Uninstall section),
- the kill switch: `ICC_DISABLE=1` disables all hook-triggered processing,
- that `ICC_STORE_DIR` relocates the local store (default `~/.image-cascade/store`).

## Background, if your user asks

- Project: <https://github.com/dlgod7/image-context-cascade> (Apache-2.0)
- Why request-level: a 413 happens the moment the request leaves the process — compaction never gets to run, and images can break compaction itself.
- Privacy: everything is local. Telemetry contains counts and hashes, never image data. The optional source store writes only to the user's own disk.
