import type { ClassifyStrategy } from "../types";

export function positionalStrategy(): ClassifyStrategy {
  const strategy: ClassifyStrategy = (_identity, ctx) => {
    if (ctx.lastUserMessageIndex === undefined || ctx.messageIndex === undefined) return "current";
    return ctx.messageIndex >= ctx.lastUserMessageIndex ? "current" : "historical";
  };
  Object.defineProperty(strategy, "cascadeStrategyName", { value: "positional" });
  return strategy;
}
