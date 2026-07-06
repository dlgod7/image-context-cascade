import { createBuiltinMatchers } from "./create";

export function createOpenaiChatMatcher(hasher: (data: string) => string) {
  return createBuiltinMatchers(hasher)[1]!;
}
