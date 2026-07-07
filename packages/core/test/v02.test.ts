import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildImageBlock,
  cascadeImages,
  cascadeImagesAsync,
  defaultPlaceholder,
  fsSourceStore,
  imageIdentity,
  restoreImage,
  restorablePlaceholder,
  type SourceStore,
  type StoredImage,
} from "../src/index";

const b64 = (label: string, bytes = 16) => Buffer.from(`${label}:${"x".repeat(bytes)}`).toString("base64");
const anthropic = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const payload = (...blocks: unknown[]) => ({ messages: [
  { role: "user", content: [{ type: "text", text: "old" }, ...blocks] },
  { role: "assistant", content: [{ type: "text", text: "ok" }] },
  { role: "user", content: [{ type: "text", text: "now" }] },
] });
const tmp = () => mkdtemp(join(tmpdir(), "icc-v02-"));

describe("G. v0.2 source store, tiers, and restore", () => {
  test("source_store_roundtrip_and_lru_cleanup", async () => {
    const dir = await tmp();
    const store = fsSourceStore(dir);
    const one: StoredImage = { data: b64("one"), mediaType: "image/png" };
    const two: StoredImage = { data: b64("two"), mediaType: "image/png" };
    const id1 = imageIdentity(one.data);
    const id2 = imageIdentity(two.data);
    await store.put(id1.hash, one);
    expect(await store.has(id1.hash)).toBe(true);
    expect(await store.get(id1.hash)).toEqual(one);
    const lruStore = fsSourceStore(join(dir, "lru"), { maxBytes: 1 });
    await lruStore.put(id2.hash, two);
    expect(await lruStore.has(id2.hash)).toBe(false);
  });

  test("fake_thumbnailer_contract_and_determinism", async () => {
    const data = b64("thumb");
    const p1 = payload(anthropic(data));
    const p2 = payload(anthropic(data));
    const thumbnailer = async (img: StoredImage) => ({ data: `thumb-${img.data.slice(0, 8)}`, mediaType: img.mediaType });
    const opts = { thumbnailer, tiers: () => "thumbnail" as const };
    const r1 = await cascadeImagesAsync(p1, opts);
    const r2 = await cascadeImagesAsync(p2, opts);
    expect(r1.telemetry.thumbnailed).toBe(1);
    expect(JSON.stringify(r1.payload)).toBe(JSON.stringify(r2.payload));
    expect((p1.messages[0]!.content[1] as { source: { data: string } }).source.data).toBe(`thumb-${data.slice(0, 8)}`);
  });

  test("inv15_async_without_new_options_matches_sync_output", async () => {
    const pSync = payload(anthropic(b64("compat-old")));
    const pAsync = JSON.parse(JSON.stringify(pSync));
    const sync = cascadeImages(pSync);
    const asyncResult = await cascadeImagesAsync(pAsync);
    expect(JSON.stringify(asyncResult.payload)).toBe(JSON.stringify(sync.payload));
    expect(asyncResult.telemetry.downgraded).toBe(sync.telemetry.downgraded);
    expect(defaultPlaceholder({ hash: "abcdef1234567890", shortHash: "abcdef123456" })).toMatchSnapshot();
  });

  test("store_enabled_placeholder_snapshot_frozen", () => {
    expect(restorablePlaceholder({ hash: "abcdef1234567890", shortHash: "abcdef123456" })).toMatchSnapshot();
  });

  test("store_io_failure_fail_open_with_store_errors", async () => {
    const throwingStore: SourceStore = {
      async put() { throw new Error("put failed"); },
      async get() { throw new Error("get failed"); },
      async has() { throw new Error("has failed"); },
    };
    const p = payload(anthropic(b64("store-fail")));
    const result = await cascadeImagesAsync(p, { store: throwingStore });
    expect(result.mutated).toBe(true);
    expect(result.telemetry.storeErrors).toBe(1);
    expect(result.telemetry.downgraded).toBe(1);
  });

  test("dedupe_all_historical_same_hash_all_downgraded", async () => {
    const data = b64("same-three");
    const p = { messages: [
      { role: "user", content: [anthropic(data)] },
      { role: "assistant", content: [{ type: "text", text: "middle" }] },
      { role: "user", content: [{ type: "text", text: "another user" }] },
      { role: "assistant", content: [anthropic(data)] },
      { role: "assistant", content: [anthropic(data)] },
      { role: "user", content: [{ type: "text", text: "now" }] },
    ] };
    const result = await cascadeImagesAsync(p, { tiers: () => "placeholder" });
    // No current-turn copy exists, so no duplicate may survive as an original.
    expect(result.telemetry.downgraded).toBe(3);
    expect(result.telemetry.dedupedRefs ?? 0).toBe(0);
    expect(JSON.stringify(p)).not.toContain(data);
  });

  test("dedupe_historical_ref_when_current_copy_exists", async () => {
    const data = b64("same-current");
    const p = { messages: [
      { role: "user", content: [anthropic(data)] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "look again" }, anthropic(data)] },
    ] };
    const result = await cascadeImagesAsync(p, { tiers: () => "placeholder" });
    expect(result.telemetry.current).toBe(1);
    expect(result.telemetry.dedupedRefs).toBe(1);
    const historical = p.messages[0]!.content[0] as { type: string; text?: string };
    expect(historical.type).toBe("text");
    expect(historical.text).toContain("duplicate omitted");
    expect((p.messages[2]!.content[1] as { type: string }).type).toBe("image");
    const single = payload(anthropic(data));
    const singleResult = await cascadeImagesAsync(single, { tiers: () => "placeholder" });
    expect(singleResult.telemetry.dedupedRefs ?? 0).toBe(0);
  });

  test("url_referenced_images_never_enter_store", async () => {
    const stored = new Map<string, StoredImage>();
    const store: SourceStore = {
      async put(hash, image) { stored.set(hash, image); },
      async get(hash) { return stored.get(hash) ?? null; },
      async has(hash) { return stored.has(hash); },
    };
    const p = { messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] },
      { role: "user", content: [{ type: "text", text: "now" }] },
    ] };
    const result = await cascadeImagesAsync(p, { store });
    expect(result.telemetry.downgraded).toBe(1);
    expect(result.telemetry.stored ?? 0).toBe(0);
    expect(stored.size).toBe(0);
  });

  test("restore_build_image_block_three_formats", async () => {
    const img: StoredImage = { data: b64("restore"), mediaType: "image/png" };
    expect(buildImageBlock("anthropic", img)).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: img.data } });
    expect(buildImageBlock("openai-chat", img)).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${img.data}` } });
    expect(buildImageBlock("openai-responses", img)).toEqual({ type: "input_image", image_url: `data:image/png;base64,${img.data}` });
    const dir = await tmp();
    const store = fsSourceStore(dir);
    const id = imageIdentity(img.data);
    await store.put(id.hash, img);
    expect(await restoreImage(store, id.hash)).toEqual(img);
    expect(await store.resolve!(id.shortHash)).toBe(id.hash);
    expect(await store.resolve!("no-such/../prefix")).toBeNull();
    expect(await store.resolve!("ffffffffffff")).toBeNull();
    const storedFile = join(dir, id.hash.slice(0, 2), `${id.hash}.json`);
    expect((await stat(storedFile)).size).toBeGreaterThan(0);
    expect(await readFile(storedFile, "utf8")).not.toContain("file://");
  });
});
