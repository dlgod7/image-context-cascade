# Set up image-context-cascade in Codex

Codex has no session-end hook today (its hooks system is new and doesn't ship one yet), and rewriting a session mid-flight is riskier than at boundaries. So the honest integration level is **agent-suggested, user-approved**: a marked block in `~/.codex/AGENTS.md` teaches Codex when to offer the rescue command, and you approve each run.

**What you get:** Codex knows the tool exists, proposes it when sessions get heavy, understands the placeholders it produces, and can restore any archived image on request. Image-heavy Codex rollouts shrink dramatically — a real 332-line rollout went **50.2 MB → 2.26 MB (−95.5%)**, because Codex stores each generated image *twice* as bare base64.

**Hard rule for this task:** do not read, list, or rewrite any session/transcript files. You are only installing a CLI and appending a marked block to an instruction file.

## Step 1 — install the CLI

```bash
npm install -g @image-cascade/cli
```

Verify: `image-cascade --version` prints a version. If global installs are not allowed, use `npx @image-cascade/cli` in place of `image-cascade` below.

## Step 2 — add the marked block to `~/.codex/AGENTS.md`

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

## Step 3 — verify

1. `image-cascade --version` prints a version.
2. The block is present in `~/.codex/AGENTS.md` with both markers, and everything that was in the file before is untouched.

## What runs day-to-day

- Codex session files live under `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`.
- When a session feels heavy or slow, Codex (having read AGENTS.md) offers the rescue flow:

  ```bash
  image-cascade rescue <rollout-file>                # dry-run: shows what would be saved
  image-cascade rescue <rollout-file> --yes --store  # backup, rewrite, archive originals
  ```

- **Never rescue the currently open session** — the Codex process may still be appending to it. Closed sessions are fair game any time, including while Codex runs elsewhere.
- Every archived image is restorable: `image-cascade restore <hash> --out img.png`.

## Kill switch & uninstall

- `ICC_DISABLE=1` disables hook-triggered processing (Codex has none today, so this is future-proofing); manual commands always work.
- Uninstall: delete the marked block (everything between and including the two markers), then optionally `npm uninstall -g @image-cascade/cli`.
