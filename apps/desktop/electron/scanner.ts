import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  SUPPORTED_EXTENSIONS,
  comicId,
  formatFromExtension,
  mergeMetadata,
  openArchive,
  orderPages,
  parseComicInfo,
  parseFilename,
} from '@longbox/core';
import type { Comic, ComicFormat, ScanProgress } from '@longbox/core';

/**
 * Walking folders and turning files into library entries.
 *
 * The expensive part of a scan is reading page data off disk. A naive scan
 * loads every archive in full just to count its pages, which on a few hundred
 * comics means reading tens of gigabytes. For CBZ -- the common case -- we
 * avoid that entirely by reading only the zip central directory from the tail
 * of the file, which is a few kilobytes regardless of how big the comic is.
 * CBR has no equivalent trick and still needs a full read.
 */

const EXTENSIONS = new Set(SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`));

/** Folders that never contain a user's comics and cost time to walk. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information', '.longbox',
]);

export interface ScanOptions {
  recursive: boolean;
  /** Called after each file so the UI can show progress. */
  onProgress?: (progress: ScanProgress) => void;
  /** Checked between files so a scan can be cancelled from the UI. */
  isCancelled?: () => boolean;
}

/** Recursively list candidate comic files under a root. */
async function discover(root: string, recursive: boolean): Promise<string[]> {
  const found: string[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const dir = queue.pop()!;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, a disconnected drive): skip it
      // rather than aborting the whole scan.
      continue;
    }

    for (const item of items) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (recursive && !SKIP_DIRECTORIES.has(item.name) && !item.name.startsWith('.')) {
          queue.push(full);
        }
      } else if (item.isFile() && EXTENSIONS.has(extname(item.name).toLowerCase())) {
        found.push(full);
      }
    }
  }

  return found.sort();
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

/**
 * Read a zip's central directory without loading the whole file, by pulling
 * just the tail. Returns the entry names, or undefined if the directory isn't
 * within the tail we read (rare: it means a huge comment or many thousands of
 * entries), in which case the caller falls back to a full read.
 */
async function readZipEntriesFromTail(path: string, size: number): Promise<string[] | undefined> {
  // 64KB covers the maximum zip comment; 256KB more covers the directory
  // itself for any realistic page count.
  const tailLength = Math.min(size, 320 * 1024);
  const buffer = Buffer.alloc(tailLength);

  const handle = await open(path, 'r');
  try {
    await handle.read(buffer, 0, tailLength, size - tailLength);
  } finally {
    await handle.close();
  }

  const tailStart = size - tailLength;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Find the end-of-central-directory record, scanning backwards.
  let eocd = -1;
  for (let i = tailLength - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return undefined;

  const entryCount = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (directoryOffset === 0xffffffff || entryCount === 0xffff) return undefined; // zip64

  // The directory must lie inside the slice we read.
  let cursor = directoryOffset - tailStart;
  if (cursor < 0 || cursor >= tailLength) return undefined;

  const names: string[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > tailLength) return undefined;
    if (view.getUint32(cursor, true) !== SIG_CENTRAL) return undefined;

    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (!name.endsWith('/')) names.push(name.replace(/\\/g, '/'));

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

interface FileFacts {
  pageCount: number;
  /** Raw ComicInfo.xml bytes, when the archive carries one. */
  comicInfo?: Uint8Array;
  /** Set when the extension lied about the container format. */
  actualFormat?: ComicFormat;
}

/**
 * Learn what we need about one file: how many pages, and any embedded
 * metadata. Uses the cheap path when possible and falls back to a full read.
 */
async function inspect(path: string, size: number, format: ComicFormat): Promise<FileFacts> {
  if (format === 'cbz') {
    const names = await readZipEntriesFromTail(path, size);
    if (names) {
      const pages = orderPages(names);
      const infoEntry = names.find((name) => name.toLowerCase().endsWith('comicinfo.xml'));

      // Only pay for a full read when there is metadata worth extracting.
      if (!infoEntry) return { pageCount: pages.length };

      const data = new Uint8Array(await readFile(path));
      const { archive } = await openArchive(data, basename(path));
      const comicInfo = await archive.readEntry(infoEntry);
      archive.close();
      return { pageCount: pages.length, comicInfo };
    }
  }

  if (format === 'pdf') {
    // Page counting needs pdf.js, which is renderer-only. Leave it at zero and
    // let the reader fill it in when the file is first opened.
    return { pageCount: 0 };
  }

  const data = new Uint8Array(await readFile(path));
  const { archive, actualFormat } = await openArchive(data, basename(path));
  const infoEntry = archive.entries.find((entry) =>
    entry.name.toLowerCase().endsWith('comicinfo.xml'),
  );
  const comicInfo = infoEntry ? await archive.readEntry(infoEntry.name) : undefined;
  const pageCount = archive.pageEntries.length;
  archive.close();

  return { pageCount, comicInfo, actualFormat };
}

/** Build a library entry for one file. Throws if the file can't be read. */
export async function scanFile(path: string): Promise<Comic> {
  const info = await stat(path);
  const filename = basename(path);
  const claimed = formatFromExtension(filename) ?? 'cbz';

  const facts = await inspect(path, info.size, claimed);

  const fromFilename = parseFilename(filename);
  const fromArchive = facts.comicInfo ? parseComicInfo(facts.comicInfo) : undefined;

  return {
    id: comicId(path, info.size),
    path,
    filename,
    // Trust the bytes over the extension when they disagree.
    format: facts.actualFormat ?? claimed,
    size: info.size,
    modifiedAt: info.mtimeMs,
    addedAt: Date.now(),
    pageCount: facts.pageCount,
    metadata: mergeMetadata(fromFilename, fromArchive),
    state: { currentPage: 0, furthestPage: 0, completed: false, timeSpentMs: 0 },
    tags: [],
    rating: 0,
    favorite: false,
  };
}

export interface ScanResult {
  comics: Comic[];
  /** Paths that were found but could not be read. */
  errors: { path: string; message: string }[];
  /** True when the user cancelled partway. */
  cancelled: boolean;
}

/** Scan one or more roots and return everything readable found under them. */
export async function scanFolders(roots: string[], options: ScanOptions): Promise<ScanResult> {
  const progress: ScanProgress = {
    phase: 'discovering',
    filesFound: 0,
    filesProcessed: 0,
    errors: [],
  };
  options.onProgress?.(progress);

  const paths: string[] = [];
  for (const root of roots) {
    paths.push(...(await discover(root, options.recursive)));
  }

  // The same file can sit under two overlapping watched folders.
  const unique = [...new Set(paths)];

  progress.phase = 'reading';
  progress.filesFound = unique.length;
  options.onProgress?.({ ...progress });

  const comics: Comic[] = [];
  let cancelled = false;

  for (const path of unique) {
    if (options.isCancelled?.()) {
      cancelled = true;
      break;
    }

    progress.current = basename(path);
    try {
      comics.push(await scanFile(path));
    } catch (error) {
      progress.errors.push({
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    progress.filesProcessed += 1;
    // Reporting every file would flood the IPC channel on a large library.
    if (progress.filesProcessed % 5 === 0 || progress.filesProcessed === unique.length) {
      options.onProgress?.({ ...progress });
    }
  }

  progress.phase = 'done';
  progress.current = undefined;
  options.onProgress?.({ ...progress });

  return { comics, errors: progress.errors, cancelled };
}
