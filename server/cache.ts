import { mkdir, readdir, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";

export type Bytes = Uint8Array<ArrayBuffer>;

interface Entry {
  path: string;
  size: number;
  mtime: number;
}

/**
 * Tiny content-addressed disk cache. Entries live in `<dir>/<namespace>/<xx>/<hash>`;
 * the modification time doubles as "last used" so pruning evicts the coldest entries first.
 */
export class DiskCache {
  private inflight = new Map<string, Promise<Bytes>>();
  private writesSincePrune = 0;

  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {}

  private path(namespace: string, key: string): string {
    const hash = new Bun.CryptoHasher("sha1").update(key).digest("hex");
    return join(this.dir, namespace, hash.slice(0, 2), hash.slice(2));
  }

  async get(namespace: string, key: string, maxAgeMs = Number.POSITIVE_INFINITY): Promise<Bytes | null> {
    const path = this.path(namespace, key);
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    if (Date.now() - file.lastModified > maxAgeMs) return null;
    try {
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async set(namespace: string, key: string, data: Bytes): Promise<void> {
    try {
      await Bun.write(this.path(namespace, key), data);
      if (++this.writesSincePrune >= 200) {
        this.writesSincePrune = 0;
        void this.prune();
      }
    } catch (error) {
      console.warn("[cache] write failed:", (error as Error).message);
    }
  }

  /** Marks an entry as recently used so it survives pruning longer. */
  touch(namespace: string, key: string): void {
    const now = new Date();
    utimes(this.path(namespace, key), now, now).catch(() => {});
  }

  private async read(namespace: string, key: string): Promise<{ data: Bytes; age: number } | null> {
    const file = Bun.file(this.path(namespace, key));
    if (!(await file.exists())) return null;
    try {
      return { data: new Uint8Array(await file.arrayBuffer()), age: Date.now() - file.lastModified };
    } catch {
      return null;
    }
  }

  private produceOnce(namespace: string, key: string, produce: () => Promise<Bytes>): Promise<Bytes> {
    const id = `${namespace}:${key}`;
    let pending = this.inflight.get(id);
    if (!pending) {
      pending = produce()
        .then(async (data) => {
          await this.set(namespace, key, data);
          return data;
        })
        .finally(() => this.inflight.delete(id));
      this.inflight.set(id, pending);
    }
    return pending;
  }

  /**
   * Returns the cached value or computes it once, even when many callers ask at the same time.
   * `fresh` tells whether the value came from the producer rather than from disk.
   *
   * With `serveStale`, an expired entry is still returned at once while a new one is produced
   * in the background: callers never wait for slow upstreams twice.
   */
  async wrap(
    namespace: string,
    key: string,
    maxAgeMs: number,
    produce: () => Promise<Bytes>,
    options: { serveStale?: boolean } = {},
  ): Promise<{ data: Bytes; fresh: boolean }> {
    const hit = await this.read(namespace, key);
    if (hit && hit.age <= maxAgeMs) return { data: hit.data, fresh: false };
    if (hit && options.serveStale) {
      this.produceOnce(namespace, key, produce).catch((error: Error) => {
        console.warn(`[cache] background refresh of ${namespace} failed: ${error.message}`);
      });
      return { data: hit.data, fresh: false };
    }
    return { data: await this.produceOnce(namespace, key, produce), fresh: true };
  }

  private async walk(dir: string, out: Entry[]): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (info.isDirectory()) await this.walk(path, out);
        else out.push({ path, size: info.size, mtime: info.mtimeMs });
      } catch {
        // The entry disappeared while walking: nothing to account for.
      }
    }
  }

  /** Deletes the least recently used entries until the cache fits its budget again. */
  async prune(): Promise<{ files: number; bytes: number; removed: number }> {
    await mkdir(this.dir, { recursive: true });
    const entries: Entry[] = [];
    await this.walk(this.dir, entries);
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    let removed = 0;
    if (bytes > this.maxBytes) {
      entries.sort((a, b) => a.mtime - b.mtime);
      const target = this.maxBytes * 0.85;
      for (const entry of entries) {
        if (bytes <= target) break;
        try {
          await unlink(entry.path);
          bytes -= entry.size;
          removed++;
        } catch {
          // Already gone.
        }
      }
    }
    return { files: entries.length - removed, bytes, removed };
  }
}
