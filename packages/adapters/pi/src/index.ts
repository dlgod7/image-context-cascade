import {
  builtinMatchers,
  cascadeImages,
  InMemoryTracker,
  trackerStrategy,
  type CascadeTelemetry,
} from "image-context-cascade";

type PiApi = {
  on(name: "before_agent_start", cb: (event: { images?: unknown[] }) => unknown): void;
  on(name: "before_provider_request", cb: (event: { payload: unknown }) => unknown): void;
  on(name: "after_provider_response", cb: (event: { status?: number }) => unknown): void;
  appendEntry(name: string, value: unknown): void;
};

function summaryInstruction(count: number): string {
  return [
    "Image context cascade is active.",
    `This turn includes ${count} image attachment${count === 1 ? "" : "s"}.`,
    "After using each image, include a compact reusable image summary in your answer when it is relevant to the task.",
    "Future turns may omit the original image blocks and keep only stable text placeholders to preserve context budget and prompt-cache stability.",
    "Summarize factual visual details, OCR-worthy text, layout/regions, and any user-relevant conclusions; do not claim unseen details.",
  ].join("\n");
}

export default function imageContextCascadePiAdapter(pi: PiApi): void {
  const tracker = new InMemoryTracker();
  let currentTurnHashes = new Set<string>();
  let pendingTelemetry: CascadeTelemetry | null = null;

  pi.on("before_agent_start", (event) => {
    currentTurnHashes = new Set<string>();
    for (const image of event.images ?? []) {
      for (const matcher of builtinMatchers) {
        const match = matcher.match(image);
        if (!match) continue;
        currentTurnHashes.add(match.identity.hash);
        tracker.remember(match.identity.hash, { seenInUserTurn: true });
        break;
      }
    }
    if (currentTurnHashes.size === 0) return;
    return { message: { customType: "image-context-cascade", content: summaryInstruction(currentTurnHashes.size), display: false } };
  });

  pi.on("before_provider_request", (event) => {
    const result = cascadeImages(event.payload, { strategy: trackerStrategy({ currentTurnHashes, tracker }) });
    pendingTelemetry = result.telemetry;
    if (result.mutated) return result.payload;
  });

  pi.on("after_provider_response", (event) => {
    if (!pendingTelemetry) return;
    pi.appendEntry("image-context-cascade.telemetry", { ...pendingTelemetry, status: event.status });
    pendingTelemetry = null;
  });
}
