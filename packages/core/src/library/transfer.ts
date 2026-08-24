import type { Collection, Comic, LibraryFolder } from '../types.ts';
import type { LibrarySnapshot, LibrarySettings } from './store.ts';
import { SCHEMA_VERSION, emptySnapshot } from './store.ts';

/**
 * Moving a library between machines, and getting it back after a reinstall.
 *
 * The file carries the whole snapshot rather than a reduced "progress only"
 * format. It is small -- a few hundred bytes per comic -- and a backup that
 * quietly drops collections or per-series preferences is worse than no backup,
 * because the gap only shows up when it is needed.
 *
 * Comics themselves are never included. An export describes a library; the
 * files stay where they are on disk.
 */

/** Marker so our own file can be told apart from any other JSON. */
export const EXPORT_FORMAT = 'longbox-library';

/** Version of the envelope, independent of the library schema it carries. */
export const EXPORT_VERSION = 1;

export interface LibraryExport {
  format: typeof EXPORT_FORMAT;
  exportVersion: number;
  /** Schema of the snapshot inside, so an import can migrate it. */
  schemaVersion: number;
  exportedAt: number;
  /** Version of the app that wrote it, for support and debugging. */
  appVersion?: string;
  snapshot: LibrarySnapshot;
}

export interface ImportOptions {
  /**
   * Bring across the exporting machine's app settings. Off by default: someone
   * restoring reading progress rarely wants their theme and ports replaced too.
   */
  includeSettings?: boolean;
  /**
   * Add the watched folders from the export. Useful on the same machine,
   * unhelpful when those paths belong to a different one.
   */
  includeFolders?: boolean;
}

export interface ImportSummary {
  /** Comics in the file that were found in this library. */
  matched: number;
  /** Of those, how many were located by each strategy. */
  matchedById: number;
  matchedByNameAndSize: number;
  matchedByName: number;
  /** Comics in the file with no counterpart here -- usually not scanned yet. */
  unmatched: number;
  /** Matched comics whose reading position actually moved forward. */
  progressUpdated: number;
  foldersAdded: number;
  collectionsAdded: number;
  collectionsMerged: number;
  seriesPreferencesAdded: number;
  /** Days of reading history brought across from the export's activity log. */
  activityDaysMerged: number;
  settingsApplied: boolean;
}

/** Wrap the current library for writing to disk. */
export function buildExport(
  snapshot: LibrarySnapshot,
  appVersion?: string,
  now = Date.now(),
): LibraryExport {
  return {
    format: EXPORT_FORMAT,
    exportVersion: EXPORT_VERSION,
    schemaVersion: snapshot.version ?? SCHEMA_VERSION,
    exportedAt: now,
    appVersion,
    snapshot,
  };
}

/**
 * Read an export back, rejecting anything that is not one.
 *
 * An import rewrites reading history, so a confident error on the wrong file
 * beats a best-effort parse that half-applies something unrelated.
 */
export function parseExport(text: string): LibraryExport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON, so it is not a Longbox export.');
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('That file does not contain a Longbox export.');
  }

  const candidate = raw as Partial<LibraryExport>;
  if (candidate.format !== EXPORT_FORMAT) {
    throw new Error('That file is not a Longbox library export.');
  }
  if (typeof candidate.exportVersion !== 'number' || candidate.exportVersion > EXPORT_VERSION) {
    throw new Error(
      `That export came from a newer version of Longbox (format ${String(candidate.exportVersion)}). Update the app to import it.`,
    );
  }
  if (typeof candidate.snapshot !== 'object' || candidate.snapshot === null) {
    throw new Error('That export is missing its library data.');
  }
  if (!Array.isArray(candidate.snapshot.comics)) {
    throw new Error('That export is missing its list of comics.');
  }

  return candidate as LibraryExport;
}

/** Filenames are compared case-insensitively, because Windows paths are. */
const nameKey = (comic: Comic) => comic.filename.toLowerCase();
const nameSizeKey = (comic: Comic) => `${nameKey(comic)}:${comic.size}`;

/**
 * Fold an exported library into this one.
 *
 * A comic's id is a hash of its path and size, so moving a collection to
 * another drive gives every file a new id, and reading history saved under the
 * old ids would match nothing. Matching therefore falls back to filename and
 * size, and then to filename alone where that is unambiguous. That fallback is
 * what lets an export survive a reorganised library.
 *
 * Nothing here deletes. Comics present locally but absent from the export are
 * left alone, so importing an old backup can never shrink a newer library.
 */
