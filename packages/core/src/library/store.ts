import type {
  Collection,
  Comic,
  LibraryFilter,
  LibraryFolder,
  LibrarySort,
  ReadingStats,
  Series,
  SeriesPreferences,
} from '../types.ts';
import { groupIntoSeries } from './grouping.ts';
import { queryLibrary } from './query.ts';

/**
 * The in-memory library and its persistence format.
 *
 * State lives in plain arrays and is written out as one JSON document. For a
 * personal library -- thousands of files, not millions -- that is fast enough
 * to sort and filter on every keystroke, and it avoids a native database
 * dependency that would have to be built separately for Electron and Android.
 *
 * `LibraryPersistence` is the only part that touches a filesystem, so the same
 * `Library` runs on both platforms with a different adapter behind it. If the
 * library ever outgrows this, that interface is where SQLite would slot in.
 */

/** Bumped when the on-disk shape changes, so `migrate` knows what it's reading. */
export const SCHEMA_VERSION = 1;

export interface LibrarySettings {
  /** Applied to series that have no preference of their own. */
  defaultReadingMode: 'single' | 'double' | 'continuous';
  defaultFitMode: 'width' | 'height' | 'page' | 'original';
  theme: 'dark' | 'light' | 'system';
  /** Mark a book finished automatically when the last page is reached. */
  autoMarkCompleted: boolean;
  /** Re-scan watched folders when the app starts. */
  scanOnStartup: boolean;
  /** Port the wifi sync server listens on. */
  syncPort: number;
  syncEnabled: boolean;
}

export const DEFAULT_SETTINGS: LibrarySettings = {
  defaultReadingMode: 'single',
  defaultFitMode: 'height',
  theme: 'dark',
  autoMarkCompleted: true,
  scanOnStartup: true,
  syncPort: 8777,
  syncEnabled: false,
};

export interface LibrarySnapshot {
  version: number;
  comics: Comic[];
  collections: Collection[];
  folders: LibraryFolder[];
  /** Per-series overrides, keyed by series id. Series themselves are derived. */
  seriesPreferences: Record<string, SeriesPreferences>;
  settings: LibrarySettings;
}

