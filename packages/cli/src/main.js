#!/usr/bin/env bun
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { cascadeImages, cascadeImagesAsync, fsSourceStore, restoreImage } from "image-context-cascade";

const historicalStrategy = Object.assign(() => "historical", { cascadeStrategyName: "custom" });
const defaultStoreDir = () => process.env.ICC_STORE_DIR || join(homedir(), ".image-cascade", "store");

function usage() {
  return `image-cascade rescue <file> [--yes] [--all] [--json] [--store[=dir]]\nimage-cascade restore <hash> [--store <dir>] [--out <file>]\nimage-cascade hook claude-code [--store <dir>] [--json]\n\nRescue oversized image session files by downgrading historical image blocks.\n\nCommands:\n  rescue <file>     Analyze or rewrite a .jsonl session or a single JSON document.\n  restore <hash>    Restore a stored image/document payload to a file.\n  hook claude-code  Read a Claude Code hook payload (JSON) from stdin and archive\n                    historical images in that session transcript. Intended for a\n                    SessionEnd hook. Always uses a source store so everything is\n                    restorable; never fails the hook (runtime errors exit 0).\n\nOptions:\n  --yes           Write changes. Default is dry-run and writes nothing.\n  --all           Downgrade all image blocks, including when no user-message boundary is found.\n  --store <dir>   Enable source store. Bare --store uses ~/.image-cascade/store.\n  --out <file>    Restore output file. Default: ./restored-<hash12>.<ext>.\n  --json          Print machine-readable JSON statistics.\n  --version, -v   Print the CLI version.\n  --help, -h      Show this help.\n\nEnvironment:\n  ICC_DISABLE=1   Disable hook-triggered processing. Manual rescue/restore still run.\n  ICC_STORE_DIR   Override the default source store directory (~/.image-cascade/store).\n\nNotes:\n  JSONL mode uses two streaming passes and O(1) memory. Single JSON mode reads the whole file into memory.\n`;
}

async function cliVersion() {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  return pkg.version;
}

function normalizeArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--store") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) out.push(`--store=${defaultStoreDir()}`);
      else out.push(argv[i]);
    } else out.push(argv[i]);
  }
  return out;
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
    stored: 0,
    thumbnailed: 0,
    dedupedRefs: 0,
    storeErrors: 0,
  };
}

function addTelemetry(stats, telemetry) {
  stats.found += telemetry.found ?? 0;
  stats.downgraded += telemetry.downgraded ?? 0;
  stats.estimatedSavedChars += telemetry.estimatedSavedChars ?? 0;
  stats.stored += telemetry.stored ?? 0;
  stats.thumbnailed += telemetry.thumbnailed ?? 0;
  stats.dedupedRefs += telemetry.dedupedRefs ?? 0;
  stats.storeErrors += telemetry.storeErrors ?? 0;
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
    } catch {}
  }
  return { lines: lineNo, boundaryLine: lastUserLine || null };
}

function lineOut(line, result) {
  return result.mutated ? `${JSON.stringify(result.payload)}\n` : `${line}\n`;
}

