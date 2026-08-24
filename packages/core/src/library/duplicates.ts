import type { Comic, DuplicateGroup } from '../types.ts';
import { normaliseSeriesName } from '../util/id.ts';

/**
 * Finding the same book twice.
 *
 * A personal library accumulates duplicates in predictable ways: the same
 * issue downloaded twice under slightly different names, a CBR later replaced
 * by a CBZ, a "(1)" suffix from a browser that would not overwrite. None of
 * those are detectable by id, because id is a hash of path and size and every
 * one of these has a different path.
 *
 * Nothing here deletes anything. The result is a list of candidates for a
 * person to look at, so the strategies are ordered by how much they can be
 * trusted and each comic appears in at most one group, under the strongest
 * reason that found it.
 */

/** Ordered strongest first. The UI relies on this order. */
const STRATEGY_ORDER: DuplicateGroup['reason'][] = [
  'same-cover',
  'identical-size',
  'same-series-issue',
];

/**
 * Rank within a group, best candidate first.
 *
 * "Best" is the one worth keeping: more pages beats fewer (a truncated
 * download is the classic duplicate), then larger file (higher quality scan),
 * then whichever was indexed first. The UI shows the first as the one to keep,
 * so this ordering decides what a person sees pre-selected.
 */
function byQuality(a: Comic, b: Comic): number {
  if (a.pageCount !== b.pageCount) return b.pageCount - a.pageCount;
  if (a.size !== b.size) return b.size - a.size;
  return a.addedAt - b.addedAt;
}

/**
 * Key a comic for one strategy, or undefined when it cannot participate.
 *
 * Size is paired with page count rather than used alone. Two unrelated files
 * sharing a byte count is uncommon but not rare enough to present as a
 * duplicate on its own, and a genuine duplicate agrees on both.
 */
function keyFor(comic: Comic, reason: DuplicateGroup['reason']): string | undefined {
  switch (reason) {
    case 'same-cover':
      return comic.coverHash ? `cover:${comic.coverHash}` : undefined;

    case 'identical-size':
      return comic.size > 0 ? `size:${comic.size}:${comic.pageCount}` : undefined;

    case 'same-series-issue': {
      const series = comic.metadata.series;
      const issue = comic.metadata.issue;
      if (!series || !issue) return undefined;
      return `issue:${normaliseSeriesName(series)}:${issue.toLowerCase()}`;
    }
  }
}

export interface DuplicateOptions {
  /**
   * Include comics whose files went missing on the last scan. Off by default:
   * a missing file paired with a present one is the normal state after moving
   * a folder, and reporting every one of those as a duplicate is noise.
   */
  includeMissing?: boolean;
}

/**
 * Group comics that look like the same book.
 *
 * Groups of one are not duplicates and are dropped. A comic claimed by a
 * stronger strategy is not offered again to a weaker one, so a CBR and CBZ
 * sharing a cover hash are reported once as `same-cover` rather than three
 * times under three reasons.
 */
export function findDuplicates(comics: Comic[], options: DuplicateOptions = {}): DuplicateGroup[] {
  const eligible = options.includeMissing ? comics : comics.filter((comic) => !comic.missing);

  const claimed = new Set<string>();
  const groups: DuplicateGroup[] = [];

  for (const reason of STRATEGY_ORDER) {
    const buckets = new Map<string, Comic[]>();

    for (const comic of eligible) {
      if (claimed.has(comic.id)) continue;
      const key = keyFor(comic, reason);
      if (key === undefined) continue;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(comic);
      else buckets.set(key, [comic]);
    }

    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      const sorted = [...bucket].sort(byQuality);
      for (const comic of sorted) claimed.add(comic.id);
      groups.push({ reason, comicIds: sorted.map((comic) => comic.id) });
    }
  }

  return groups;
}

/**
 * Bytes that would be freed by keeping only the first comic in each group.
 *
 * Shown next to the list because it is the number that decides whether this is
 * worth anyone's afternoon.
 */
export function duplicateWaste(groups: DuplicateGroup[], comics: Comic[]): number {
  const byId = new Map(comics.map((comic) => [comic.id, comic]));
  let total = 0;
  for (const group of groups) {
    for (const id of group.comicIds.slice(1)) {
      total += byId.get(id)?.size ?? 0;
    }
  }
  return total;
}
