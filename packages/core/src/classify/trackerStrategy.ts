import type { ClassifyStrategy, ImageTracker } from "../types";

export function trackerStrategy(opts: {
  currentTurnHashes: ReadonlySet<string>;
  tracker: ImageTracker;
}): ClassifyStrategy {
  const strategy: ClassifyStrategy = (identity) => {
    if (opts.currentTurnHashes.has(identity.hash)) return "current";
    return opts.tracker.has(identity.hash) ? "historical" : "unknown";
  };
  Object.defineProperty(strategy, "cascadeStrategyName", { value: "tracker" });
  Object.defineProperty(strategy, "cascadeTracker", { value: opts.tracker });
  return strategy;
}
