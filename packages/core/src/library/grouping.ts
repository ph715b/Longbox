import type { Comic, Series } from '../types.ts';
import { seriesId } from '../util/id.ts';

/**
 * Rolling a flat list of files up into series.
 *
 * Series are derived, never stored: they're recomputed from whatever metadata
 * the comics currently carry. That means editing an issue's series name moves
 * it between groups immediately, with no separate table to keep in sync and no
 * way for the two to drift apart.
 */

/** Comics with no usable series name are grouped under this bucket. */
export const UNGROUPED_SERIES_ID = 'ungrouped';

/**
 * Order issues within a series the way a reader expects: numbered issues in
 * numeric order, then specials and annuals, then anything unnumbered.
 */
export function compareIssues(a: Comic, b: Comic): number {
  const aNum = a.metadata.issueNumber;
  const bNum = b.metadata.issueNumber;

  // Named issues ("Annual 1") sort after plain numbered ones even when both
  // carry a number, so a run of issues isn't interrupted by its annuals.
  const aNamed = isNamedIssue(a);
  const bNamed = isNamedIssue(b);
  if (aNamed !== bNamed) return aNamed ? 1 : -1;

  if (aNum !== undefined && bNum !== undefined && aNum !== bNum) return aNum - bNum;
  if (aNum !== undefined && bNum === undefined) return -1;
  if (aNum === undefined && bNum !== undefined) return 1;

  // Same number, or both unnumbered: fall back to year, then filename, so the
  // order is at least stable between runs.
  const aYear = a.metadata.year ?? 0;
  const bYear = b.metadata.year ?? 0;
  if (aYear !== bYear) return aYear - bYear;

  return a.filename.localeCompare(b.filename, undefined, { numeric: true });
}

function isNamedIssue(comic: Comic): boolean {
  const issue = comic.metadata.issue;
  return issue !== undefined && /^[a-z]/i.test(issue);
}

/**
 * Build the series list from a set of comics, and stamp each comic with the
 * `seriesId` it belongs to.
 *
 * Mutates `comic.seriesId` deliberately: the caller's comics are the single
 * copy the app holds, and returning parallel data to be merged later is a
 * reliable source of bugs.
 */
export function groupIntoSeries(comics: Comic[]): Series[] {
  const buckets = new Map<string, Comic[]>();

  for (const comic of comics) {
    const name = comic.metadata.series?.trim();
    const id = name ? seriesId(name) : UNGROUPED_SERIES_ID;
    comic.seriesId = id;
    const bucket = buckets.get(id);
    if (bucket) bucket.push(comic);
    else buckets.set(id, [comic]);
  }

  const series: Series[] = [];

  for (const [id, members] of buckets) {
    members.sort(compareIssues);

    // Counts and the cover describe what is actually here. An issue whose file
    // has gone is still a member -- its reading history is worth keeping, and
    // the file may come back with the drive -- but counting it would overstate
    // the collection, and picking its cover would leave the series looking
    // broken because there is nothing to load.
    const present = members.filter((comic) => !comic.missing);

    // Prefer the most common spelling of the name rather than whichever issue
    // happened to sort first -- one mistyped filename shouldn't rename a series.
    const name =
      id === UNGROUPED_SERIES_ID
        ? 'Ungrouped'
        : mostCommon(members.map((comic) => comic.metadata.series).filter(isString)) ?? 'Unknown';

    const years = members
      .map((comic) => comic.metadata.year)
      .filter((year): year is number => typeof year === 'number' && year > 0);

    series.push({
      id,
      name,
      publisher: mostCommon(members.map((comic) => comic.metadata.publisher).filter(isString)),
      startYear: years.length > 0 ? Math.min(...years) : undefined,
      issueCount: present.length,
      readCount: present.filter((comic) => comic.state.completed).length,
      missingCount: members.length - present.length,
      // The lowest-numbered issue is the one whose cover represents the series,
      // falling back to a missing one only when every issue is gone.
      coverComicId: (present[0] ?? members[0])?.id,
      tags: [...new Set(members.flatMap((comic) => comic.tags))],
      favorite: members.some((comic) => comic.favorite),
    });
  }

  series.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return series;
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The most frequent value in a list; ties break toward the first seen. */
function mostCommon<T>(values: T[]): T | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  let best: T | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Detect the next unread issue in a series -- what a "continue reading" button
 * should open. Returns the first issue that isn't finished, which is also the
 * in-progress one when the reader stopped partway.
 */
export function nextUnread(seriesComics: Comic[]): Comic | undefined {
  const ordered = [...seriesComics].sort(compareIssues);
  return ordered.find((comic) => !comic.state.completed && !comic.missing);
}

/**
 * Find gaps in a run of issues, so the UI can point out that a series is
 * missing #4 and #7. Only considers plainly-numbered issues, since annuals and
 * specials don't imply a gap.
 */
export function missingIssues(seriesComics: Comic[]): number[] {
  const numbers = seriesComics
    .filter((comic) => !isNamedIssue(comic))
    .map((comic) => comic.metadata.issueNumber)
    .filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
    .sort((a, b) => a - b);

  if (numbers.length < 2) return [];

  const present = new Set(numbers);
  const gaps: number[] = [];
  for (let n = numbers[0]; n < numbers[numbers.length - 1]; n += 1) {
    if (!present.has(n)) gaps.push(n);
  }
  // A huge gap usually means two unrelated runs share a name, not 300 missing
  // issues; reporting hundreds of numbers helps nobody.
  return gaps.length > 50 ? [] : gaps;
}
