import { useCallback, useEffect, useRef, useState } from 'react';
import type { DropPlan } from './global.d.ts';

/**
 * Accepting comics dropped from Explorer.
 *
 * Two things have to be true for this to work at all. The window must refuse to
 * navigate to a dropped file, or Chromium replaces the whole app with the raw
 * archive; and the real path has to come from `webUtils` in the preload, since
 * Electron 32 removed the non-standard `File.path`.
 *
 * A drop is planned, never carried out here. Where a comic belongs is a
 * judgement a filename cannot be trusted with, so the plan goes to the user for
 * confirmation and only then moves anything.
 */

/** MIME type dragged between views inside the app, distinct from file drops. */
export const COMIC_MIME = 'application/x-longbox-comic';

function carriesFiles(transfer: DataTransfer | null): boolean {
  // A drag from inside the app carries our own type and must not light up the
  // whole-window drop zone; only genuine files from the OS should.
  return !!transfer && Array.from(transfer.types).includes('Files');
}

export function useFileDrop(onChanged: () => void) {
  const [dragging, setDragging] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<DropPlan>();

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

      setPlanning(true);
      void window.longbox
        .planDrop(paths)
        .then((next) => {
          // Dropping only folders adopts them outright and needs no dialog.
          if (next.candidates.length === 0) {
            onChanged();
            if (next.foldersAdded > 0 || next.added > 0) setPlan(next);
            return;
          }
          setPlan(next);
          onChanged();
        })
        .finally(() => setPlanning(false));
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
  }, [onChanged]);

  const dismiss = useCallback(() => setPlan(undefined), []);

  return { dragging, planning, plan, dismiss };
}
