import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "main.js");
const b64 = (label: string) => Buffer.from(`${label}:image`).toString("base64");
const anthropic = (label: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b64(label) } });
const text = (value: string) => ({ type: "text", text: value });

async function tempDir() {
  return mkdtemp(join(tmpdir(), "icc-cli-"));
}

async function runRescue(file: string, args: string[] = []) {
  const proc = Bun.spawn(["bun", cli, "rescue", file, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code, json: stdout.trim() ? JSON.parse(stdout) : undefined };
}

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
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
