#!/usr/bin/env bun
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { cascadeImages } from "image-context-cascade";

const historicalStrategy = Object.assign(() => "historical", { cascadeStrategyName: "custom" });

function usage() {
  return `image-cascade rescue <file> [--yes] [--all] [--json]\n\nRescue oversized image session files by downgrading historical image blocks.\n\nCommands:\n  rescue <file>   Analyze or rewrite a .jsonl session or a single JSON document.\n\nOptions:\n  --yes           Write changes. Default is dry-run and writes nothing.\n  --all           Downgrade all image blocks, including when no user-message boundary is found.\n  --json          Print machine-readable JSON statistics.\n  --version, -v   Print the CLI version.\n  --help, -h      Show this help.\n\nNotes:\n  JSONL mode uses two streaming passes and O(1) memory. Single JSON mode reads the whole file into memory.\n`;
}

async function cliVersion() {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  return pkg.version;
}

function hasUserRole(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasUserRole);
  if (value.role === "user") return true;
  return Object.values(value).some(hasUserRole);
}

function emptyStats(file, mode, dryRun) {
  return {
    file,
    mode,
    dryRun,
    lines: 0,
    boundaryLine: null,
    found: 0,
    downgraded: 0,
    estimatedSavedChars: 0,
    skippedLines: 0,
    bytesBefore: 0,
    estimatedBytesAfter: 0,
    bytesAfter: null,
    backup: null,
    changed: false,
  };
}

function addTelemetry(stats, telemetry) {
  stats.found += telemetry.found ?? 0;
  stats.downgraded += telemetry.downgraded ?? 0;
  stats.estimatedSavedChars += telemetry.estimatedSavedChars ?? 0;
}

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function nextBackupPath(file) {
  let candidate = `${file}.icc-backup`;
  if (!(await fileExists(candidate))) return candidate;
  for (let i = 1; ; i++) {
    candidate = `${file}.icc-backup.${i}`;
    if (!(await fileExists(candidate))) return candidate;
  }
}

async function scanJsonlBoundary(file) {
  let lineNo = 0;
  let lastUserLine = 0;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    lineNo++;
    try {
      const obj = JSON.parse(line);
      if (hasUserRole(obj)) lastUserLine = lineNo;
    } catch {
      // Boundary scan ignores malformed lines; second pass reports skippedLines.
    }
  }
  return { lines: lineNo, boundaryLine: lastUserLine || null };
}

function lineOut(line, obj, result) {
  return result.mutated ? `${JSON.stringify(result.payload)}\n` : `${line}\n`;
}

async function transformJsonl(file, opts, writePath) {
  const first = await scanJsonlBoundary(file);
  const st = await stat(file);
  const stats = emptyStats(file, "jsonl", !opts.yes);
  stats.lines = first.lines;
  stats.boundaryLine = opts.all ? null : first.boundaryLine;
  stats.bytesBefore = st.size;

  let lineNo = 0;
  let estimatedBytesAfter = 0;
  let changed = false;
  const out = writePath ? createWriteStream(writePath, { flags: "wx" }) : null;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      lineNo++;
      let output = `${line}\n`;
      const shouldProcess = opts.all || (first.boundaryLine !== null && lineNo < first.boundaryLine);
      if (shouldProcess) {
        try {
          const obj = JSON.parse(line);
          const result = cascadeImages(obj, { strategy: historicalStrategy });
          addTelemetry(stats, result.telemetry);
          output = lineOut(line, obj, result);
          if (result.mutated) changed = true;
        } catch {
          stats.skippedLines++;
        }
      }
      estimatedBytesAfter += Buffer.byteLength(output);
      if (out && !out.write(output)) await new Promise((resolve) => out.once("drain", resolve));
    }
  } finally {
    if (out) await new Promise((resolve, reject) => out.end((err) => err ? reject(err) : resolve()));
  }

  stats.estimatedBytesAfter = changed ? estimatedBytesAfter : stats.bytesBefore;
  stats.changed = changed;
  return stats;
}

