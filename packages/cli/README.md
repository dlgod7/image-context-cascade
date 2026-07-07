# @image-cascade/cli

**Rescue CLI for oversized agent session files: downgrades historical base64 images to short stable placeholders, offline.**

For agents without a request-construction hook — Claude Code included — this rewrites bloated `.jsonl` session files (or single JSON documents) so they stop resending megabytes of pixels the model already saw.

## Usage

```bash
npx @image-cascade/cli rescue path/to/session.jsonl        # dry-run: shows what would be saved
npx @image-cascade/cli rescue path/to/session.jsonl --yes  # backs up the original, then rewrites
```

Or install globally — the binary is named `image-cascade`:

```bash
npm install -g @image-cascade/cli
image-cascade rescue path/to/session.jsonl --yes
image-cascade --version
```

Options:

- `--yes` — write changes. Default is dry-run and writes nothing.
- `--all` — downgrade all image blocks, including when no user-message boundary is found (default is to keep everything in that case).
- `--json` — machine-readable statistics.
- `--version`, `-v` / `--help`, `-h`.

## Claude Code SessionEnd hook

`image-cascade hook claude-code` reads a Claude Code hook payload from stdin and archives that session's historical images. It always uses the source store, is fail-open, and is intended for `SessionEnd` hooks.

```bash
echo '{}' | image-cascade hook claude-code
```

Environment variables:

- `ICC_DISABLE=1` — kill switch for hook-triggered processing.
- `ICC_STORE_DIR=/path/to/store` — override the default store directory.

## Safety properties

- **Dry-run by default** — nothing is written without `--yes`.
- **Automatic backup** — the original is copied to `<file>.icc-backup` before rewriting.
- **Atomic write** — output goes to a temp file, then renames over the original; a crash never leaves a half-written session.
- **Malformed lines pass through untouched**, and the line count never changes.
- **Idempotent** — rerunning on a rescued file finds nothing left to downgrade.
- **Two streaming passes, O(1) memory** — a multi-GB JSONL session never gets loaded whole.
- Current-turn images (at or after the last user message) are kept intact.

Measured on a real 381-line Claude Code session: **6.26 MB → 1.36 MB (−78%)**, every line still valid JSON.

Built on [image-context-cascade](https://www.npmjs.com/package/image-context-cascade) — see the [GitHub repository](https://github.com/dlgod7/image-context-cascade) for the full story, docs, and the request-level middleware that prevents the bloat in the first place.

Apache-2.0.
