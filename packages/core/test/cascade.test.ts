import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  builtinMatchers,
  cascadeImages,
  defaultPlaceholder,
  imageIdentity,
  createBuiltinMatchers,
  InMemoryTracker,
  positionalStrategy,
  sha256Hex,
  trackerStrategy,
} from "../src/index";

const b64 = (label: string, bytes = 32) => Buffer.from(`${label}:${"x".repeat(bytes)}`).toString("base64");
const uri = (data: string) => `data:image/png;base64,${data}`;
const anthropic = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const chatObj = (data: string) => ({ type: "image_url", image_url: { url: uri(data) } });
const chatStr = (data: string) => ({ type: "image_url", image_url: uri(data) });
const responses = (data: string) => ({ type: "input_image", image_url: uri(data) });
const payload = (older: unknown, current?: unknown) => ({ messages: [
  { role: "user", content: [{ type: "text", text: "old" }, older] },
  { role: "assistant", content: [{ type: "text", text: "ok" }] },
  { role: "user", content: [{ type: "text", text: "now" }, ...(current ? [current] : [])] },
] });

const [anthropicMatcher, openaiChatMatcher, openaiResponsesMatcher] = builtinMatchers;

describe("A. Block matcher tests", () => {
  test("anthropic_base64_block_matched", () => {
    const data = b64("anthropic");
    expect(anthropicMatcher!.match(anthropic(data))?.identity).toEqual(imageIdentity(data));
  });

  test("openai_chat_image_url_object_matched", () => {
    const data = b64("chat-object");
    expect(openaiChatMatcher!.match(chatObj(data))?.identity).toEqual(imageIdentity(data));
  });

  test("openai_chat_image_url_string_matched", () => {
    const data = b64("chat-string");
    expect(openaiChatMatcher!.match(chatStr(data))?.identity).toEqual(imageIdentity(data));
  });

  test("openai_responses_input_image_matched", () => {
    const data = b64("responses");
    expect(openaiResponsesMatcher!.match(responses(data))?.identity).toEqual(imageIdentity(data));
    expect(openaiResponsesMatcher!.match({ type: "input_image", image_url: "https://example.invalid/image.png" })?.identity).toEqual(imageIdentity("https://example.invalid/image.png"));
  });

  test("near_miss_blocks_not_matched", () => {
    for (const bad of [{ type: "image" }, { type: "image_url", image_url: 42 }, { type: "input_image", image_url: 42 }, { type: "image", source: { type: "url", data: b64("bad") } }]) {
      expect(builtinMatchers.some((m) => m.match(bad))).toBe(false);
    }
  });

  test("replace_produces_format_correct_text_block", () => {
    expect(openaiResponsesMatcher!.replace(responses("abc"), "TEXT")).toEqual({ type: "input_text", text: "TEXT" });
    expect(openaiChatMatcher!.replace(chatStr("abc"), "TEXT")).toEqual({ type: "text", text: "TEXT" });
    expect(anthropicMatcher!.replace(anthropic("abc"), "TEXT")).toEqual({ type: "text", text: "TEXT" });
  });
});

