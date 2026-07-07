import { join } from "node:path";
import { homedir } from "node:os";
import {
  builtinMatchers,
  cascadeImagesAsync,
  fsSourceStore,
  imageIdentity,
  InMemoryTracker,
  trackerStrategy,
  type CascadeTelemetry,
} from "image-context-cascade";

// Structural typing on purpose: this file works as a Pi extension without
// importing @earendil-works/pi-coding-agent, so it can be dropped into
// ~/.pi/agent/extensions/ as-is.
type PiApi = {
  on(name: "before_agent_start", cb: (event: { images?: unknown[] }) => unknown): void;
  on(name: "before_provider_request", cb: (event: { payload: unknown }) => Promise<unknown> | unknown): void;
  on(name: "after_provider_response", cb: (event: { status?: number }) => unknown): void;
  appendEntry(name: string, value: unknown): void;
};

const STORE_DIR = process.env.ICC_STORE_DIR || join(homedir(), ".image-cascade", "store");

function summaryInstruction(count: number): string {
  return [
    "Image context cascade is active.",
    `This turn includes ${count} image attachment${count === 1 ? "" : "s"}.`,
    "After using each image, include a compact reusable image summary in your answer when it is relevant to the task.",
    "Future turns may omit the original image blocks and keep only stable text placeholders to preserve context budget and prompt-cache stability.",
    "Summarize factual visual details, OCR-worthy text, layout/regions, and any user-relevant conclusions; do not claim unseen details.",
  ].join("\n");
}

function identityFromBlock(block: unknown): ReturnType<typeof imageIdentity> | null {
  if (!block || typeof block !== "object") return null;

  // Pi prompt attachments before provider serialization: { type: "image", mimeType, data }.
  const maybePiImage = block as { type?: unknown; data?: unknown };
  if (maybePiImage.type === "image" && typeof maybePiImage.data === "string" && maybePiImage.data.length > 0) {
    return imageIdentity(maybePiImage.data);
  }

  for (const matcher of builtinMatchers) {
    const match = matcher.match(block);
    if (match) return match.identity;
  }
  return null;
}

export default function imageContextCascadePiAdapter(pi: PiApi): void {
  const tracker = new InMemoryTracker();
  let currentTurnHashes = new Set<string>();
  let pendingTelemetry: CascadeTelemetry | null = null;

  pi.on("before_agent_start", (event) => {
    currentTurnHashes = new Set<string>();
    for (const image of event.images ?? []) {
      const identity = identityFromBlock(image);
      if (!identity) continue;
      currentTurnHashes.add(identity.hash);
      tracker.remember(identity.hash, { seenInUserTurn: true });
    }

    if (currentTurnHashes.size === 0) return;
    return {
      message: {
        customType: "image-context-cascade",
        content: summaryInstruction(currentTurnHashes.size),
        display: false,
        details: {
          currentImageCount: currentTurnHashes.size,
          note: "Current images remain visible this turn; old tracked images are downgraded to stable text placeholders in later provider requests.",
        },
      },
    };
  });

  pi.on("before_provider_request", async (event) => {
    if (process.env.ICC_DISABLE === "1") return;
    try {
      const result = await cascadeImagesAsync(event.payload, {
        store: fsSourceStore(STORE_DIR),
        strategy: trackerStrategy({ currentTurnHashes, tracker }),
      });
      pendingTelemetry = result.telemetry;
      if (result.mutated) return result.payload;
    } catch {
      // Fail open: a broken cascade must never break the agent's request.
      pendingTelemetry = null;
    }
  });

  pi.on("after_provider_response", (event) => {
    if (!pendingTelemetry) return;
    pi.appendEntry("image-context-cascade.telemetry", { ...pendingTelemetry, status: event.status });
    pendingTelemetry = null;
  });
}
