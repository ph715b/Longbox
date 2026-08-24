import { useCallback, useEffect, useRef, useState } from 'react';
import type { Comic, ScanProgress } from '@longbox/core';
import type { LibrarySnapshotView, ScanSummary } from './global.d.ts';

/**
 * Holds the library in renderer state and keeps it in step with the main
 * process.
 *
 * The main process is the single source of truth -- it owns the file on disk --
 * so the renderer never mutates its own copy directly. Every change goes over
 * IPC and the result is folded back in. That costs a round trip but removes any
 * chance of the UI showing something the saved library doesn't agree with.
 */

const EMPTY: LibrarySnapshotView = {
  comics: [],
  series: [],
  collections: [],
  folders: [],
  settings: {
    defaultReadingMode: 'single',
    defaultFitMode: 'height',
    theme: 'dark',
    autoMarkCompleted: true,
    scanOnStartup: true,
    syncPort: 8777,
    syncEnabled: false,
  },
};

export function useLibrary() {
  const [snapshot, setSnapshot] = useState<LibrarySnapshotView>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | undefined>();
  const [lastScan, setLastScan] = useState<ScanSummary | undefined>();

  const refresh = useCallback(async () => {
    setSnapshot(await window.longbox.getSnapshot());
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  // Progress events arrive continuously during a scan.
  useEffect(() => window.longbox.onScanProgress(setProgress), []);

  const scan = useCallback(async () => {
    setScanning(true);
    setLastScan(undefined);
    try {
      const summary = await window.longbox.scan();
      setLastScan(summary);
      await refresh();
      return summary;
    } finally {
      setScanning(false);
      setProgress(undefined);
    }
  }, [refresh]);

  const addFolder = useCallback(async () => {
    const path = await window.longbox.pickFolder();
    if (!path) return false;
    await window.longbox.addFolder(path);
    await refresh();
    return true;
  }, [refresh]);

  const removeFolder = useCallback(
    async (id: string) => {
      await window.longbox.removeFolder(id);
      await refresh();
    },
    [refresh],
  );

  /**
   * Apply a change to one comic optimistically, then reconcile.
   *
   * Toggling a favourite or a rating should feel instant; waiting for a disk
   * write to come back before the star fills in feels broken.
   */
  const updateComic = useCallback(
    async (id: string, patch: Partial<Comic>) => {
      setSnapshot((current) => ({
        ...current,
        comics: current.comics.map((comic) =>
          comic.id === id ? { ...comic, ...patch } : comic,
        ),
      }));
      await window.longbox.updateComic(id, patch);
      await refresh();
    },
    [refresh],
  );

  /**
   * Issues belonging to one series. The main process stamps `seriesId` onto
   * every comic when it derives the series list, so this is a plain filter.
   */
  const comicsOfSeries = useCallback(
    (seriesId: string) => snapshot.comics.filter((comic) => comic.seriesId === seriesId),
    [snapshot.comics],
  );

  return {
    ...snapshot,
    loading,
    scanning,
    progress,
    lastScan,
    refresh,
    scan,
    addFolder,
    removeFolder,
    updateComic,
    comicsOfSeries,
  };
}

/**
 * Reports reading position back to the main process.
 *
 * Page turns are frequent, so writes are throttled and the elapsed time between
 * turns is accumulated for the reading-stats feature. The final position is
 * flushed when the reader closes so nothing is lost.
 */
export function useProgressReporter(comicId: string | undefined) {
  const lastSent = useRef(0);
  const openedAt = useRef(Date.now());
  const pendingPage = useRef<number | undefined>(undefined);

  useEffect(() => {
    openedAt.current = Date.now();
    lastSent.current = 0;
    pendingPage.current = undefined;
  }, [comicId]);

  const report = useCallback(
    (page: number) => {
      if (!comicId) return;
      pendingPage.current = page;

      const now = Date.now();
      if (now - lastSent.current < 1500) return;

      const elapsed = now - openedAt.current;
      openedAt.current = now;
      lastSent.current = now;
      pendingPage.current = undefined;
      void window.longbox.recordProgress(comicId, page, elapsed);
    },
    [comicId],
  );

  /** Send whatever hasn't been written yet. Call when closing the reader. */
  const flush = useCallback(() => {
    if (!comicId || pendingPage.current === undefined) return;
    const elapsed = Date.now() - openedAt.current;
    void window.longbox.recordProgress(comicId, pendingPage.current, elapsed);
    pendingPage.current = undefined;
  }, [comicId]);

  return { report, flush };
}
