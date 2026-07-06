import { createBuiltinMatchers } from "./create";

export function createOpenaiResponsesMatcher(hasher: (data: string) => string) {
  return createBuiltinMatchers(hasher)[2]!;
}
