import { mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SourceStore, StoredImage, TierPolicy } from "./types";

export function defaultTierPolicy(opts: { thumbnailMaxAge?: number } = {}): TierPolicy {
  return (_id, ctx) => {
    const maxAge = opts.thumbnailMaxAge ?? (ctx.source === "tool" ? 1 : 2);
    return ctx.age <= maxAge ? "thumbnail" : "placeholder";
  };
}

type StoreWithErrors = SourceStore & { __errorCount?: () => number };

async function listJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(path: string): Promise<void> {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

export function fsSourceStore(dir: string, opts: { maxBytes?: number } = {}): SourceStore {
  let errors = 0;
  const pathFor = (hash: string) => join(dir, hash.slice(0, 2), `${hash}.json`);
  const cleanup = async (): Promise<void> => {
    if (!opts.maxBytes) return;
    const files = await listJsonFiles(dir);
    const withStats = await Promise.all(files.map(async (path) => ({ path, st: await stat(path) })));
    let total = withStats.reduce((sum, x) => sum + x.st.size, 0);
    for (const item of withStats.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs)) {
      if (total <= opts.maxBytes) break;
      try {
        await unlink(item.path);
        total -= item.st.size;
      } catch { errors++; }
    }
  };
  const store: StoreWithErrors = {
    async put(hash, image) {
      try {
        const file = pathFor(hash);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(image));
        await cleanup();
      } catch { errors++; }
    },
    async get(hash) {
      try {
        const file = pathFor(hash);
        const value = JSON.parse(await readFile(file, "utf8")) as StoredImage;
        const now = new Date();
        await utimes(file, now, now).catch(() => undefined);
        return value;
      } catch { errors++; return null; }
    },
    async has(hash) {
      try {
        const file = pathFor(hash);
        await stat(file);
        const now = new Date();
        await utimes(file, now, now).catch(() => undefined);
        return true;
      } catch { errors++; return false; }
    },
    async resolve(prefix) {
      try {
        if (!/^[0-9a-f]{2,64}$/i.test(prefix)) return null;
        const lower = prefix.toLowerCase();
        let entries: string[];
        try { entries = await readdir(join(dir, lower.slice(0, 2))); } catch { return null; }
        const matches = entries.filter((name) => name.endsWith(".json") && name.startsWith(lower));
        if (matches.length !== 1) return null;
        return matches[0]!.slice(0, -".json".length);
      } catch { errors++; return null; }
    },
    __errorCount: () => errors,
  };
  return store;
}