async function transformSingleJson(file, opts, writePath) {
  const buf = await readFile(file);
  const text = buf.toString("utf8");
  const stats = emptyStats(file, "json", !opts.yes);
  stats.bytesBefore = buf.length;
  stats.lines = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse JSON document: ${err.message}`);
  }
  const result = cascadeImages(obj, opts.all ? { strategy: historicalStrategy } : {});
  addTelemetry(stats, result.telemetry);
  stats.changed = result.mutated;
  const output = result.mutated ? JSON.stringify(result.payload, null, 2) + "\n" : text;
  stats.estimatedBytesAfter = result.mutated ? Buffer.byteLength(output) : stats.bytesBefore;
  if (writePath) {
    const stream = createWriteStream(writePath, { flags: "wx" });
    await new Promise((resolve, reject) => stream.end(output, (err) => err ? reject(err) : resolve()));
  }
  return stats;
}

async function rescue(file, opts) {
  try { await access(file); } catch { throw new Error(`File not found: ${file}`); }
  const mode = extname(file).toLowerCase() === ".jsonl" ? "jsonl" : "json";
  const dryStats = mode === "jsonl" ? await transformJsonl(file, opts, null) : await transformSingleJson(file, opts, null);
  if (!opts.yes || !dryStats.changed) return dryStats;

  const temp = join(dirname(file), `.${basename(file)}.icc-tmp-${process.pid}-${Date.now()}`);
  try {
    const writeStats = mode === "jsonl" ? await transformJsonl(file, opts, temp) : await transformSingleJson(file, opts, temp);
    if (!writeStats.changed) {
      await unlink(temp).catch(() => {});
      return { ...writeStats, estimatedBytesAfter: writeStats.bytesBefore };
    }
    const backup = await nextBackupPath(file);
    await copyFile(file, backup);
    await rename(temp, file);
    const after = await stat(file);
    return { ...writeStats, backup, bytesAfter: after.size };
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

function printStats(stats, json) {
  if (json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  console.log(`mode: ${stats.mode}`);
  console.log(`lines: ${stats.lines}`);
  if (stats.mode === "jsonl") console.log(`boundaryLine: ${stats.boundaryLine ?? "none"}`);
  console.log(`found: ${stats.found}`);
  console.log(`downgraded: ${stats.downgraded}`);
  console.log(`skippedLines: ${stats.skippedLines}`);
  console.log(`estimatedSavedChars: ${stats.estimatedSavedChars}`);
  console.log(`bytesBefore: ${stats.bytesBefore}`);
  console.log(`estimatedBytesAfter: ${stats.estimatedBytesAfter}`);
  if (stats.bytesAfter !== null) console.log(`bytesAfter: ${stats.bytesAfter}`);
  if (stats.backup) console.log(`backup: ${stats.backup}`);
  if (stats.mode === "jsonl" && stats.boundaryLine === null && stats.downgraded === 0) {
    console.log("no user-message boundary found; nothing downgraded. Use --all to downgrade all image blocks.");
  }
  if (stats.dryRun) console.log("dry-run: no files written; rerun with --yes to apply changes.");
  else if (!stats.changed) console.log("no changes needed.");
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        yes: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        version: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(`error: ${err.message}\n`);
    console.error(usage());
    return 1;
  }
  if (parsed.values.version) {
    console.log(await cliVersion());
    return 0;
  }
  const [cmd, file] = parsed.positionals;
  if (parsed.values.help || !cmd) {
    console.log(usage());
    return 0;
  }
  if (cmd !== "rescue" || !file) {
    console.error(usage());
    return 1;
  }
  try {
    const stats = await rescue(file, parsed.values);
    printStats(stats, Boolean(parsed.values.json));
    return 0;
  } catch (err) {
    if (parsed.values.json) console.error(JSON.stringify({ error: err.message }));
    else console.error(`error: ${err.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("main.js")) {
  process.exitCode = await main();
}
