import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  Library,
  buildExport,
  coverHash,
  formatFromExtension,
  SUPPORTED_EXTENSIONS,
  duplicateWaste,
  findDuplicates,
  hash64,
  mergeImport,
  parseExport,
} from '@longbox/core';
import type {
  Collection,
  Comic,
  ImportOptions,
  LibraryPersistence,
  LibrarySnapshot,
} from '@longbox/core';
import { getArchive, closeAll, invalidate } from './archiveCache.ts';
import { scanFile, scanFolders } from './scanner.ts';
import { fileComics, listDestinations, listParents, planFiling } from './filing.ts';
import type { FilingInstruction } from './filing.ts';

/**
 * Electron main process: owns the filesystem, the library, and the window.
 *
 * Page images are served over a custom `longbox://` protocol rather than being
 * pushed through IPC. That lets the renderer use a plain <img src>, so Chromium
 * handles decoding, caching, and memory for us -- and a 2MB page never has to
 * be serialised across the process boundary.
 */

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | undefined;
let library: Library;
let scanCancelled = false;

// --- Paths ----------------------------------------------------------------

const userData = () => app.getPath('userData');
const libraryFile = () => join(userData(), 'library.json');
const thumbnailDir = () => join(userData(), 'thumbnails');

// --- Persistence ----------------------------------------------------------

/**
 * Writes go to a temporary file first and are then renamed over the real one.
 * A crash mid-write would otherwise leave a truncated JSON file and lose the
 * entire library, including reading progress that isn't recoverable by
 * re-scanning.
 */
const persistence: LibraryPersistence = {
  async load() {
    try {
      const text = await readFile(libraryFile(), 'utf8');
      return JSON.parse(text) as LibrarySnapshot;
    } catch {
      return undefined;
    }
  },

  async save(snapshot) {
    await mkdir(userData(), { recursive: true });
    const target = libraryFile();
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(snapshot), 'utf8');
    await rename(temp, target);
  },
};

// --- Custom protocol ------------------------------------------------------

// Must run before `app.ready`. Marking the scheme standard and secure lets the
// renderer load these URLs from a normal page without tripping mixed-content
// or CORS rules.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'longbox',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

