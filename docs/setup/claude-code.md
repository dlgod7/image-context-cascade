# Set up image-context-cascade in Claude Code

Claude Code has no request-construction hook, so in-process filtering is not possible today. The deepest integration it allows is a **`SessionEnd` hook**: every time a session ends, its historical images are archived to restorable placeholders — so resumed sessions and future requests load a lean transcript instead of megabytes of stale base64.

**What you get:** automatic archiving at every session boundary. Nothing is lost — originals go to a local content-addressed store plus a `.icc-backup` file, and every archived image is restorable by hash.

**Hard rule for this task:** do not read, list, or rewrite any session/transcript files. You are only installing a CLI and adding one hook entry.

## Step 1 — install the CLI

```bash
npm install -g @image-cascade/cli
```

Verify: `image-cascade --version` prints a version. If global installs are not allowed in this environment, `npx @image-cascade/cli` works in place of `image-cascade` everywhere below (put the `npx` form in the hook command too).

## Step 2 — add the SessionEnd hook

Merge this entry into `~/.claude/settings.json` under `hooks.SessionEnd`. **Merge into the existing JSON — never overwrite the file. Show the user a diff before writing.**

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "image-cascade hook claude-code", "timeout": 60 }
        ]
      }
    ]
  }
}
```

Notes:

- The explicit `"timeout": 60` matters: Claude Code's default hook timeout is too short for a large first-time archive.
- If the user manages hooks somewhere else (a plugin's `hooks.json`, a settings sync tool that rewrites `settings.json`), add the same entry to **their** hooks source of truth instead — ask if unsure.

## Step 3 — verify

Smoke-test the hook command directly (this touches no real session):

```bash
echo {} | image-cascade hook claude-code
```

It must exit 0 silently — the hook is fail-open by design: it never blocks or fails a session end, even on malformed input.

Full verification happens naturally: after the user's next session with images ends, the transcript's historical images will be placeholders, an `.icc-backup` will sit next to the `.jsonl`, and originals will be in `~/.image-cascade/store`.

## What runs day-to-day

- On every session end, the hook reads the transcript path from the hook payload, archives historical images (current-turn content is preserved by the positional rule), writes atomically, and keeps a backup. Idempotent: a session with nothing to archive is a no-op in milliseconds.
- Hook-triggered runs **always** use the source store — every archived image is restorable:

  ```bash
  image-cascade restore <hash> --out restored.png
  ```

  Claude Code can do this itself mid-conversation: when it sees a placeholder like `[Image a1b2c3d4e5f6 omitted …]` and needs the image again, it runs the restore command in its shell, then reads the restored file with its file/image tool. No MCP server needed.
- The current session's in-flight requests are out of reach for any external tool — that's a Claude Code architectural boundary, and why this integration works at session edges. Request-level filtering needs first-party support (see the project roadmap: local proxy mode).

## Kill switch & uninstall

- `ICC_DISABLE=1` (environment variable) disables all hook-triggered processing; manual commands still work.
- `ICC_STORE_DIR=<dir>` relocates the store (default `~/.image-cascade/store`).
- Uninstall: delete the hook entry you added, then optionally `npm uninstall -g @image-cascade/cli`. Backups (`.icc-backup`) and the store directory are yours to keep or delete.
