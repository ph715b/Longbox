import { useCallback, useEffect, useRef, useState } from 'react';
import type { AddPathsResult } from './global.d.ts';

/**
 * Accepting comics dropped from Explorer.
 *
 * Two things have to be true for this to work at all. The window must refuse to
 * navigate to a dropped file, or Chromium replaces the whole app with the raw
 * archive; and the real path has to come from `webUtils` in the preload, since
 * Electron 32 removed the non-standard `File.path`.
 */

/** MIME type dragged between views inside the app, distinct from file drops. */
export const COMIC_MIME = 'application/x-longbox-comic';

function carriesFiles(transfer: DataTransfer | null): boolean {
  // A drag from inside the app carries our own type and must not light up the
  // whole-window drop zone; only genuine files from the OS should.
  return !!transfer && Array.from(transfer.types).includes('Files');
}

export function useFileDrop(onAdded: () => void) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddPathsResult>();

  // Drag events fire for every child element entered, so a plain leave handler
  // would flicker. Counting enters and leaves is the reliable way to know when
  // the pointer has actually left the window.
  const depth = useRef(0);

  useEffect(() => {
    const onEnter = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      depth.current += 1;
      setDragging(true);
    };

    const onOver = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      // Without this the drop never fires and the file navigates the window.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };

    const onLeave = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };

    const onDrop = (event: DragEvent) => {
      // Cancelled unconditionally: a file dropped anywhere in the window, drop
      // zone or not, must never become the document.
      event.preventDefault();
      depth.current = 0;
      setDragging(false);

      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;

      const paths = files.map((file) => window.longbox.pathForFile(file)).filter(Boolean);
      if (paths.length === 0) return;

      setBusy(true);
      setResult(undefined);
      void window.longbox
        .addPaths(paths)
        .then((next) => {
          setResult(next);
          onAdded();
        })
        .finally(() => setBusy(false));
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onAdded]);

  const dismiss = useCallback(() => setResult(undefined), []);

  return { dragging, busy, result, dismiss };
}

/** A sentence describing what a drop actually did. */
export function describeAdd(result: AddPathsResult): string {
  const parts: string[] = [];
  if (result.added > 0) parts.push(`${result.added} added`);
  if (result.updated > 0) parts.push(`${result.updated} already indexed`);
  if (result.foldersAdded > 0) {
    parts.push(`${result.foldersAdded} folder${result.foldersAdded === 1 ? '' : 's'} now watched`);
  }
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
  if (result.errors.length > 0) {
    parts.push(`${result.errors.length} could not be read`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Nothing to add.';
}