function mimeFor(entryName: string): string {
  const ext = entryName.slice(entryName.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** Serve one page of a comic as an image response. */
async function servePage(comic: Comic, pageIndex: number): Promise<Response> {
  const archive = await getArchive(comic.path);
  if (pageIndex < 0 || pageIndex >= archive.pageEntries.length) {
    return new Response('Page out of range', { status: 404 });
  }

  const bytes = await archive.readPage(pageIndex);
  const entry = archive.pageEntries[pageIndex];

  // Copy into a fresh buffer: the archive may hand back a view into its own
  // storage, which can be freed when the archive is evicted from the cache.
  const body = new Uint8Array(bytes);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': mimeFor(entry),
      'Content-Length': String(body.byteLength),
      // Pages never change for a given comic, so let Chromium keep them.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

function registerProtocol(): void {
  protocol.handle('longbox', async (request) => {
    try {
      const url = new URL(request.url);
      // `longbox://page/<comicId>/<index>` parses as host="page".
      const kind = url.hostname;
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

      if (kind === 'page') {
        const [comicIdentifier, indexText] = segments;
        const comic = library.getComic(comicIdentifier);
        if (!comic) return new Response('Unknown comic', { status: 404 });
        return await servePage(comic, Number.parseInt(indexText, 10) || 0);
      }

      if (kind === 'cover') {
        const [comicIdentifier] = segments;
        const comic = library.getComic(comicIdentifier);
        if (!comic) return new Response('Unknown comic', { status: 404 });

        // Prefer a cached thumbnail; fall back to the full first page, which
        // the renderer will downscale and then post back for caching.
        const cached = join(thumbnailDir(), `${comic.id}.jpg`);
        if (existsSync(cached)) {
          const data = await readFile(cached);
          return new Response(new Uint8Array(data), {
            status: 200,
            headers: {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'public, max-age=86400',
            },
          });
        }
        return await servePage(comic, 0);
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(message, { status: 500 });
    }
  });
}

// --- Window ---------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#12131a',
    show: false,
    autoHideMenuBar: true,
    title: 'Longbox',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Avoid the white flash before React has painted anything.
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // A file dropped outside a drop zone would otherwise be loaded as the
  // window's document, replacing the app with the raw archive. The renderer
  // cancels these too; this is the backstop for anything it misses.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });

  // Send external links to the real browser instead of opening app windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (isDev && devServer) {
    void mainWindow.loadURL(devServer);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

// --- IPC ------------------------------------------------------------------

function registerIpc(): void {
  // The renderer holds no state of its own; it reads this and re-renders.
  ipcMain.handle('library:snapshot', () => ({
    comics: library.comics,
    series: library.series,
    collections: library.collections,
    folders: library.folders,
    settings: library.settings,
  }));

  ipcMain.handle('library:stats', () => library.stats());

  /**
   * Choose comics with a picker rather than a drag.
   *
   * Returns paths only. Everything after this is the same code a drop runs
   * through, so the two ways in cannot drift apart in how they file things.
   */
  ipcMain.handle('comics:pick', async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add comics',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Comics', extensions: [...SUPPORTED_EXTENSIONS] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('folder:pick', async () => {
    if (!mainWindow) return undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder containing comics',
      properties: ['openDirectory'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('library:addFolder', (_event, path: string, recursive = true) => {
    library.addFolder({ id: hash64(path), path, recursive, enabled: true });
    return library.folders;
  });

  ipcMain.handle('library:removeFolder', (_event, id: string) => {
    library.removeFolder(id);
    return library.folders;
  });

  ipcMain.handle('library:scan', async () => {
    scanCancelled = false;
    const roots = library.folders.filter((folder) => folder.enabled).map((folder) => folder.path);
    if (roots.length === 0) return { added: 0, updated: 0, errors: [], cancelled: false };

    const result = await scanFolders(roots, {
      recursive: true,
      isCancelled: () => scanCancelled,
      onProgress: (progress) => mainWindow?.webContents.send('scan:progress', progress),
    });

    const { added, updated } = library.upsertComics(result.comics);

    // Anything previously indexed under a scanned root that didn't turn up
    // this time is gone. Flag it rather than deleting, so a disconnected drive
    // doesn't wipe reading progress.
    if (!result.cancelled) {
      const seen = new Set(result.comics.map((comic) => comic.id));
      const vanished = library.comics
        .filter((comic) => !seen.has(comic.id) && roots.some((root) => comic.path.startsWith(root)))
        .map((comic) => comic.id);

      // A comic filed nowhere in particular -- left where it was dropped --
      // sits under no watched root, so the sweep above cannot see it. Checking
      // those directly is what stops one deleted from a Downloads folder
      // lingering as an unexplained tile that nothing ever flags.
      const loose = library.comics.filter(
        (comic) => !comic.missing && !roots.some((root) => comic.path.startsWith(root)),
      );
      for (const comic of loose) {
        try {
          await stat(comic.path);
        } catch {
          vanished.push(comic.id);
        }
      }

      library.markMissing(vanished);
    }

    await library.flush();
    return { added, updated, errors: result.errors, cancelled: result.cancelled };
  });

  /**
   * Take paths dropped onto the window.
   *
   * A folder becomes a watched folder and is scanned, which is what dropping a
   * folder plainly means. Loose files are indexed exactly where they lie rather
   * than quietly adopting their parent directory, which could be a hundred
   * unrelated comics the user never asked for. Those files stay put across
   * later scans: the missing check only considers comics beneath a watched
   * root, so an indexed loose file is never mistaken for one that vanished.
   */
  /**
   * First half of a drop: sort out what landed, and work out where the comics
   * among it probably belong.
   *
   * A dropped folder is adopted straight away -- that is plainly what dropping
   * a folder means, and there is no judgement call in it. Loose files are only
   * planned, never moved, because deciding which folder a comic belongs in is
   * the one part of this a filename cannot be trusted with.
   */
  ipcMain.handle('library:planDrop', async (_event, paths: string[]) => {
    scanCancelled = false;

    const files: string[] = [];
    const folders: string[] = [];
    let skipped = 0;

    for (const path of paths) {
      try {
        const info = await stat(path);
        if (info.isDirectory()) folders.push(path);
        else if (formatFromExtension(basename(path))) files.push(path);
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }

    let foldersAdded = 0;
    for (const folder of folders) {
      const id = hash64(folder);
      if (library.folders.some((existing) => existing.id === id)) continue;
      library.addFolder({ id, path: folder, recursive: true, enabled: true });
      foldersAdded += 1;
    }

    let added = 0;
    let updated = 0;
    const errors: { path: string; message: string }[] = [];

    if (folders.length > 0) {
      const result = await scanFolders(folders, {
        recursive: true,
        isCancelled: () => scanCancelled,
        onProgress: (progress) => mainWindow?.webContents.send('scan:progress', progress),
      });
      const counts = library.upsertComics(result.comics);
      added = counts.added;
      updated = counts.updated;
      errors.push(...result.errors);
      await library.flush();
    }

    const roots = library.folders.filter((folder) => folder.enabled).map((folder) => folder.path);
    const destinations = await listDestinations(roots);

    return {
      candidates: await planFiling(files, destinations),
      destinations,
      parents: listParents(roots),
      foldersAdded,
      added,
      updated,
      skipped,
      errors,
    };
  });

  /**
   * Second half: carry out a plan the user has confirmed, then index whatever
   * ended up where.
   */
  ipcMain.handle('library:fileDrop', async (_event, instructions: FilingInstruction[]) => {
    const outcomes = await fileComics(instructions);
    const found: Comic[] = [];
    const errors: { path: string; message: string }[] = [];

    for (const outcome of outcomes) {
      if (!outcome.path || outcome.status === 'skipped' || outcome.status === 'failed') continue;
      try {
        found.push(await scanFile(outcome.path));
      } catch (error) {
        errors.push({
          path: outcome.path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // A comic filed somewhere no watched root covers would be indexed once and
    // then never seen again. Adopting the folder keeps it in the library.
    const roots = library.folders.filter((folder) => folder.enabled).map((folder) => folder.path);
    const adopted: string[] = [];

    for (const outcome of outcomes) {
      if (outcome.status !== 'moved' || !outcome.path) continue;
      const dir = dirname(outcome.path);
      if (roots.some((root) => dir.toLowerCase().startsWith(root.toLowerCase()))) continue;
      const id = hash64(dir);
      if (library.folders.some((folder) => folder.id === id)) continue;
      library.addFolder({ id, path: dir, recursive: true, enabled: true });
      roots.push(dir);
      adopted.push(dir);
    }

    const { added, updated } = library.upsertComics(found);
    await library.flush();

    return { outcomes, added, updated, errors, adopted };
  });

  ipcMain.handle('library:cancelScan', () => {
    scanCancelled = true;
  });

  ipcMain.handle('comic:progress', (_event, id: string, page: number, elapsedMs: number) =>
    library.recordProgress(id, page, elapsedMs),
  );

  ipcMain.handle('comic:update', (_event, id: string, patch: Partial<Comic>) =>
    library.updateComic(id, patch),
  );

  ipcMain.handle('comic:remove', (_event, ids: string[]) => {
    for (const id of ids) {
      const comic = library.getComic(id);
      if (comic) invalidate(comic.path);
    }
    library.removeComics(ids);
  });

  /** Page count for formats the scanner couldn't count without opening. */
  ipcMain.handle('comic:pageCount', async (_event, id: string) => {
    const comic = library.getComic(id);
    if (!comic) return 0;
    const archive = await getArchive(comic.path);
    const count = archive.pageEntries.length;
    if (count !== comic.pageCount) library.updateComic(id, { pageCount: count });
    return count;
  });

  ipcMain.handle('comic:reveal', (_event, id: string) => {
    const comic = library.getComic(id);
    if (comic) shell.showItemInFolder(comic.path);
  });

  ipcMain.handle('series:preferences', (_event, seriesIdentifier: string, preferences) => {
    library.setSeriesPreferences(seriesIdentifier, preferences);
    return library.series;
  });

  ipcMain.handle('settings:update', (_event, patch) => library.updateSettings(patch));

  // --- Collections --------------------------------------------------------

  ipcMain.handle('collection:save', (_event, collection: Collection) => {
    library.upsertCollection(collection);
    return library.collections;
  });

  ipcMain.handle('collection:remove', (_event, id: string) => {
    library.removeCollection(id);
    return library.collections;
  });

  /**
   * Add or remove comics in one call rather than replacing the whole id list,
   * so two windows editing the same collection cannot clobber each other's
   * changes with a stale copy.
   */
  ipcMain.handle(
    'collection:setMembers',
    (_event, id: string, comicIds: string[], member: boolean) => {
      const collection = library.collections.find((entry) => entry.id === id);
      if (!collection) return library.collections;

      const wanted = new Set(comicIds);
      const next = member
        ? [...collection.comicIds, ...comicIds.filter((cid) => !collection.comicIds.includes(cid))]
        : collection.comicIds.filter((cid) => !wanted.has(cid));

      library.upsertCollection({ ...collection, comicIds: next });
      return library.collections;
    },
  );

  /**
   * Move one comic within a collection.
   *
   * Expressed as a move rather than a whole new list so two windows reordering
   * at once cannot overwrite each other with a stale copy of the order.
   */
  ipcMain.handle(
    'collection:reorder',
    (_event, id: string, comicId: string, toIndex: number) => {
      const collection = library.collections.find((entry) => entry.id === id);
      if (!collection) return library.collections;

      const without = collection.comicIds.filter((existing) => existing !== comicId);
      const target = Math.max(0, Math.min(toIndex, without.length));
      without.splice(target, 0, comicId);

      library.upsertCollection({ ...collection, comicIds: without });
      return library.collections;
    },
  );

  // --- Duplicates ---------------------------------------------------------

  ipcMain.handle('library:duplicates', () => {
    const groups = findDuplicates(library.comics);
    return { groups, wastedBytes: duplicateWaste(groups, library.comics) };
  });

  /**
   * Fingerprint first pages so duplicates can be matched on cover rather than
   * on size or filename.
   *
   * This is deliberately not part of a scan. It opens and decodes the first
   * page of every archive, which is far more work than indexing needs, so it
   * stays an explicit action with a progress report behind it.
   */
  ipcMain.handle('library:hashCovers', async () => {
    scanCancelled = false;
    const pending = library.comics.filter((comic) => !comic.coverHash && !comic.missing);
    let done = 0;
    let failed = 0;

    for (const comic of pending) {
      if (scanCancelled) break;
      try {
        const archive = await getArchive(comic.path);
        if (archive.pageEntries.length > 0) {
          library.updateComic(comic.id, { coverHash: coverHash(await archive.readPage(0)) });
        }
        done += 1;
      } catch {
        // A file that will not open is a problem for the reader to report, not
        // something that should abort fingerprinting the rest of the library.
        failed += 1;
      }

      mainWindow?.webContents.send('scan:progress', {
        phase: 'thumbnailing',
        filesFound: pending.length,
        filesProcessed: done + failed,
        current: comic.filename,
        errors: [],
      });
    }

    await library.flush();
    return { hashed: done, failed, cancelled: scanCancelled };
  });

  // --- Backup -------------------------------------------------------------

  /**
   * Write the library to a file the user chooses.
   *
   * Pretty-printed rather than minified: an export is something people keep,
   * move between machines, and occasionally need to look inside when something
   * has gone wrong. The extra bytes are worth being able to read it.
   */
  ipcMain.handle('library:export', async () => {
    if (!mainWindow) return { ok: false as const, cancelled: true as const };

    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export library',
      defaultPath: join(app.getPath('documents'), `longbox-library-${stamp}.json`),
      filters: [{ name: 'Longbox library', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false as const, cancelled: true as const };

    const payload = buildExport(library.toJSON(), app.getVersion());
    await writeFile(result.filePath, JSON.stringify(payload, undefined, 2), 'utf8');
    return {
      ok: true as const,
      cancelled: false as const,
      path: result.filePath,
      comics: payload.snapshot.comics.length,
    };
  });

  /**
   * Merge an export into the current library.
   *
   * The library is flushed to disk before anything changes, so the file on disk
   * is a known-good state if the merge turns out to be unwanted.
   */
  ipcMain.handle('library:import', async (_event, options: ImportOptions = {}) => {
    if (!mainWindow) return { ok: false as const, cancelled: true as const };

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import library',
      properties: ['openFile'],
      filters: [{ name: 'Longbox library', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false as const, cancelled: true as const };
    }

    try {
      const text = await readFile(result.filePaths[0], 'utf8');
      const incoming = parseExport(text);
      await library.flush();

      const { snapshot, summary } = mergeImport(library.toJSON(), incoming, options);
      library.replaceSnapshot(snapshot);
      await library.flush();

      return { ok: true as const, cancelled: false as const, summary };
    } catch (error) {
      return {
        ok: false as const,
        cancelled: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  /**
   * The renderer downscales a cover with canvas and sends the JPEG back, since
   * the main process has no image decoder without a native dependency.
   */
  ipcMain.handle('thumb:save', async (_event, id: string, data: Uint8Array) => {
    await mkdir(thumbnailDir(), { recursive: true });
    await writeFile(join(thumbnailDir(), `${id}.jpg`), Buffer.from(data));
  });
}

// --- Lifecycle ------------------------------------------------------------

// A second instance would fight the first over library.json; hand off instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    library = await Library.open(persistence);
    registerProtocol();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Never lose the last few seconds of reading progress on quit.
app.on('before-quit', async (event) => {
  if (!library) return;
  event.preventDefault();
  closeAll();
  await library.flush();
  app.exit(0);
});
