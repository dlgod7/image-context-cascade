import type { ImageTracker } from "./types";

export class InMemoryTracker implements ImageTracker {
  readonly maxEntries: number;
  private entries = new Map<string, { seenInUserTurn: boolean; lastSeen: number }>();
  private tick = 0;

  constructor(opts?: { maxEntries?: number }) {
    this.maxEntries = opts?.maxEntries ?? 200;
  }

  has(hash: string): boolean {
    const entry = this.entries.get(hash);
    if (!entry) return false;
    entry.lastSeen = ++this.tick;
    return true;
  }

  remember(hash: string, meta: { seenInUserTurn: boolean }): void {
    const existing = this.entries.get(hash);
    this.entries.set(hash, {
      seenInUserTurn: existing?.seenInUserTurn || meta.seenInUserTurn,
      lastSeen: ++this.tick,
    });
    while (this.entries.size > this.maxEntries) {
      let oldestHash: string | undefined;
      let oldestSeen = Infinity;
      for (const [key, value] of this.entries) {
        if (value.lastSeen < oldestSeen) { oldestSeen = value.lastSeen; oldestHash = key; }
      }
      if (!oldestHash) break;
      this.entries.delete(oldestHash);
    }
  }

  size(): number {
    return this.entries.size;
  }
}