async function runCascade(obj, opts) {
  const cascadeOpts = { strategy: historicalStrategy, ...(opts.store ? { store: fsSourceStore(opts.store) } : {}) };
  return opts.store ? await cascadeImagesAsync(obj, cascadeOpts) : cascadeImages(obj, { strategy: historicalStrategy });
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
          const result = await runCascade(obj, writePath ? opts : { ...opts, store: undefined });
          addTelemetry(stats, result.telemetry);
          output = lineOut(line, result);
          if (result.mutated) changed = true;
        } catch { stats.skippedLines++; }
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
  try { obj = JSON.parse(text); } catch (err) { throw new Error(`Failed to parse JSON document: ${err.message}`); }
  const cascadeOpts = opts.all ? { strategy: historicalStrategy } : {};
  const activeStore = writePath ? opts.store : undefined;
  const result = activeStore ? await cascadeImagesAsync(obj, { ...cascadeOpts, store: fsSourceStore(activeStore) }) : cascadeImages(obj, cascadeOpts);
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
  const statBefore = await stat(file);
  const dryStats = mode === "jsonl" ? await transformJsonl(file, opts, null) : await transformSingleJson(file, opts, null);
  if (!opts.yes || !dryStats.changed) return dryStats;
  const temp = join(dirname(file), `.${basename(file)}.icc-tmp-${process.pid}-${Date.now()}`);
  try {
    const writeStats = mode === "jsonl" ? await transformJsonl(file, opts, temp) : await transformSingleJson(file, opts, temp);
    if (!writeStats.changed) {
      await unlink(temp).catch(() => {});
      return { ...writeStats, estimatedBytesAfter: writeStats.bytesBefore };
    }
    const statAfter = await stat(file);
    if (statAfter.size !== statBefore.size || statAfter.mtimeMs !== statBefore.mtimeMs) {
      await unlink(temp).catch(() => {});
      throw new Error(`File changed while rescuing (another process may be writing it): ${file}. Nothing was modified; close the session and retry.`);
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

function iccDisabled() {
  const v = (process.env.ICC_DISABLE || "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

async function readStdinWithTimeout(timeoutMs) {
  if (process.stdin.isTTY) return null;
  let data = "";
  const timer = setTimeout(() => process.stdin.destroy(), timeoutMs);
  try {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) data += chunk;
  } catch {}
  clearTimeout(timer);
  return data.trim() || null;
}

async function hookCmd(opts) {
  const say = (msg) => console.error(`image-cascade hook: ${msg}`);
  try {
    if (iccDisabled()) { say("ICC_DISABLE is set; skipping."); return null; }
    const raw = await readStdinWithTimeout(3000);
    if (!raw) { say("no hook payload on stdin; skipping."); return null; }
    let input;
    try { input = JSON.parse(raw); } catch { say("hook payload is not valid JSON; skipping."); return null; }
    const transcript = typeof input.transcript_path === "string" ? input.transcript_path : null;
    if (!transcript) { say("no transcript_path in hook payload; skipping."); return null; }
    if (!(await fileExists(transcript))) { say(`transcript not found, skipping: ${transcript}`); return null; }
    const stats = await rescue(transcript, { yes: true, all: false, store: opts.store || defaultStoreDir() });
    if (stats.changed) say(`archived ${stats.downgraded} historical image/document blocks in ${transcript} (${stats.bytesBefore} -> ${stats.bytesAfter} bytes; backup: ${stats.backup})`);
    else say(`nothing to archive in ${transcript}.`);
    return stats;
  } catch (err) {
    say(`skipped: ${err?.message || err}`);
    return null;
  }
}

// Extension is cosmetic only — restored bytes are always exact regardless of
// media type. Derivation is allowlisted ([a-z0-9]{1,8}) because mediaType
// comes from payload data and ends up in a filename.
const EXT_BY_MEDIA_TYPE = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" };

function extFor(mediaType) {
  const known = EXT_BY_MEDIA_TYPE[mediaType];
  if (known) return known;
  const sub = /^[a-z]+\/([a-z0-9.+-]+)$/i.exec(mediaType || "")?.[1];
  if (!sub) return "bin";
  const cleaned = sub.replace(/^x-/, "").replace(/\+.*$/, "");
  return /^[a-z0-9]{1,8}$/i.test(cleaned) ? cleaned.toLowerCase() : "bin";
}

async function restoreCmd(hash, opts) {
  if (!/^[0-9a-f]{6,64}$/i.test(hash)) {
    throw new Error(`Invalid hash "${hash}": expected 6-64 hex characters (use the 12-char hash from a placeholder).`);
  }
  const store = fsSourceStore(opts.store || defaultStoreDir());
  const fullHash = (store.resolve && (await store.resolve(hash))) || hash;
  const img = await restoreImage(store, fullHash);
  if (!img) throw new Error(`Stored image not found: ${hash}`);
  const out = opts.out || resolve(`restored-${fullHash.slice(0, 12)}.${extFor(img.mediaType)}`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(img.data, "base64"));
  return { hash: fullHash, out, mediaType: img.mediaType, bytes: Buffer.from(img.data, "base64").length };
}

function printStats(stats, json, storeEnabled) {
  if (json) { console.log(JSON.stringify(stats, null, 2)); return; }
  console.log(`mode: ${stats.mode}`);
  console.log(`lines: ${stats.lines}`);
  if (stats.mode === "jsonl") console.log(`boundaryLine: ${stats.boundaryLine ?? "none"}`);
  console.log(`found: ${stats.found}`);
  console.log(`downgraded: ${stats.downgraded}`);
  console.log(`skippedLines: ${stats.skippedLines}`);
  console.log(`estimatedSavedChars: ${stats.estimatedSavedChars}`);
  if (storeEnabled) {
    console.log(`stored: ${stats.stored}`);
    console.log(`thumbnailed: ${stats.thumbnailed}`);
    console.log(`dedupedRefs: ${stats.dedupedRefs}`);
    console.log(`storeErrors: ${stats.storeErrors}`);
  }
  console.log(`bytesBefore: ${stats.bytesBefore}`);
  console.log(`estimatedBytesAfter: ${stats.estimatedBytesAfter}`);
  if (stats.bytesAfter !== null) console.log(`bytesAfter: ${stats.bytesAfter}`);
  if (stats.backup) console.log(`backup: ${stats.backup}`);
  if (stats.mode === "jsonl" && stats.boundaryLine === null && stats.downgraded === 0) console.log("no user-message boundary found; nothing downgraded. Use --all to downgrade all image blocks.");
  if (stats.dryRun) console.log("dry-run: no files written; rerun with --yes to apply changes.");
  else if (!stats.changed) console.log("no changes needed.");
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: normalizeArgs(argv),
      allowPositionals: true,
      options: {
        yes: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        store: { type: "string" },
        out: { type: "string" },
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
  if (parsed.values.version) { console.log(await cliVersion()); return 0; }
  const [cmd, fileOrHash] = parsed.positionals;
  if (parsed.values.help || !cmd) { console.log(usage()); return 0; }
  try {
    if (cmd === "hook") {
      if (fileOrHash !== "claude-code") {
        console.error(`error: unknown hook host "${fileOrHash ?? ""}". Supported: claude-code\n`);
        console.error(usage());
        return 1;
      }
      const stats = await hookCmd(parsed.values);
      if (parsed.values.json && stats) console.log(JSON.stringify(stats, null, 2));
      return 0;
    }
    if (cmd === "rescue" && fileOrHash) {
      const stats = await rescue(fileOrHash, parsed.values);
      printStats(stats, Boolean(parsed.values.json), Boolean(parsed.values.store));
      return 0;
    }
    if (cmd === "restore" && fileOrHash) {
      const result = await restoreCmd(fileOrHash, parsed.values);
      if (parsed.values.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`restored: ${result.out}`);
      return 0;
    }
    console.error(usage());
    return 1;
  } catch (err) {
    if (parsed.values.json) console.error(JSON.stringify({ error: err.message }));
    else console.error(`error: ${err.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("main.js")) {
  process.exitCode = await main();
}
