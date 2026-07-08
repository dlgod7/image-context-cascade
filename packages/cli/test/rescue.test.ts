import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { imageIdentity } from "image-context-cascade";

const cli = join(import.meta.dir, "..", "src", "main.js");
const b64 = (label: string) => Buffer.from(`${label}:image`).toString("base64");
const anthropic = (label: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b64(label) } });
const text = (value: string) => ({ type: "text", text: value });

async function tempDir() {
  return mkdtemp(join(tmpdir(), "icc-cli-"));
}

async function runCli(args: string[] = [], opts: { stdin?: string; env?: Record<string, string>; cwd?: string } = {}) {
  const proc = Bun.spawn(["bun", cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : undefined,
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const trimmed = stdout.trim();
  return { stdout, stderr, code, json: trimmed.startsWith("{") ? JSON.parse(trimmed) : undefined };
}

async function runRescue(file: string, args: string[] = []) {
  const proc = Bun.spawn(["bun", cli, "rescue", file, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const trimmed = stdout.trim();
  return { stdout, stderr, code, json: trimmed.startsWith("{") ? JSON.parse(trimmed) : undefined };
}

function line(obj: unknown) {
  return JSON.stringify(obj);
}

describe("rescue CLI", () => {
  test("version_flag_prints_package_version", async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8"));
    for (const flag of ["--version", "-v"]) {
      const result = await runCli([flag]);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(pkg.version);
    }
  });

  test("unknown_option_fails_with_usage_not_stack_trace", async () => {
    const result = await runCli(["rescue", "whatever.jsonl", "--bogus"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--bogus");
    expect(result.stderr).toContain("image-cascade rescue <file>");
    expect(result.stderr).not.toContain("throw");
  });

  test("rescue_jsonl_two_pass_boundary_correct", async () => {
    const dir = await tempDir();
    const file = join(dir, "session.jsonl");
    await writeFile(file, [
      line({ role: "user", content: [text("old"), anthropic("old")] }),
      line({ role: "assistant", content: [text("middle")] }),
      line({ role: "user", content: [text("current"), anthropic("current")] }),
      line({ role: "assistant", content: [text("after")] }),
    ].join("\n") + "\n");

    const result = await runRescue(file, ["--yes", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.downgraded).toBe(1);
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n").map((x) => JSON.parse(x));
    expect(lines[0].content[1].type).toBe("text");
    expect(lines[2].content[1].type).toBe("image");
  });

  test("rescue_dry_run_writes_nothing", async () => {
    const dir = await tempDir();
    const file = join(dir, "dry.jsonl");
    const content = line({ role: "user", content: [anthropic("old")] }) + "\n" + line({ role: "user", content: [text("now")] }) + "\n";
    await writeFile(file, content);
    const before = await readFile(file);
    const result = await runRescue(file, ["--json"]);
    expect(result.code).toBe(0);
    expect(result.json.dryRun).toBe(true);
    expect(await readFile(file)).toEqual(before);
    expect(existsSync(`${file}.icc-backup`)).toBe(false);
  });

  test("rescue_creates_backup_and_atomic_write", async () => {
    const dir = await tempDir();
    const file = join(dir, "write.jsonl");
    const content = line({ role: "user", content: [anthropic("old")] }) + "\n" + line({ role: "user", content: [text("now")] }) + "\n";
    await writeFile(file, content);
    const result = await runRescue(file, ["--yes", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.backup).toBe(`${file}.icc-backup`);
    expect(await readFile(`${file}.icc-backup`, "utf8")).toBe(content);
    expect((await readFile(file, "utf8"))).toContain("omitted from this provider request");
  });

  test("rescue_idempotent_second_run_zero_downgrades", async () => {
    const dir = await tempDir();
    const file = join(dir, "idem.jsonl");
    await writeFile(file, line({ role: "user", content: [anthropic("old")] }) + "\n" + line({ role: "user", content: [text("now")] }) + "\n");
    const first = await runRescue(file, ["--yes", "--json"]);
    expect(first.json.downgraded).toBe(1);
    const bytes = (await stat(file)).size;
    const second = await runRescue(file, ["--yes", "--json"]);
    expect(second.code).toBe(0);
    expect(second.json.downgraded).toBe(0);
    expect((await stat(file)).size).toBe(bytes);
  });

  test("rescue_malformed_lines_passthrough", async () => {
    const dir = await tempDir();
    const file = join(dir, "bad.jsonl");
    const bad = "{not valid json";
    await writeFile(file, [bad, line({ role: "user", content: [anthropic("old")] }), line({ role: "user", content: [text("now")] })].join("\n") + "\n");
    const result = await runRescue(file, ["--yes", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.skippedLines).toBe(1);
    expect((await readFile(file, "utf8")).split("\n")[0]).toBe(bad);
  });

  test("rescue_large_file_streaming", async () => {
    const dir = await tempDir();
    const file = join(dir, "large.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 19_999; i++) {
      lines.push(i < 5_000 ? line({ role: "assistant", content: [anthropic(`large-${i}`)] }) : line({ role: "assistant", content: [text(`line-${i}`)] }));
    }
    lines.push(line({ role: "user", content: [text("last user boundary")] }));
    await writeFile(file, lines.join("\n") + "\n");
    const start = performance.now();
    const result = await runRescue(file, ["--yes", "--json"]);
    const elapsed = performance.now() - start;
    console.log(`rescue_large_file_streaming elapsed_ms=${elapsed.toFixed(2)}`);
    expect(result.code).toBe(0);
    expect(result.json.lines).toBe(20_000);
    expect(result.json.downgraded).toBe(5_000);
    expect(result.json.skippedLines).toBe(0);
  });

  test("rescue_jsonl_no_user_boundary_noop_without_all", async () => {
    const dir = await tempDir();
    const file = join(dir, "no-user.jsonl");
    const content = [
      line({ role: "assistant", content: [anthropic("tool-log-1")] }),
      line({ type: "tool", payload: { content: [anthropic("tool-log-2")] } }),
      line({ role: "assistant", content: [text("done")] }),
    ].join("\n") + "\n";
    await writeFile(file, content);
    const beforeBytes = (await stat(file)).size;

    const noop = await runRescue(file, ["--yes", "--json"]);
    expect(noop.code).toBe(0);
    expect(noop.json.boundaryLine).toBeNull();
    expect(noop.json.downgraded).toBe(0);
    expect((await stat(file)).size).toBe(beforeBytes);
    expect(await readFile(file, "utf8")).toBe(content);
    expect(existsSync(`${file}.icc-backup`)).toBe(false);

    const all = await runRescue(file, ["--all", "--yes", "--json"]);
    expect(all.code).toBe(0);
    expect(all.json.downgraded).toBe(2);
    expect(existsSync(`${file}.icc-backup`)).toBe(true);
    expect(await readFile(`${file}.icc-backup`, "utf8")).toBe(content);
    expect(await readFile(file, "utf8")).toContain("omitted from this provider request");
  });

  test("rescue_store_and_restore_e2e", async () => {
    const dir = await tempDir();
    const store = join(dir, "store");
    const file = join(dir, "store.jsonl");
    const data = b64("restore-cli");
    const original = Buffer.from(data, "base64");
    await writeFile(file, line({ role: "user", content: [anthropic("restore-cli")] }) + "\n" + line({ role: "user", content: [text("now")] }) + "\n");
    const rescue = await runRescue(file, ["--all", "--yes", "--store", store, "--json"]);
    expect(rescue.code).toBe(0);
    expect(rescue.json.stored).toBeGreaterThanOrEqual(1);
    expect(await readFile(file, "utf8")).toContain("restorable via image-cascade restore");
    const hash = imageIdentity(data).hash;
    const out = join(dir, "restored.png");
    const restored = await runCli(["restore", hash, "--store", store, "--out", out, "--json"]);
    expect(restored.code).toBe(0);
    expect(await readFile(out)).toEqual(original);
  });

  test("restore_accepts_short_hash_from_placeholder", async () => {
    const dir = await tempDir();
    const store = join(dir, "store");
    const file = join(dir, "short.jsonl");
    const data = b64("short-hash");
    await writeFile(file, line({ role: "user", content: [anthropic("short-hash")] }) + "\n" + line({ role: "user", content: [text("now")] }) + "\n");
    await runRescue(file, ["--all", "--yes", "--store", store]);
    const rewritten = await readFile(file, "utf8");
    const short = /restorable via image-cascade restore ([0-9a-f]{12})/.exec(rewritten)?.[1];
    expect(short).toBe(imageIdentity(data).shortHash);
    const out = join(dir, "restored-short.png");
    const restored = await runCli(["restore", short!, "--store", store, "--out", out, "--json"]);
    expect(restored.code).toBe(0);
    expect(restored.json.hash).toBe(imageIdentity(data).hash);
    expect(await readFile(out)).toEqual(Buffer.from(data, "base64"));
  });

  test("format_agnostic_svg_and_unknown_media_types_roundtrip", async () => {
    const dir = await tempDir();
    const store = join(dir, "store");
    const file = join(dir, "formats.jsonl");
    const svgBytes = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`);
    const svgBlock = { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: svgBytes.toString("base64") } };
    const weirdBlock = { type: "image", source: { type: "base64", media_type: "image/x-portable-anymap", data: Buffer.from("P7 weird format payload").toString("base64") } };
    await writeFile(file, [
      line({ role: "user", content: [svgBlock, weirdBlock] }),
      line({ role: "user", content: [text("now")] }),
    ].join("\n") + "\n");

    const rescueResult = await runRescue(file, ["--yes", "--store", store, "--json"]);
    expect(rescueResult.code).toBe(0);
    expect(rescueResult.json.downgraded).toBe(2);

    const svgHash = imageIdentity(svgBlock.source.data).shortHash;
    const restored = await runCli(["restore", svgHash, "--store", store, "--json"], { cwd: dir });
    expect(restored.code).toBe(0);
    expect(restored.json.out.endsWith(".svg")).toBe(true);
    expect(await readFile(restored.json.out)).toEqual(svgBytes);
    await unlink(restored.json.out).catch(() => {});

    const weirdHash = imageIdentity(weirdBlock.source.data).shortHash;
    const weirdOut = join(dir, "weird-out");
    const weirdRestored = await runCli(["restore", weirdHash, "--store", store, "--out", weirdOut, "--json"]);
    expect(weirdRestored.code).toBe(0);
    expect(weirdRestored.json.mediaType).toBe("image/x-portable-anymap");
    expect(await readFile(weirdOut)).toEqual(Buffer.from("P7 weird format payload"));
  });

  test("restore_rejects_non_hex_hash_input", async () => {
    const result = await runCli(["restore", "../../etc/passwd", "--store", "whatever"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid hash");
  });

  test("rescue_claude_code_session_shape", async () => {
    const dir = await tempDir();
    const file = join(dir, "claude.jsonl");
    await writeFile(file, [
      line({ type: "assistant", message: { role: "assistant", content: [anthropic("old")] } }),
      line({ type: "user", message: { role: "user", content: [text("now"), anthropic("current")] } }),
    ].join("\n") + "\n");
    const result = await runRescue(file, ["--yes", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json.boundaryLine).toBe(2);
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n").map((x) => JSON.parse(x));
    expect(lines[0].message.content[0].type).toBe("text");
    expect(lines[1].message.content[1].type).toBe("image");
  });
});

describe("hook claude-code", () => {
  const sessionContent = () => [
    line({ type: "user", message: { role: "user", content: [text("earlier"), anthropic("hook-old")] } }),
    line({ type: "assistant", message: { role: "assistant", content: [text("done")] } }),
    line({ type: "user", message: { role: "user", content: [text("latest turn")] } }),
  ].join("\n") + "\n";

  test("hook_rescues_transcript_from_stdin_payload", async () => {
    const dir = await tempDir();
    const file = join(dir, "transcript.jsonl");
    const store = join(dir, "store");
    await writeFile(file, sessionContent());
    const payload = JSON.stringify({ session_id: "abc", transcript_path: file, hook_event_name: "SessionEnd", reason: "other" });
    const result = await runCli(["hook", "claude-code", "--store", store, "--json"], { stdin: payload });
    expect(result.code).toBe(0);
    expect(result.json.downgraded).toBe(1);
    expect(result.json.stored).toBeGreaterThanOrEqual(1);
    const rewritten = await readFile(file, "utf8");
    expect(rewritten).toContain("restorable via image-cascade restore");
    expect(rewritten).toContain("latest turn");
    expect(existsSync(`${file}.icc-backup`)).toBe(true);
  });

  test("hook_stores_by_default_using_icc_store_dir", async () => {
    const dir = await tempDir();
    const file = join(dir, "default-store.jsonl");
    const store = join(dir, "env-store");
    await writeFile(file, sessionContent());
    const payload = JSON.stringify({ transcript_path: file, hook_event_name: "SessionEnd" });
    const result = await runCli(["hook", "claude-code", "--json"], { stdin: payload, env: { ICC_STORE_DIR: store } });
    expect(result.code).toBe(0);
    expect(result.json.stored).toBeGreaterThanOrEqual(1);
    const short = /restorable via image-cascade restore ([0-9a-f]{12})/.exec(await readFile(file, "utf8"))?.[1];
    const out = join(dir, "hook-restored.png");
    const restored = await runCli(["restore", short!, "--store", store, "--out", out, "--json"]);
    expect(restored.code).toBe(0);
    expect(await readFile(out)).toEqual(Buffer.from(b64("hook-old"), "base64"));
  });

  test("hook_missing_transcript_is_silent_noop", async () => {
    const dir = await tempDir();
    const payload = JSON.stringify({ transcript_path: join(dir, "does-not-exist.jsonl"), hook_event_name: "SessionEnd" });
    const result = await runCli(["hook", "claude-code"], { stdin: payload });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("skipping");
  });

  test("hook_invalid_stdin_json_is_silent_noop", async () => {
    const result = await runCli(["hook", "claude-code"], { stdin: "not json at all" });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("skipping");
  });

  test("hook_empty_stdin_is_silent_noop", async () => {
    const result = await runCli(["hook", "claude-code"], { stdin: "" });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("skipping");
  });

  test("hook_respects_icc_disable", async () => {
    const dir = await tempDir();
    const file = join(dir, "disabled.jsonl");
    const content = sessionContent();
    await writeFile(file, content);
    const payload = JSON.stringify({ transcript_path: file, hook_event_name: "SessionEnd" });
    const result = await runCli(["hook", "claude-code", "--store", join(dir, "store")], { stdin: payload, env: { ICC_DISABLE: "1" } });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("ICC_DISABLE");
    expect(await readFile(file, "utf8")).toBe(content);
    expect(existsSync(`${file}.icc-backup`)).toBe(false);
  });

  test("hook_unknown_host_is_config_error_exit_one", async () => {
    const result = await runCli(["hook", "some-other-agent"], { stdin: "{}" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown hook host");
  });

  test("hook_idempotent_second_run_archives_nothing", async () => {
    const dir = await tempDir();
    const file = join(dir, "idem-hook.jsonl");
    const store = join(dir, "store");
    await writeFile(file, sessionContent());
    const payload = JSON.stringify({ transcript_path: file, hook_event_name: "SessionEnd" });
    const first = await runCli(["hook", "claude-code", "--store", store, "--json"], { stdin: payload });
    expect(first.json.downgraded).toBe(1);
    const bytes = (await stat(file)).size;
    const second = await runCli(["hook", "claude-code", "--store", store, "--json"], { stdin: payload });
    expect(second.code).toBe(0);
    expect(second.json.downgraded).toBe(0);
    expect((await stat(file)).size).toBe(bytes);
    expect(existsSync(`${file}.icc-backup.1`)).toBe(false);
  });

  test("runs_when_invoked_through_npm_style_bin_symlink", async () => {
    // `npm install -g` creates the `image-cascade` bin as a symlink to this
    // file. import.meta.url resolves through the symlink to the real path
    // while process.argv[1] keeps the invocation path, so the entrypoint
    // self-check must resolve argv[1] before comparing.
    const dir = await tempDir();
    const binPath = join(dir, "image-cascade");
    await symlink(cli, binPath);
    const proc = Bun.spawn(["bun", binPath, "--help"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain("image-cascade rescue <file>");
  });
});
