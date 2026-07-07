import { expect, test } from "bun:test";
import { referenceCoreHarness, runConformance, runCorpusConformance } from "./suite";

test("adapter_conformance_suite", async () => {
  const result = await runConformance(referenceCoreHarness());
  expect(result.passed).toBe(true);
});

test("corpus_conformance_suite", async () => {
  const result = await runCorpusConformance();
  expect(result.cases).toBeGreaterThanOrEqual(6);
  expect(result.passed).toBe(true);
});
