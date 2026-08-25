import type {
  Collection,
  Comic,
  DuplicateGroup,
  ImportOptions,
  ImportSummary,
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

export type ExportResult =
  | { ok: true; cancelled: false; path: string; comics: number }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

export type ImportResult =
  | { ok: true; cancelled: false; summary: ImportSummary }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

export interface DuplicateReport {
  groups: DuplicateGroup[];
  /** Bytes that would be freed by keeping only the first of each group. */
  wastedBytes: number;
}

export interface CoverHashResult {
  hashed: number;
  failed: number;
  cancelled: boolean;
}

export interface Destination {
  path: string;
  label: string;
  root: string;
}

export interface FilingCandidate {
  source: string;
  filename: string;
  series?: string;
  issue?: string;
  suggestedPath?: string;
  conflict: boolean;
}

export interface DropPlan {
  candidates: FilingCandidate[];
  destinations: Destination[];
  foldersAdded: number;
  added: number;
  updated: number;
  /** Dropped items that were neither a folder nor a comic we can open. */
  skipped: number;
  errors: { path: string; message: string }[];
}

export interface FilingInstruction {
  source: string;
  /** Absent means leave the file where it is. */
  targetDir?: string;
  onConflict?: 'skip' | 'keepBoth' | 'replace';
}

export interface FilingOutcome {
  source: string;
  path?: string;
  status: 'moved' | 'left' | 'skipped' | 'failed';
  message?: string;
}

export interface FilingResult {
  outcomes: FilingOutcome[];
  added: number;
  updated: number;
  errors: { path: string; message: string }[];
}

export interface LongboxApi {
  getSnapshot(): Promise<LibrarySnapshotView>;
  getStats(): Promise<ReadingStats>;

  pickFolder(): Promise<string | undefined>;
  pickComics(): Promise<string[]>;
  addFolder(path: string, recursive?: boolean): Promise<LibraryFolder[]>;
  removeFolder(id: string): Promise<LibraryFolder[]>;

  scan(): Promise<ScanSummary>;
  planDrop(paths: string[]): Promise<DropPlan>;
  fileDrop(instructions: FilingInstruction[]): Promise<FilingResult>;
  pathForFile(file: File): string;
  cancelScan(): Promise<void>;
  onScanProgress(handler: (progress: ScanProgress) => void): () => void;

  recordProgress(id: string, page: number, elapsedMs?: number): Promise<Comic | undefined>;
  updateComic(id: string, patch: Partial<Comic>): Promise<Comic | undefined>;
  removeComics(ids: string[]): Promise<void>;
  getPageCount(id: string): Promise<number>;
  revealInFolder(id: string): Promise<void>;

  setSeriesPreferences(seriesId: string, preferences: SeriesPreferences): Promise<Series[]>;
  updateSettings(patch: Partial<LibrarySettings>): Promise<LibrarySettings>;

  saveCollection(collection: Collection): Promise<Collection[]>;
  removeCollection(id: string): Promise<Collection[]>;
  setCollectionMembers(id: string, comicIds: string[], member: boolean): Promise<Collection[]>;
  reorderCollection(id: string, comicId: string, toIndex: number): Promise<Collection[]>;

  findDuplicates(): Promise<DuplicateReport>;
  hashCovers(): Promise<CoverHashResult>;

  exportLibrary(): Promise<ExportResult>;
  importLibrary(options?: ImportOptions): Promise<ImportResult>;

  saveThumbnail(id: string, data: Uint8Array): Promise<void>;

  pageUrl(comicId: string, pageIndex: number): string;
  coverUrl(comicId: string): string;
}

declare global {
  interface Window {
    longbox: LongboxApi;
  }
}
