import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * The only channel between the renderer and the rest of the machine.
 *
 * The renderer runs with contextIsolation on and no Node access, so it can
 * reach exactly the operations listed here and nothing else. Each one is a
 * named, typed call rather than a general "run this" escape hatch, which keeps
 * a compromised page from touching arbitrary files.
 */

const api = {
  // --- Library ------------------------------------------------------------
  getSnapshot: () => ipcRenderer.invoke('library:snapshot'),
  getStats: () => ipcRenderer.invoke('library:stats'),

  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  pickComics: () => ipcRenderer.invoke('comics:pick'),
  addFolder: (path: string, recursive = true) =>
    ipcRenderer.invoke('library:addFolder', path, recursive),
  removeFolder: (id: string) => ipcRenderer.invoke('library:removeFolder', id),

  scan: () => ipcRenderer.invoke('library:scan'),
  planDrop: (paths: string[]) => ipcRenderer.invoke('library:planDrop', paths),
  fileDrop: (instructions: unknown) => ipcRenderer.invoke('library:fileDrop', instructions),

  /**
   * The real path behind a dropped File.
   *
   * Electron 32 removed the non-standard File.path property; this is the
   * supported replacement, and it has to live here because webUtils is a main
   * -world API the renderer cannot reach on its own.
   */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  cancelScan: () => ipcRenderer.invoke('library:cancelScan'),

  /** Subscribe to scan progress. Returns an unsubscribe function. */
  onScanProgress: (handler: (progress: unknown) => void) => {
    const listener = (_event: unknown, progress: unknown) => handler(progress);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.removeListener('scan:progress', listener);
  },

  // --- Comics -------------------------------------------------------------
  recordProgress: (id: string, page: number, elapsedMs = 0) =>
    ipcRenderer.invoke('comic:progress', id, page, elapsedMs),
  updateComic: (id: string, patch: unknown) => ipcRenderer.invoke('comic:update', id, patch),
  removeComics: (ids: string[]) => ipcRenderer.invoke('comic:remove', ids),
  getPageCount: (id: string) => ipcRenderer.invoke('comic:pageCount', id),
  revealInFolder: (id: string) => ipcRenderer.invoke('comic:reveal', id),

  // --- Series and settings ------------------------------------------------
  setSeriesPreferences: (seriesId: string, preferences: unknown) =>
    ipcRenderer.invoke('series:preferences', seriesId, preferences),
  updateSettings: (patch: unknown) => ipcRenderer.invoke('settings:update', patch),

  // --- Collections --------------------------------------------------------
  saveCollection: (collection: unknown) => ipcRenderer.invoke('collection:save', collection),
  removeCollection: (id: string) => ipcRenderer.invoke('collection:remove', id),
  setCollectionMembers: (id: string, comicIds: string[], member: boolean) =>
    ipcRenderer.invoke('collection:setMembers', id, comicIds, member),
  reorderCollection: (id: string, comicId: string, toIndex: number) =>
    ipcRenderer.invoke('collection:reorder', id, comicId, toIndex),

  // --- Duplicates ---------------------------------------------------------
  findDuplicates: () => ipcRenderer.invoke('library:duplicates'),
  hashCovers: () => ipcRenderer.invoke('library:hashCovers'),

  // --- Backup -------------------------------------------------------------
  exportLibrary: () => ipcRenderer.invoke('library:export'),
  importLibrary: (options?: unknown) => ipcRenderer.invoke('library:import', options),

  // --- Thumbnails ---------------------------------------------------------
  saveThumbnail: (id: string, data: Uint8Array) =>
    ipcRenderer.invoke('thumb:save', id, data),

  // --- URLs ---------------------------------------------------------------
  // Built here so the renderer never has to know the protocol's shape.
  pageUrl: (comicId: string, pageIndex: number) => `longbox://page/${comicId}/${pageIndex}`,
  coverUrl: (comicId: string) => `longbox://cover/${comicId}`,
};

contextBridge.exposeInMainWorld('longbox', api);

export type LongboxApi = typeof api;
