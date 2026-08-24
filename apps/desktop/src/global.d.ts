import type {
  Collection,
  Comic,
  LibraryFolder,
  LibrarySettings,
  ReadingStats,
  ScanProgress,
  Series,
  SeriesPreferences,
} from '@longbox/core';

/**
 * The shape of `window.longbox`, mirroring what the preload script exposes.
 * Kept here rather than imported from the preload module so the renderer never
 * pulls Electron types into its bundle.
 */
export interface LibrarySnapshotView {
  comics: Comic[];
  series: Series[];
  collections: Collection[];
  folders: LibraryFolder[];
  settings: LibrarySettings;
}

export interface ScanSummary {
  added: number;
  updated: number;
  errors: { path: string; message: string }[];
  cancelled: boolean;
}

export interface LongboxApi {
  getSnapshot(): Promise<LibrarySnapshotView>;
  getStats(): Promise<ReadingStats>;

  pickFolder(): Promise<string | undefined>;
  addFolder(path: string, recursive?: boolean): Promise<LibraryFolder[]>;
  removeFolder(id: string): Promise<LibraryFolder[]>;

  scan(): Promise<ScanSummary>;
  cancelScan(): Promise<void>;
  onScanProgress(handler: (progress: ScanProgress) => void): () => void;

  recordProgress(id: string, page: number, elapsedMs?: number): Promise<Comic | undefined>;
  updateComic(id: string, patch: Partial<Comic>): Promise<Comic | undefined>;
  removeComics(ids: string[]): Promise<void>;
  getPageCount(id: string): Promise<number>;
  revealInFolder(id: string): Promise<void>;

  setSeriesPreferences(seriesId: string, preferences: SeriesPreferences): Promise<Series[]>;
  updateSettings(patch: Partial<LibrarySettings>): Promise<LibrarySettings>;

  saveThumbnail(id: string, data: Uint8Array): Promise<void>;

  pageUrl(comicId: string, pageIndex: number): string;
  coverUrl(comicId: string): string;
}

declare global {
  interface Window {
    longbox: LongboxApi;
  }
}
