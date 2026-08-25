/**
 * Shared domain types for Longbox.
 * These are the contract between the desktop app, the Android app, and the
 * wifi sync protocol that connects them. Change carefully.
 */

/** Container formats we can open. */
export type ComicFormat = 'cbz' | 'cbr' | 'cb7' | 'cbt' | 'pdf';

/** How a series should be paged through. Remembered per-series. */
export type ReadingDirection = 'ltr' | 'rtl';

/** Page layout in the reader. */
export type ReadingMode =
  | 'single'      // one page at a time
  | 'double'      // two-page spreads, western
  | 'continuous'; // vertical scroll, webtoon/manga style

export type FitMode = 'width' | 'height' | 'page' | 'original';

/** A single page inside a comic archive. */
export interface Page {
  /** Zero-based index in reading order. */
  index: number;
  /** Path of the entry inside the archive, or `page-N` for PDFs. */
  entry: string;
  width?: number;
  height?: number;
  /** True when width > height — used to auto-detect spreads in double mode. */
  isWide?: boolean;
}

/**
 * Metadata for one issue. Fields are merged from three sources, in order of
 * increasing trust: filename guess -> embedded ComicInfo.xml -> user edits.
 */
export interface ComicMetadata {
  series?: string;
  /** Kept as a string: issues like "1.MU", "0", and "Annual 2" are real. */
  issue?: string;
  /** Numeric form of `issue` when parseable, for correct sorting. */
  issueNumber?: number;
  volume?: string;
  title?: string;
  year?: number;
  month?: number;
  publisher?: string;
  writer?: string;
  penciller?: string;
  coverArtist?: string;
  summary?: string;
  genre?: string[];
  characters?: string[];
  /** Total issues in the series, when the file declares it. */
  count?: number;
  /** Age rating string from ComicInfo.xml, e.g. "Teen". */
  ageRating?: string;
  /** Scanner/release-group junk pulled out of the filename, kept for reference. */
  scanTags?: string[];
  /** ComicInfo.xml can declare the whole book is right-to-left. */
  direction?: ReadingDirection;
}

/** Where the user is in a given book. */
export interface ReadingState {
  /** Last page they were on, zero-based. */
  currentPage: number;
  /** Highest page reached — progress shouldn't go backwards when re-reading. */
  furthestPage: number;
  /** Marked finished, either automatically at the last page or by hand. */
  completed: boolean;
  /** Epoch ms of the last time this book was opened. */
  lastReadAt?: number;
  /** Total ms spent with this book open, for reading stats. */
  timeSpentMs: number;
}

/** One comic file in the library. */
export interface Comic {
  /** Stable id: hash of the file's path + size. Survives metadata edits. */
  id: string;
  /** Absolute path on disk (desktop) or device-relative URI (Android). */
  path: string;
  /** Filename including extension. */
  filename: string;
  format: ComicFormat;
  /** Bytes. Part of the identity hash and used for duplicate detection. */
  size: number;
  /** File mtime, epoch ms. */
  modifiedAt: number;
  /** Epoch ms this file was first indexed. */
  addedAt: number;
  pageCount: number;
  metadata: ComicMetadata;
  state: ReadingState;
  /** Id of the series this was grouped into. */
  seriesId?: string;
  /** User-applied tags, separate from metadata genres. */
  tags: string[];
  /** 0-5, zero meaning unrated. */
  rating: number;
  favorite: boolean;
  /** Content hash of the first page, for duplicate detection across renames. */
  coverHash?: string;
  /** Set when the file went missing on the last scan, so we don't lose progress. */
  missing?: boolean;
}

/** A group of issues that belong together. Derived, not stored on disk. */
export interface Series {
  id: string;
  name: string;
  publisher?: string;
  /** Year of the earliest issue. */
  startYear?: number;
  /** Issues actually present on disk. */
  issueCount: number;
  /** How many issues are marked completed. */
  readCount: number;
  /** Issues indexed here whose files have since gone. */
  missingCount: number;
  /** Cover of the lowest-numbered issue that is still on disk. */
  coverComicId?: string;
  /** Per-series reader preferences, applied to every issue in it. */
  preferences?: SeriesPreferences;
  tags: string[];
  favorite: boolean;
}

export interface SeriesPreferences {
  readingMode?: ReadingMode;
  direction?: ReadingDirection;
  fitMode?: FitMode;
  /** Trim uniform borders off scanned pages. */
  autoCrop?: boolean;
  /** Treat the first page as a standalone cover in double-page mode. */
  coverIsSingle?: boolean;
}

/** A user-made collection, e.g. "Want to read" or "Batman 2024 reread". */
export interface Collection {
  id: string;
  name: string;
  /** Ordered comic ids. Order is meaningful — it's a reading queue. */
  comicIds: string[];
  /** When set, membership is computed from a filter instead of being manual. */
  smartFilter?: LibraryFilter;
  createdAt: number;
}

/** A folder Longbox watches for comics. */
export interface LibraryFolder {
  id: string;
  path: string;
  /** Recurse into subdirectories. */
  recursive: boolean;
  /** Epoch ms of the last completed scan. */
  lastScannedAt?: number;
  enabled: boolean;
}

export type SortField =
  | 'series' | 'issue' | 'title' | 'added' | 'modified'
  | 'lastRead' | 'year' | 'rating' | 'pageCount' | 'size';

export interface LibraryFilter {
  /** Free-text query, matched against series, title, writer, and filename. */
  search?: string;
  seriesIds?: string[];
  publishers?: string[];
  tags?: string[];
  /** Match comics having *all* of these tags rather than any. */
  tagsMatchAll?: boolean;
  formats?: ComicFormat[];
  /** 'unread' means zero pages read; 'inProgress' means started but not finished. */
  readStatus?: 'all' | 'unread' | 'inProgress' | 'completed';
  minRating?: number;
  favoritesOnly?: boolean;
  yearFrom?: number;
  yearTo?: number;
  includeMissing?: boolean;
}

export interface LibrarySort {
  field: SortField;
  direction: 'asc' | 'desc';
}

/** Progress reported while scanning folders, so the UI can show a bar. */
export interface ScanProgress {
  phase: 'discovering' | 'reading' | 'thumbnailing' | 'done';
  filesFound: number;
  filesProcessed: number;
  /** Filename currently being worked on. */
  current?: string;
  errors: { path: string; message: string }[];
}

/** Two or more files that appear to be the same book. */
export interface DuplicateGroup {
  /** Why these were matched. */
  reason: 'identical-size' | 'same-cover' | 'same-series-issue';
  comicIds: string[];
}

/** Aggregate reading stats for the stats screen. */
export interface ReadingStats {
  totalComics: number;
  totalPages: number;
  comicsCompleted: number;
  pagesRead: number;
  timeSpentMs: number;
  /** Epoch-day -> pages read that day, for the activity heatmap. */
  pagesPerDay: Record<string, number>;
  topSeries: { seriesId: string; name: string; pagesRead: number }[];
}