describe("B. Classification & cascade behavior", () => {
  test("current_turn_images_never_touched", () => {
    const data = b64("current");
    const p = { messages: [{ role: "user", content: [anthropic(data)] }] };
    const before = JSON.stringify(p);
    const result = cascadeImages(p, { strategy: trackerStrategy({ currentTurnHashes: new Set([imageIdentity(data).hash]), tracker: new InMemoryTracker() }) });
    expect(JSON.stringify(result.payload)).toBe(before);
    expect(result.telemetry.current).toBe(1);
  });

  test("historical_image_downgraded_to_placeholder", () => {
    const data = b64("known-old");
    const tracker = new InMemoryTracker();
    tracker.remember(imageIdentity(data).hash, { seenInUserTurn: true });
    const p = { messages: [{ role: "user", content: [anthropic(data)] }] };
    const result = cascadeImages(p, { strategy: trackerStrategy({ currentTurnHashes: new Set(), tracker }) });
    expect(result.mutated).toBe(true);
    expect((p.messages[0]!.content[0] as { type: string }).type).toBe("text");
  });

  test("unknown_intact_once_then_downgraded", () => {
    const data = b64("unknown");
    const tracker = new InMemoryTracker();
    const strategy = () => trackerStrategy({ currentTurnHashes: new Set(), tracker });
    const first = { messages: [{ role: "user", content: [anthropic(data)] }] };
    expect(cascadeImages(first, { strategy: strategy() }).telemetry.unknownIntact).toBe(1);
    expect((first.messages[0]!.content[0] as { type: string }).type).toBe("image");
    const second = { messages: [{ role: "user", content: [anthropic(data)] }] };
    expect(cascadeImages(second, { strategy: strategy() }).telemetry.downgraded).toBe(1);
  });

  test("positional_after_last_user_message_is_current", () => {
    const old = b64("old");
    const now = b64("now");
    const p = payload(anthropic(old), anthropic(now));
    const result = cascadeImages(p);
    expect(result.telemetry.downgraded).toBe(1);
    expect(result.telemetry.current).toBe(1);
    expect((p.messages[0]!.content[1] as { type: string }).type).toBe("text");
    expect((p.messages[2]!.content[1] as { type: string }).type).toBe("image");
  });

  test("positional_no_user_message_all_retained", () => {
    const p = { messages: [{ role: "assistant", content: [anthropic(b64("no-user"))] }] };
    const result = cascadeImages(p);
    expect(result.mutated).toBe(false);
    expect(result.telemetry.current).toBe(1);
  });

  test("nested_message_array_does_not_affect_positional_boundary", () => {
    const topCurrent = b64("top-current-a");
    const nestedImage = b64("nested-b");
    const nestedMessages = Array.from({ length: 20 }, (_, i) => ({
      role: i === 15 ? "user" : "assistant",
      content: i === 15 ? [{ type: "text", text: "nested current" }, anthropic(nestedImage)] : [{ type: "text", text: `nested ${i}` }],
    }));
    const p = { messages: [
      ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `top ${i}` }] })),
      { role: "assistant", content: [{ type: "text", text: "tool transcript" }, { transcript: nestedMessages }] },
      { role: "user", content: [{ type: "text", text: "now" }, anthropic(topCurrent)] },
    ] };

    const result = cascadeImages(p);

    expect(result.telemetry.current).toBeGreaterThanOrEqual(1);
    expect((p.messages[9]!.content[1] as { type: string }).type).toBe("image");
  });

  test("cascade_idempotent", () => {
    const p = payload(anthropic(b64("idem")), anthropic(b64("current-idem")));
    cascadeImages(p);
    const once = JSON.stringify(p);
    const result = cascadeImages(p);
    expect(result.mutated).toBe(false);
    expect(result.telemetry.downgraded).toBe(0);
    expect(JSON.stringify(p)).toBe(once);
  });

  test("payload_without_images_untouched", () => {
    const p = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
    const result = cascadeImages(p);
    expect(result.mutated).toBe(false);
    expect(result.payload).toBe(p);
  });
});

describe("C. Placeholder & cache stability", () => {
  test("placeholder_deterministic_across_calls", () => {
    const id = imageIdentity("same");
    expect(defaultPlaceholder(id)).toBe(defaultPlaceholder(id));
  });

  test("placeholder_snapshot_frozen", () => {
    const text = defaultPlaceholder({ hash: "abcdef1234567890", shortHash: "abcdef123456" });
    expect(text).toMatchSnapshot();
    expect(text).toBe("[Image abcdef123456 omitted from this provider request: it appeared in an earlier turn. Use the prior image summary in the conversation unless the user explicitly asks to inspect the original image again.]");
  });

  test("custom_placeholder_determinism_enforced", () => {
    const id = imageIdentity("deterministic");
    const custom = (x: typeof id) => `stable-${x.shortHash}`;
    expect(custom(id)).toBe(custom(id));
  });
});

