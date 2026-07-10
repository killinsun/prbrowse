import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppOptions, Comment, PullRequest } from "./types.ts";

const CACHE_VERSION = 2 as const;

export interface DiskCache {
  version: typeof CACHE_VERSION;
  savedAt: string;
  options: {
    org: string;
    repos: string[];
    author: string;
    limit: number | null;
    state: string;
  };
  prs: PullRequest[];
  comments: Record<string, Comment[]>;
}

export function cacheDir(): string {
  return join(homedir(), ".cache", "prbrowse");
}

function cacheKey(options: AppOptions): string {
  const payload = JSON.stringify({
    org: options.org,
    repos: [...options.repos].sort(),
    author: options.author,
    limit: options.limit,
    state: options.state,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function cachePath(options: AppOptions): string {
  return join(cacheDir(), `${cacheKey(options)}.json`);
}

export async function loadDiskCache(
  options: AppOptions,
): Promise<DiskCache | null> {
  try {
    const raw = await readFile(cachePath(options), "utf8");
    const data = JSON.parse(raw) as DiskCache;
    if (data.version !== CACHE_VERSION) return null;
    if (!Array.isArray(data.prs) || typeof data.comments !== "object") {
      return null;
    }
    return data;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return null;
  }
}

export async function saveDiskCache(
  options: AppOptions,
  prs: PullRequest[],
  comments: Record<string, Comment[]>,
): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  const data: DiskCache = {
    version: CACHE_VERSION,
    savedAt: new Date().toISOString(),
    options: {
      org: options.org,
      repos: options.repos,
      author: options.author,
      limit: options.limit,
      state: options.state,
    },
    prs,
    comments,
  };
  await writeFile(cachePath(options), JSON.stringify(data), "utf8");
}

/** Delete cache for the given options key. Returns whether a file was removed. */
export async function clearDiskCache(options: AppOptions): Promise<boolean> {
  const path = cachePath(options);
  try {
    await rm(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw err;
  }
}

/** Delete all prbrowse cache files. Returns number of files removed. */
export async function clearAllCaches(): Promise<number> {
  const dir = cacheDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0;
    throw err;
  }

  let removed = 0;
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    await rm(join(dir, name));
    removed += 1;
  }
  return removed;
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, total)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= total) return;
        results[i] = await fn(items[i]!, i);
        done += 1;
        onProgress?.(done, total);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
