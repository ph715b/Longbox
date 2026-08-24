/**
 * @longbox/core -- everything the desktop and Android apps share.
 *
 * Nothing in this package may touch a filesystem, a network, or a DOM. Anything
 * platform-specific is injected (see `LibraryPersistence`) so that both apps
 * run the identical parsing, grouping, and query code and can't drift apart.
 */

export * from './types.ts';

export {
  openArchive,
  sniffFormat,
  formatFromExtension,
  SUPPORTED_EXTENSIONS,
  ArchiveError,
  ZipArchive,
  RarArchive,
  TarArchive,
  isImageEntry,
  isMetadataEntry,
  orderPages,
  naturalCompare,
  extensionOf,
  METADATA_ENTRIES,
} from './archive/index.ts';
export type { ArchiveEntry, ComicArchive, OpenResult } from './archive/index.ts';

export {
  parseFilename,
  mergeMetadata,
  formatIssue,
  formatComicTitle,
  issueToNumber,
  stripExtension,
} from './metadata/filename.ts';

export { parseComicInfo, buildComicInfo } from './metadata/comicinfo.ts';

export {
  groupIntoSeries,
  compareIssues,
  nextUnread,
  missingIssues,
  UNGROUPED_SERIES_ID,
} from './library/grouping.ts';

export {
  queryLibrary,
  matchesFilter,
  sortComics,
  computeFacets,
} from './library/query.ts';
export type { Facets } from './library/query.ts';

export {
  Library,
  SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  emptySnapshot,
  migrate,
} from './library/store.ts';
export type {
  LibraryPersistence,
  LibrarySnapshot,
  LibrarySettings,
} from './library/store.ts';

export { hash64, comicId, seriesId, normaliseSeriesName } from './util/id.ts';
