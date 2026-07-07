# Set up image-context-cascade in Pi

Pi (`pi-coding-agent`) is the reference host: it exposes a request-construction hook (`before_provider_request`), so it gets the **deepest integration this project offers — fully automatic, on every provider request, in-process**. No CLI cron jobs, no session rewriting: stale images never leave the process in the first place.

**What you get:** every provider request is filtered live. Current-turn images pass through intact; images from earlier turns are archived to a local content-addressed store and replaced with restorable placeholders before the request is sent. Works from the first turn after install, forever, with zero day-to-day interaction — and any archived image can be brought back by the hash in its placeholder.

## Step 1 — get the adapter file

Download the bundled Pi adapter into your Pi extensions directory (global: `~/.pi/agent/extensions/`):

```bash
curl -fsSL https://raw.githubusercontent.com/dlgod7/image-context-cascade/main/packages/adapters/pi/src/index.ts \
  -o ~/.pi/agent/extensions/image-context-cascade.ts
```

(On Windows the directory is `%USERPROFILE%\.pi\agent\extensions\`. A project-local `.pi/extensions/` directory works too if you prefer per-project scope.)

The adapter is ~57 lines — read it before installing if you like: it wires three Pi events (`before_agent_start`, `before_provider_request`, `after_provider_response`) to the core library and does nothing else.

## Step 2 — install the core library where Pi resolves imports

The adapter imports the `image-context-cascade` npm package. Install it so Node/Bun module resolution can find it from the extensions directory — that means a `node_modules` in `~/.pi/agent/` or any parent of your extensions directory:

```bash
cd ~/.pi/agent
# if there is no package.json here yet: npm init -y
npm install image-context-cascade
```

If your Pi config keeps dependencies elsewhere (some setups use a dedicated npm prefix directory), install into whatever location your existing extensions already resolve imports from — check where other extensions' dependencies live.

Verify resolution before restarting (run from the directory you installed into):

```bash
bun -e "import('image-context-cascade').then(m => console.log(typeof m.cascadeImagesAsync))"
# must print: function
```

## Step 3 — restart Pi and verify

Restart Pi so it loads the new extension. Then verify with a real image:

1. Paste any screenshot and ask something about it. The model should answer normally — **current-turn images are never touched**.
2. Next turn, ask anything else. The previous image is now downgraded in the outgoing request.
3. Check the session log for a `image-context-cascade.telemetry` entry: it reports `found` / `current` / `downgraded` counts and estimated saved chars. Telemetry never contains image data.

If Pi fails to start or the extension errors: the adapter fails open by design (a broken cascade must never break the agent), but if you need to back out, see Uninstall below.

## What runs day-to-day

Nothing you have to think about. The adapter classifies images with `trackerStrategy` (per-image lifecycle: current-turn hashes tracked at turn start, unknown images pass through intact once before becoming eligible for downgrade). Every provider request is processed in-process, in microseconds, with no daemon and no disk writes.

Two Pi-specific niceties the adapter adds:

- On turns where you attach images, the model is quietly instructed to include a compact reusable image summary in its answer — so the *information* survives after the pixels are downgraded.
- Telemetry lands in your session entries, so savings are auditable per request.

## Bringing an archived image back

The adapter stores downgraded originals in `~/.image-cascade/store` (override with `ICC_STORE_DIR`) — the same store the CLI uses, so restore works out of the box:

```bash
npm install -g @image-cascade/cli
image-cascade restore <hash-from-placeholder> --out img.png
```

Pi can do this itself mid-conversation: when it sees a placeholder and needs the image again, it runs the restore command in its shell and reads the file back as current-turn content. `ICC_DISABLE=1` is the kill switch — the adapter passes every request through untouched.

## Uninstall

```bash
rm ~/.pi/agent/extensions/image-context-cascade.ts
```

That's it. Optionally `npm uninstall image-context-cascade` in `~/.pi/agent`. Archived originals stay in `~/.image-cascade/store` — yours to keep or delete.
