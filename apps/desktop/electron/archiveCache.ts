import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { openArchive } from '@longbox/core';
import type { ComicArchive } from '@longbox/core';

/**
 * Keeps recently opened archives in memory.
 *
 * Reading a comic means requesting page after page from the same file. Without
 * a cache each page turn would re-read and re-index a 50MB archive, which is
 * both slow and pointless. With one, only the first page of a book pays that
 * cost.
 *
 * The cap is on the number of open archives rather than on bytes, since a
 * couple of comics held open is a bounded and predictable amount of memory,
 * and the reader only ever needs the current book plus whatever it prefetched.
 */

const MAX_OPEN_ARCHIVES = 3;

interface CacheEntry {
  archive: ComicArchive;
  /** Bumped on each access; the lowest value is evicted first. */
  lastUsed: number;
}

const cache = new Map<string, CacheEntry>();
/** In-flight opens, so concurrent page requests share one read of the file. */
const pending = new Map<string, Promise<ComicArchive>>();
let clock = 0;

export async function getArchive(path: string): Promise<ComicArchive> {
  const hit = cache.get(path);
  if (hit) {
    hit.lastUsed = clock++;
    return hit.archive;
  }

  const inFlight = pending.get(path);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const data = new Uint8Array(await readFile(path));
    const { archive } = await openArchive(data, basename(path));
    return archive;
  })();

  pending.set(path, promise);

  try {
    const archive = await promise;
    cache.set(path, { archive, lastUsed: clock++ });
    evictIfNeeded();
    return archive;
  } finally {
    pending.delete(path);
  }
}

function evictIfNeeded(): void {
  while (cache.size > MAX_OPEN_ARCHIVES) {
    let oldestKey: string | undefined;
    let oldestUse = Number.POSITIVE_INFINITY;

    for (const [key, entry] of cache) {
      if (entry.lastUsed < oldestUse) {
        oldestUse = entry.lastUsed;
        oldestKey = key;
      }
    }

    if (oldestKey === undefined) return;
    cache.get(oldestKey)?.archive.close();
    cache.delete(oldestKey);
  }
}

/** Drop a specific archive, e.g. after its file was moved or deleted. */
export function invalidate(path: string): void {
  cache.get(path)?.archive.close();
  cache.delete(path);
}

export function closeAll(): void {
  for (const entry of cache.values()) entry.archive.close();
  cache.clear();
}