describe("D. Telemetry & privacy", () => {
  test("telemetry_never_contains_base64", () => {
    const p = payload(anthropic(b64("private-png", 2048)), anthropic(b64("visible", 10)));
    const telemetry = cascadeImages(p).telemetry;
    const json = JSON.stringify(telemetry);
    expect(json).not.toContain("data:image");
    expect(/[A-Za-z0-9+/=]{64,}/.test(json)).toBe(false);
  });

  test("telemetry_size_bounded", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "old" }, ...Array.from({ length: 200 }, (_, i) => anthropic(b64(`img-${i}`)))] }, { role: "user", content: [{ type: "text", text: "now" }] }];
    const json = JSON.stringify(cascadeImages({ messages }).telemetry);
    expect(json.length).toBeLessThan(4096);
  });

  test("telemetry_counts_reconcile", () => {
    const t = cascadeImages(payload(anthropic(b64("reconcile-old")), anthropic(b64("reconcile-now")))).telemetry;
    expect(t.found).toBe(t.current + t.downgraded + t.unknownIntact);
    expect(t.estimatedSavedChars).toBeGreaterThanOrEqual(0);
    expect(t.estimatedSavedChars).toBe(t.estimatedOriginalChars - t.estimatedReplacementChars);
  });
});

describe("E. Benchmark & adapter conformance", () => {
  test("large_payload_reduction_benchmark", () => {
    const big = b64("synthetic-large-png", 1_300_000);
    const p = payload(responses(big), responses(b64("tiny-current")));
    const before = JSON.stringify(p).length;
    const result = cascadeImages(p);
    const after = JSON.stringify(result.payload).length;
    expect(result.telemetry.downgraded).toBe(1);
    expect(1 - after / before).toBeGreaterThan(0.999);
  });
});