export function mergeImport(
  current: LibrarySnapshot,
  incoming: LibraryExport,
  options: ImportOptions = {},
): { snapshot: LibrarySnapshot; summary: ImportSummary } {
  const base = emptySnapshot();
  const snapshot: LibrarySnapshot = {
    ...base,
    ...current,
    settings: { ...base.settings, ...current.settings },
  };

  const summary: ImportSummary = {
    matched: 0,
    matchedById: 0,
    matchedByNameAndSize: 0,
    matchedByName: 0,
    unmatched: 0,
    progressUpdated: 0,
    foldersAdded: 0,
    collectionsAdded: 0,
    collectionsMerged: 0,
    seriesPreferencesAdded: 0,
    activityDaysMerged: 0,
    settingsApplied: false,
  };

  const byId = new Map(snapshot.comics.map((comic) => [comic.id, comic]));
  const byNameSize = new Map<string, Comic>();

  // Only filenames unique within this library are safe to match on name alone.
  // "01.cbz" turns up in every series and must never match across them.
  const nameCounts = new Map<string, number>();
  for (const comic of snapshot.comics) {
    byNameSize.set(nameSizeKey(comic), comic);
    nameCounts.set(nameKey(comic), (nameCounts.get(nameKey(comic)) ?? 0) + 1);
  }
  const byUniqueName = new Map<string, Comic>();
  for (const comic of snapshot.comics) {
    if (nameCounts.get(nameKey(comic)) === 1) byUniqueName.set(nameKey(comic), comic);
  }

  const idRemap = new Map<string, string>();

  for (const saved of incoming.snapshot.comics) {
    let local = byId.get(saved.id);
    let how: 'matchedById' | 'matchedByNameAndSize' | 'matchedByName' | undefined = local
      ? 'matchedById'
      : undefined;

    if (!local) {
      local = byNameSize.get(nameSizeKey(saved));
      if (local) how = 'matchedByNameAndSize';
    }
    if (!local) {
      local = byUniqueName.get(nameKey(saved));
      if (local) how = 'matchedByName';
    }

    if (!local || !how) {
      summary.unmatched += 1;
      continue;
    }

    summary.matched += 1;
    summary[how] += 1;
    idRemap.set(saved.id, local.id);

    if (applyReadingState(local, saved)) summary.progressUpdated += 1;
  }

  if (options.includeFolders !== false) {
    const known = new Set(snapshot.folders.map((folder) => folder.path.toLowerCase()));
    for (const folder of incoming.snapshot.folders ?? []) {
      if (known.has(folder.path.toLowerCase())) continue;
      snapshot.folders = [...snapshot.folders, { ...folder } as LibraryFolder];
      known.add(folder.path.toLowerCase());
      summary.foldersAdded += 1;
    }
  }

  // Collections reference comics by id, so they have to travel through the same
  // remap the comics did, or they would point at nothing after a move.
  const localCollections = new Map(snapshot.collections.map((collection) => [collection.id, collection]));
  for (const saved of incoming.snapshot.collections ?? []) {
    const remapped = saved.comicIds
      .map((id) => idRemap.get(id) ?? id)
      .filter((id) => byId.has(id));
    const existing = localCollections.get(saved.id);

    if (!existing) {
      const collection: Collection = { ...saved, comicIds: [...new Set(remapped)] };
      snapshot.collections = [...snapshot.collections, collection];
      localCollections.set(collection.id, collection);
      summary.collectionsAdded += 1;
      continue;
    }

    const before = existing.comicIds.length;
    existing.comicIds = [...new Set([...existing.comicIds, ...remapped])];
    if (existing.comicIds.length !== before) summary.collectionsMerged += 1;
  }

  // Per-series preferences are keyed by a hash of the series name, which does
  // not involve a path, so these carry over unchanged.
  for (const [seriesId, preferences] of Object.entries(incoming.snapshot.seriesPreferences ?? {})) {
    if (snapshot.seriesPreferences[seriesId]) continue;
    snapshot.seriesPreferences = { ...snapshot.seriesPreferences, [seriesId]: preferences };
    summary.seriesPreferencesAdded += 1;
  }

  // The reading log is keyed by calendar day and merged by taking the larger
  // count, not the sum: the same day is usually present on both sides, and
  // adding them would double every page on a second import of the same file.
  for (const [day, pages] of Object.entries(incoming.snapshot.activity ?? {})) {
    const current = snapshot.activity[day] ?? 0;
    if (pages <= current) continue;
    snapshot.activity = { ...snapshot.activity, [day]: pages };
    summary.activityDaysMerged += 1;
  }

  if (options.includeSettings && incoming.snapshot.settings) {
    snapshot.settings = { ...snapshot.settings, ...(incoming.snapshot.settings as LibrarySettings) };
    summary.settingsApplied = true;
  }

  snapshot.version = SCHEMA_VERSION;
  return { snapshot, summary };
}

/**
 * Merge one comic's history, taking whichever side is further along.
 *
 * An import is not a restore-over-the-top: the local copy may well have been
 * read more recently than the backup, and neither side is automatically right.
 * Every field resolves toward "more read", so importing can only move progress
 * forward and re-importing an old file is harmless.
 */
function applyReadingState(local: Comic, saved: Comic): boolean {
  const localState = local.state;
  const savedState = saved.state;
  let changed = false;

  if ((savedState?.furthestPage ?? 0) > (localState.furthestPage ?? 0)) {
    localState.furthestPage = savedState.furthestPage;
    localState.currentPage = savedState.currentPage;
    changed = true;
  }
  if (savedState?.completed && !localState.completed) {
    localState.completed = true;
    changed = true;
  }
  // Time is taken rather than summed: the same session is often represented on
  // both sides, and double-counting it would inflate the reading stats.
  if ((savedState?.timeSpentMs ?? 0) > (localState.timeSpentMs ?? 0)) {
    localState.timeSpentMs = savedState.timeSpentMs;
    changed = true;
  }
  if ((savedState?.lastReadAt ?? 0) > (localState.lastReadAt ?? 0)) {
    localState.lastReadAt = savedState.lastReadAt;
    changed = true;
  }

  if (saved.favorite && !local.favorite) {
    local.favorite = true;
    changed = true;
  }
  if ((saved.rating ?? 0) > (local.rating ?? 0)) {
    local.rating = saved.rating;
    changed = true;
  }

  const tags = new Set([...(local.tags ?? []), ...(saved.tags ?? [])]);
  if (tags.size !== (local.tags ?? []).length) {
    local.tags = [...tags];
    changed = true;
  }

  return changed;
}
