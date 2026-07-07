import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cascadeImages, cascadeImagesAsync, defaultPlaceholder, imageIdentity, InMemoryTracker, trackerStrategy, type CascadeTelemetry, type SourceStore, type StoredImage } from "image-context-cascade";

export interface AdapterHarness {
  name: string;
  runTwoTurnImageRequest(payloads: { first: unknown; second: unknown }): Promise<{
    firstPayload: unknown;
    secondPayload: unknown;
    telemetry: unknown[];
  }> | {
    firstPayload: unknown;
    secondPayload: unknown;
    telemetry: unknown[];
  };
}

export interface ConformanceResult {
  adapterName: string;
  passed: boolean;
  checks: string[];
}

export interface CorpusRunResult {
  passed: boolean;
  checks: string[];
  cases: number;
}

type CorpusCase = {
  name: string;
  description: string;
  payload: unknown;
  options?: { strategy?: "positional" | "tracker"; currentHashesOf?: string[]; async?: boolean; store?: boolean; dedupe?: boolean };
  expect: { mutated: boolean; current: number; downgraded: number; unknownIntact: number; downgradedPlaceholderStable: boolean };
};

function getPath(root: unknown, path: string): unknown {
  return path.split(".").reduce((value: unknown, part) => {
    if (value == null) return undefined;
    if (Array.isArray(value)) return value[Number(part)];
    if (typeof value === "object") return (value as Record<string, unknown>)[part];
    return undefined;
  }, root);
}

function imageDataFromBlock(block: unknown): string {
  if (!block || typeof block !== "object") throw new Error("block path did not resolve to an object");
  const b = block as { type?: unknown; source?: { data?: unknown }; image_url?: unknown };
  if ((b.type === "image" || b.type === "document") && typeof b.source?.data === "string") return b.source.data;
  const raw = typeof b.image_url === "string" ? b.image_url : (b.image_url && typeof b.image_url === "object" ? (b.image_url as { url?: unknown }).url : undefined);
  if (typeof raw === "string") return raw.startsWith("data:") ? raw.split(",", 2)[1] ?? raw : raw;
  throw new Error("unsupported block in currentHashesOf");
}

function corpusDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
}

export function loadCorpusCases(): CorpusCase[] {
  return readdirSync(corpusDir())
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(corpusDir(), name), "utf8")) as CorpusCase);
}

function memoryStore(): SourceStore {
  const map = new Map<string, StoredImage>();
  return {
    async put(hash, image) { map.set(hash, image); },
    async get(hash) { return map.get(hash) ?? null; },
    async has(hash) { return map.has(hash); },
  };
}

export async function runCorpusConformance(): Promise<CorpusRunResult> {
  const checks: string[] = [];
  for (const c of loadCorpusCases()) {
    const options = c.options?.strategy === "tracker"
      ? { strategy: trackerStrategy({ tracker: new InMemoryTracker(), currentTurnHashes: new Set((c.options.currentHashesOf ?? []).map((path) => imageIdentity(imageDataFromBlock(getPath(c.payload, path))).hash)) }) }
      : {};
    const result = c.options?.async
      ? await cascadeImagesAsync(c.payload, { ...options, ...(c.options.store ? { store: memoryStore() } : {}), ...(c.options.dedupe === false ? { dedupe: false } : {}) })
      : cascadeImages(c.payload, options);
    const t = result.telemetry as CascadeTelemetry;
    const ok = result.mutated === c.expect.mutated && t.current === c.expect.current && t.downgraded === c.expect.downgraded && t.unknownIntact === c.expect.unknownIntact;
    checks.push(ok ? `${c.name}: ok` : `${c.name}: failed`);
    if (c.expect.downgradedPlaceholderStable && t.shortHashes.length > 0 && t.downgraded > 0) {
      const json = JSON.stringify(result.payload);
      const containsKnownPlaceholder = t.shortHashes.some((shortHash) => json.includes(defaultPlaceholder({ hash: shortHash, shortHash })));
      checks.push(containsKnownPlaceholder ? `${c.name}: stable placeholder` : `${c.name}: missing stable placeholder`);
    }
  }
  return { passed: checks.every((c) => c.endsWith(": ok") || c.endsWith(": stable placeholder")), checks, cases: loadCorpusCases().length };
}

export async function runConformance(adapterHarness: AdapterHarness): Promise<ConformanceResult> {
  const data = Buffer.from("synthetic-conformance-image").toString("base64");
  const first = { messages: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${data}` }] }] };
  const second = { messages: [
    { role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${data}` }] },
    { role: "assistant", content: [{ type: "text", text: "seen" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ] };
  const result = await adapterHarness.runTwoTurnImageRequest({ first, second });
  const jsonTelemetry = JSON.stringify(result.telemetry);
  const checks = [
    JSON.stringify(result.firstPayload).includes("input_image") ? "current retained" : "missing current retained",
    JSON.stringify(result.secondPayload).includes(defaultPlaceholder(imageIdentity(data))) ? "historical downgraded" : "missing historical downgrade",
    !jsonTelemetry.includes("data:image") ? "telemetry privacy" : "telemetry leaked data uri",
  ];
  return { adapterName: adapterHarness.name, passed: checks.every((c) => !c.startsWith("missing") && !c.includes("leaked")), checks };
}

export function referenceCoreHarness(): AdapterHarness {
  return {
    name: "core-reference",
    runTwoTurnImageRequest({ first, second }) {
      const r1 = cascadeImages(first);
      const r2 = cascadeImages(second);
      return { firstPayload: r1.payload, secondPayload: r2.payload, telemetry: [r1.telemetry, r2.telemetry] };
    },
  };
}