describe("F. B1 hardening", () => {
  test("sha256_known_vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("a".repeat(65))).toBe("635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0");
    expect(sha256Hex("中文多字节输入")).toBe("834eb9f6547487bd4a3784088a52e2c5701b8dc4f5e879ab4d51c54e56cf6b1b");
  });

  test("web_entry_dependency_graph_has_no_node_crypto", () => {
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const forbidden = ["node:", "crypto"].join("");
    const visited = new Set<string>();
    const scan = (relativePath: string): void => {
      const fullPath = resolve(srcRoot, relativePath);
      if (visited.has(fullPath)) return;
      visited.add(fullPath);
      const source = readFileSync(fullPath, "utf8");
      expect(source).not.toContain(forbidden);
      const importRe = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.\.?\/[^"']+)["']/g;
      for (const match of source.matchAll(importRe)) {
        const spec = match[1]!;
        const child = resolve(dirname(fullPath), spec.endsWith(".ts") ? spec : `${spec}.ts`);
        if (child.startsWith(srcRoot)) scan(child.slice(srcRoot.length + 1).replace(/\\/g, "/"));
      }
    };
    scan("web.ts");
  });

  test("duplicate_block_reference_consistent", () => {
    const shared = anthropic(b64("duplicate-shared"));
    const p = { messages: [
      { role: "user", content: [shared, shared] },
      { role: "user", content: [{ type: "text", text: "now" }] },
    ] };
    const result = cascadeImages(p);
    expect(result.telemetry.downgraded).toBe(2);
    expect(p.messages[0]!.content[0]).toEqual(p.messages[0]!.content[1]);
    expect((p.messages[0]!.content[0] as { text: string }).text).toBe((p.messages[0]!.content[1] as { text: string }).text);
  });

  test("identity_cache_reuses_same_block_for_injected_hasher", () => {
    let calls = 0;
    const hasher = (data: string) => { calls++; return `hash-${data}`; };
    const formats = createBuiltinMatchers(hasher);
    const shared = anthropic(b64("cached-identity"));
    const p1 = { messages: [{ role: "user", content: [shared] }, { role: "user", content: [{ type: "text", text: "now" }] }] };
    const p2 = { messages: [{ role: "user", content: [shared] }, { role: "user", content: [{ type: "text", text: "now" }] }] };
    cascadeImages(p1, { formats });
    cascadeImages(p2, { formats });
    expect(calls).toBe(1);
    const otherFormats = createBuiltinMatchers(() => "other-hash");
    expect(otherFormats[0]!.match(shared)?.identity.hash).toBe("other-hash");
  });

  test("malformed_blocks_not_matched_or_thrown", () => {
    const badBlocks = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: 42 } },
      { type: "image", source: { type: "base64", media_type: "image/png" } },
      { type: "image_url", image_url: { url: "data:image/png;base64," } },
      { type: "input_image", image_url: "data:image/png;base64," },
      { type: "image_url", image_url: 42 },
      { type: "input_image", image_url: null },
    ];
    for (const bad of badBlocks) expect(builtinMatchers.some((m) => m.match(bad))).toBe(false);
  });

  test("circular_reference_payload_no_stack_overflow", () => {
    const old = anthropic(b64("circular-old"));
    const p: { messages: unknown[]; self?: unknown } = { messages: [
      { role: "user", content: [old] },
      { role: "user", content: [{ type: "text", text: "now" }] },
    ] };
    p.self = p;
    let result: ReturnType<typeof cascadeImages<typeof p>> | undefined;
    expect(() => { result = cascadeImages(p); }).not.toThrow();
    expect(result!.telemetry.traversalTruncated).toBeUndefined();
    expect(result!.telemetry.downgraded).toBe(1);
    expect((p.messages[0] as { content: unknown[] }).content[0]).toEqual(expect.objectContaining({ type: "text" }));
  });

  test("deep_nesting_beyond_limit_fails_open", () => {
    let root: { child?: unknown; messages?: unknown[] } = { messages: [
      { role: "user", content: [anthropic(b64("too-deep"))] },
      { role: "user", content: [{ type: "text", text: "now" }] },
    ] };
    for (let i = 0; i < 270; i++) root = { child: root };
    const before = root;
    const result = cascadeImages(root);
    expect(result.payload).toBe(before);
    expect(result.mutated).toBe(false);
    expect(result.telemetry.traversalTruncated).toBe(true);
    expect(JSON.stringify(result.telemetry.byFormat)).toBe("{}");
  });

  test("node_budget_exceeded_fails_open", () => {
    const content = [{ type: "text", text: "old" }, anthropic(b64("budget-old"))];
    const p = { messages: [{ role: "user", content }], many: Array.from({ length: 200_050 }, (_, i) => ({ i })) };
    const beforeBlock = p.messages[0]!.content[1];
    const result = cascadeImages(p);
    expect(result.mutated).toBe(false);
    expect(result.payload).toBe(p);
    expect(result.telemetry.traversalTruncated).toBe(true);
    expect(p.messages[0]!.content[1]).toBe(beforeBlock);
  });

  test("benchmark_10k_images_under_2s", () => {
    const content = [{ type: "text", text: "old" }, ...Array.from({ length: 10_000 }, (_, i) => anthropic(b64(`bench-${i}`, 4)))];
    const p = { messages: [{ role: "user", content }, { role: "user", content: [{ type: "text", text: "now" }] }] };
    const start = performance.now();
    const result = cascadeImages(p);
    const elapsed = performance.now() - start;
    console.log(`benchmark_10k_images_under_2s elapsed_ms=${elapsed.toFixed(2)}`);
    expect(elapsed).toBeLessThan(2000);
    expect(result.telemetry.downgraded).toBe(10_000);
    expect(result.mutated).toBe(true);
  });
});