export function emptySnapshot(): LibrarySnapshot {
  return {
    version: SCHEMA_VERSION,
    comics: [],
    collections: [],
    folders: [],
    seriesPreferences: {},
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** The storage backend. Implemented with `fs` on desktop, Preferences on Android. */
export interface LibraryPersistence {
  load(): Promise<LibrarySnapshot | undefined>;
  save(snapshot: LibrarySnapshot): Promise<void>;
}

/**
 * Bring an older snapshot up to the current schema. Unknown future versions are
 * refused rather than guessed at, so a downgrade can't silently drop fields.
 */
export function migrate(raw: LibrarySnapshot): LibrarySnapshot {
  if (raw.version > SCHEMA_VERSION) {
    throw new Error(
      `Library was written by a newer version of Longbox (schema ${raw.version}). Update the app.`,
    );
  }
  const base = emptySnapshot();
  return {
    ...base,
    ...raw,
    version: SCHEMA_VERSION,
    settings: { ...base.settings, ...raw.settings },
  };
}

export class Library {
  private snapshot: LibrarySnapshot;
  private persistence: LibraryPersistence;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private cachedSeries: Series[] | undefined;

  constructor(persistence: LibraryPersistence, snapshot = emptySnapshot()) {
    this.persistence = persistence;
    this.snapshot = snapshot;
  }

  static async open(persistence: LibraryPersistence): Promise<Library> {
    const loaded = await persistence.load();
    return new Library(persistence, loaded ? migrate(loaded) : emptySnapshot());
  }

  // --- Reads --------------------------------------------------------------

  get comics(): Comic[] {
    return this.snapshot.comics;
  }

  get settings(): LibrarySettings {
    return this.snapshot.settings;
  }

  get folders(): LibraryFolder[] {
    return this.snapshot.folders;
  }

  get collections(): Collection[] {
    return this.snapshot.collections;
  }

  /** Series are derived from comics and recomputed whenever comics change. */
  get series(): Series[] {
    if (!this.cachedSeries) {
      this.cachedSeries = groupIntoSeries(this.snapshot.comics).map((series) => ({
        ...series,
        preferences: this.snapshot.seriesPreferences[series.id],
      }));
    }
    return this.cachedSeries;
  }

  getComic(id: string): Comic | undefined {
    return this.snapshot.comics.find((comic) => comic.id === id);
  }

  comicsInSeries(seriesId: string): Comic[] {
    // Touch `series` first so every comic has a current seriesId stamped on it.
    void this.series;
    return this.snapshot.comics.filter((comic) => comic.seriesId === seriesId);
  }

  query(filter: LibraryFilter, sort: LibrarySort): Comic[] {
    void this.series;
    return queryLibrary(this.snapshot.comics, filter, sort);
  }

  // --- Writes -------------------------------------------------------------

  /**
   * Insert or update comics from a scan. Existing entries keep their reading
   * progress, rating, tags, and any hand-edited metadata -- a re-scan must
   * never undo the user's work.
   */
  upsertComics(incoming: Comic[]): { added: number; updated: number } {
    const byId = new Map(this.snapshot.comics.map((comic) => [comic.id, comic]));
    let added = 0;
    let updated = 0;

    for (const comic of incoming) {
      const existing = byId.get(comic.id);
      if (!existing) {
        byId.set(comic.id, comic);
        added += 1;
        continue;
      }

      // Preserve everything the user owns; refresh only what the file tells us.
      existing.path = comic.path;
      existing.filename = comic.filename;
      existing.format = comic.format;
      existing.size = comic.size;
      existing.modifiedAt = comic.modifiedAt;
      existing.pageCount = comic.pageCount;
      existing.coverHash = comic.coverHash ?? existing.coverHash;
      existing.missing = false;
      // Scanned metadata is the floor; anything already set wins.
      existing.metadata = { ...comic.metadata, ...existing.metadata };
      updated += 1;
    }

    this.snapshot.comics = [...byId.values()];
    this.invalidate();
    return { added, updated };
  }

  /** Flag comics whose files vanished, without deleting their reading history. */
  markMissing(ids: Iterable<string>): void {
    const missing = new Set(ids);
    for (const comic of this.snapshot.comics) {
      if (missing.has(comic.id)) comic.missing = true;
    }
    this.invalidate();
  }

  /** Permanently forget comics. Does not touch files on disk. */
  removeComics(ids: Iterable<string>): void {
    const drop = new Set(ids);
    this.snapshot.comics = this.snapshot.comics.filter((comic) => !drop.has(comic.id));
    for (const collection of this.snapshot.collections) {
      collection.comicIds = collection.comicIds.filter((id) => !drop.has(id));
    }
    this.invalidate();
  }

  updateComic(id: string, patch: Partial<Comic>): Comic | undefined {
    const comic = this.getComic(id);
    if (!comic) return undefined;
    Object.assign(comic, patch);
    this.invalidate();
    return comic;
  }

  /**
   * Record reading position. `furthestPage` only ever grows, so re-reading a
   * book from the start doesn't erase the fact that it was finished.
   */
  recordProgress(id: string, page: number, elapsedMs = 0): Comic | undefined {
    const comic = this.getComic(id);
    if (!comic) return undefined;

    comic.state.currentPage = page;
    comic.state.furthestPage = Math.max(comic.state.furthestPage, page);
    comic.state.lastReadAt = Date.now();
    comic.state.timeSpentMs += elapsedMs;

    if (this.snapshot.settings.autoMarkCompleted && page >= comic.pageCount - 1) {
      comic.state.completed = true;
    }

    this.invalidate();
    return comic;
  }

  setSeriesPreferences(seriesId: string, preferences: SeriesPreferences): void {
    this.snapshot.seriesPreferences[seriesId] = {
      ...this.snapshot.seriesPreferences[seriesId],
      ...preferences,
    };
    this.invalidate();
  }

  updateSettings(patch: Partial<LibrarySettings>): LibrarySettings {
    this.snapshot.settings = { ...this.snapshot.settings, ...patch };
    this.scheduleSave();
    return this.snapshot.settings;
  }

  addFolder(folder: LibraryFolder): void {
    if (this.snapshot.folders.some((existing) => existing.path === folder.path)) return;
    this.snapshot.folders.push(folder);
    this.scheduleSave();
  }

  removeFolder(id: string): void {
    this.snapshot.folders = this.snapshot.folders.filter((folder) => folder.id !== id);
    this.scheduleSave();
  }

  upsertCollection(collection: Collection): void {
    const index = this.snapshot.collections.findIndex((item) => item.id === collection.id);
    if (index === -1) this.snapshot.collections.push(collection);
    else this.snapshot.collections[index] = collection;
    this.scheduleSave();
  }

  removeCollection(id: string): void {
    this.snapshot.collections = this.snapshot.collections.filter((item) => item.id !== id);
    this.scheduleSave();
  }

  // --- Stats --------------------------------------------------------------

  stats(): ReadingStats {
    const comics = this.snapshot.comics;
    const pagesPerDay: Record<string, number> = {};
    const perSeries = new Map<string, number>();

    let pagesRead = 0;
    let timeSpentMs = 0;

    for (const comic of comics) {
      pagesRead += comic.state.furthestPage;
      timeSpentMs += comic.state.timeSpentMs;

      if (comic.state.lastReadAt) {
        const day = new Date(comic.state.lastReadAt).toISOString().slice(0, 10);
        pagesPerDay[day] = (pagesPerDay[day] ?? 0) + comic.state.furthestPage;
      }
      if (comic.seriesId) {
        perSeries.set(comic.seriesId, (perSeries.get(comic.seriesId) ?? 0) + comic.state.furthestPage);
      }
    }

    const seriesById = new Map(this.series.map((series) => [series.id, series]));
    const topSeries = [...perSeries.entries()]
      .map(([seriesId, pages]) => ({
        seriesId,
        name: seriesById.get(seriesId)?.name ?? 'Unknown',
        pagesRead: pages,
      }))
      .sort((a, b) => b.pagesRead - a.pagesRead)
      .slice(0, 10);

    return {
      totalComics: comics.length,
      totalPages: comics.reduce((sum, comic) => sum + comic.pageCount, 0),
      comicsCompleted: comics.filter((comic) => comic.state.completed).length,
      pagesRead,
      timeSpentMs,
      pagesPerDay,
      topSeries,
    };
  }

  // --- Persistence --------------------------------------------------------

  /** Drop derived caches and queue a write. */
  private invalidate(): void {
    this.cachedSeries = undefined;
    this.scheduleSave();
  }

  /**
   * Writes are debounced: page turns fire constantly while reading, and each
   * one dirties the library. Batching them keeps the disk quiet without
   * risking more than a second of progress.
   */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, 1000);
  }

  /** Write immediately. Call before quitting so nothing is lost. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.persistence.save(this.snapshot);
  }

  /** The raw snapshot, for backup/export. */
  toJSON(): LibrarySnapshot {
    return this.snapshot;
  }
}
