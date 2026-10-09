# Set up image-context-cascade in Codex

Codex ships a real `SessionEnd` hook, so this can be **automatic**: a hook entry in `~/.codex/hooks.json` runs `image-cascade hook codex` when a session ends, and that session's historical images get archived without you doing anything. A marked block in `~/.codex/AGENTS.md` is still installed as a fallback and to explain the placeholders.

Details that shape the setup: Codex gives a `SessionEnd` hook a **hard 3-second budget** and then kills its process group, and the rollout file may still be flushing when the hook fires. So `hook codex` reads the payload, hands the work to a detached worker, and exits; the worker waits for the file to settle, then rescues it. The process Codex kills never touches the transcript — the hook only reads stdin and hands off — so a timeout can't interrupt a rewrite; every failure path exits 0 and only logs a line.

**What you get:** image-heavy Codex rollouts shrink automatically at session end — a real 332-line rollout went **50.2 MB → 2.26 MB (−95.5%)**, because Codex stores each generated image *twice* as bare base64. Every archived image stays restorable, and Codex understands the placeholders it produces.

**Hard rule for this task:** do not read, list, or rewrite any session/transcript files. You are only installing a CLI and editing config/instruction files. A SessionEnd hook fires for the session that is ending — never write anything that touches a session that is still open.

## Step 1 — install the CLI

```bash
npm install -g @image-cascade/cli
```

Verify: `image-cascade --version` prints a version. If global installs are not allowed, use `npx @image-cascade/cli` in place of `image-cascade` below.

## Step 2 — register the SessionEnd hook in `~/.codex/hooks.json`

Merge this into `~/.codex/hooks.json` (create the file if missing; keep any existing hooks). The command needs no arguments — Codex passes the hook payload as JSON on stdin, including `transcript_path`:

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "image-cascade hook codex", "timeout": 3 } ] }
    ]
  }
}
```

`timeout` is documented as seconds. Codex caps `SessionEnd` at 3 seconds regardless, which is why the CLI's real work happens in a detached worker — the hook only has to read stdin and hand off.

Verify the file parses: `node -e "JSON.parse(require('fs').readFileSync(process.env.HOME + '/.codex/hooks.json','utf8')); console.log('ok')"`.

## Step 3 — trust the hook (required, or it will not run)

Codex refuses to run **untrusted** user hooks. Trust state lives in `~/.codex/config.toml` under `[hooks.state]`, keyed by file, event, and handler position:

```toml
[hooks.state]
"/home/you/.codex/hooks.json:session_end:0:0" = { trusted_hash = "..." }
```

The easiest way to create it: open the Codex TUI and run `/hooks`, then approve the pending `SessionEnd` hook. (Non-interactively, `codex --dangerously-bypass-hook-trust` skips the gate.) If you edit this hook later, the hash no longer matches and Codex asks again — a useful safety property, not a bug.

## Step 4 — add the marked block to `~/.codex/AGENTS.md` (fallback)

Append this block to `~/.codex/AGENTS.md` (create the file if missing). **Append — never overwrite existing content. Keep the markers exactly, so the block can be removed cleanly later.**

```markdown
<!-- image-context-cascade:start -->
Session files under ~/.codex/sessions accumulate base64 images that burn tokens.
When I mention heavy/slow sessions, offer: `image-cascade rescue <file>` (dry-run first,
`--yes --store` after my approval). Never rewrite the currently open session. A placeholder
like [Image <hash> omitted; restorable via image-cascade restore <hash>] means the original
is stored locally — run that restore command if the image is needed again.
<!-- image-context-cascade:end -->
```

## Step 5 — verify

1. `image-cascade --version` prints a version.
2. `~/.codex/hooks.json` parses and contains the `SessionEnd` entry; the hook shows as trusted (Step 3).
3. The block is present in `~/.codex/AGENTS.md` with both markers, and everything that was in the file before is untouched.
4. Optional: run `image-cascade hook codex --sync` and pipe a JSON payload with a `transcript_path` to a **closed** rollout file you no longer need; a summary prints, or a `skipping` line if the file is missing. Add `--json` for machine-readable stats.

## What runs day-to-day

- A session ends → Codex runs the hook → a detached worker waits for the rollout to settle, archives its historical images, and logs to `~/.image-cascade/hook-codex.log`. Nothing is resident and nothing touches the session that is still open.
- Codex session files live under `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`.
- Closed sessions are fair game any time. To handle one manually (or if the hook is disabled):

  ```bash
  image-cascade rescue <rollout-file>                # dry-run: shows what would be saved
  image-cascade rescue <rollout-file> --yes --store  # backup, rewrite, archive originals
  ```

- **Never rescue the currently open session by hand** — the Codex process may still be appending to it. The hook is safe because it fires at the session *end*, and the worker additionally waits for the file to stop changing.
- Every archived image is restorable: `image-cascade restore <hash> --out img.png`.

## Resuming a rescued rollout — what to expect

Field-tested on a real 17.4 MB rollout (2026-05, image-heavy):

- **Before rescue**: `codex exec resume` could not even reach the API — the 17.4 MB body died with `413 Payload Too Large` after 5 retries. The session was already dead.
- **After rescue** (2.5 MB): the request went through and the turn started. In this particular test the resume was then refused by Codex's own image validation — with *zero* image fields left in the file, the trigger sits inside encrypted reasoning blobs that no external tool can (or should) touch.

So: rescue reliably makes the file lean, valid, analyzable, and every image restorable — and can bring a 413-dead session back within request-size limits. Whether Codex ultimately accepts an old session on resume also depends on Codex-side checks that are outside image scope. Treat resume of *old* rescued rollouts as best-effort; the `.icc-backup` next to the file always brings the original back byte-for-byte.

If a rescued rollout is refused on resume with an image error, try `rescue <file> --all` (downgrades current-turn images too — fine for archived sessions you only want readable/resumable, not for sessions where the last turn's images still matter).

## Kill switch & uninstall

- `ICC_DISABLE=1` disables hook-triggered processing (the hook exits 0 and logs a skip); manual commands always work. It must be set in the environment Codex itself runs in.
- Uninstall: remove the `SessionEnd` entry from `~/.codex/hooks.json` (and its `[hooks.state]` entry in `~/.codex/config.toml`), delete the marked block (everything between and including the two markers), then optionally `npm uninstall -g @image-cascade/cli`.
