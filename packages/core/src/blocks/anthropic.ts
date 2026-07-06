import { createBuiltinMatchers } from "./create";

export function createAnthropicMatcher(hasher: (data: string) => string) {
  return createBuiltinMatchers(hasher)[0]!;
}
