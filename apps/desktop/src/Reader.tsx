import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatComicTitle } from '@longbox/core';
import type { Comic, FitMode, ReadingDirection, ReadingMode } from '@longbox/core';
import { useProgressReporter } from './useLibrary.ts';

/** How many pages ahead to warm the cache. */
const PREFETCH_AHEAD = 3;

/**
 * Group page indices into what gets shown at once.
 *
 * In double-page mode a comic reads as facing pairs, but two cases break a
 * naive "pair them up" rule. The cover is normally a single page, so pairing
 * from index 0 puts every later spread out of step with the printed book. And
 * a double-page splash is stored as one wide image, which must occupy the
 * screen alone or the pairing shifts from there on.
 */
function buildSpreads(
  pageCount: number,
  mode: ReadingMode,
  coverIsSingle: boolean,
  widePages: Set<number>,
): number[][] {
  if (mode !== 'double') {
    return Array.from({ length: pageCount }, (_, index) => [index]);
  }

  const spreads: number[][] = [];
  let index = 0;

  if (coverIsSingle && pageCount > 0) {
    spreads.push([0]);
    index = 1;
  }

  while (index < pageCount) {
    const isWide = widePages.has(index);
    const nextIsWide = widePages.has(index + 1);

    if (isWide || index + 1 >= pageCount || nextIsWide) {
      spreads.push([index]);
      index += 1;
    } else {
      spreads.push([index, index + 1]);
      index += 2;
    }
  }

  return spreads;
}

interface ReaderProps {
  comic: Comic;
  mode: ReadingMode;
  fit: FitMode;
  direction: ReadingDirection;
  coverIsSingle: boolean;
  onClose: () => void;
  onChangeMode: (mode: ReadingMode) => void;
  onChangeFit: (fit: FitMode) => void;
  onChangeDirection: (direction: ReadingDirection) => void;
}

export function Reader({
  comic,
  mode,
  fit,
  direction,
  coverIsSingle,
  onClose,
  onChangeMode,
  onChangeFit,
  onChangeDirection,
}: ReaderProps) {
  const [page, setPage] = useState(() =>
    // Resume where the reader left off, unless the book was finished.
    comic.state.completed ? 0 : Math.min(comic.state.currentPage, Math.max(0, comic.pageCount - 1)),
  );
  const [widePages, setWidePages] = useState<Set<number>>(() => new Set());
  const [pageCount, setPageCount] = useState(comic.pageCount);
  const [chromeVisible, setChromeVisible] = useState(true);

  const stageRef = useRef<HTMLDivElement>(null);
  const { report, flush } = useProgressReporter(comic.id);

  // PDFs and any file the scanner couldn't count are resolved on open.
  useEffect(() => {
    if (pageCount > 0) return;
    void window.longbox.getPageCount(comic.id).then(setPageCount);
  }, [comic.id, pageCount]);

  const spreads = useMemo(
    () => buildSpreads(pageCount, mode, coverIsSingle, widePages),
    [pageCount, mode, coverIsSingle, widePages],
  );

  const spreadIndex = useMemo(
    () => Math.max(0, spreads.findIndex((spread) => spread.includes(page))),
    [spreads, page],
  );

  const goToPage = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(next, pageCount - 1));
      setPage(clamped);
      report(clamped);
    },
    [pageCount, report],
  );

  const step = useCallback(
    (delta: 1 | -1) => {
      if (mode === 'continuous') {
        // Scrolling is the navigation in continuous mode; arrows nudge a screen.
        stageRef.current?.scrollBy({ top: delta * window.innerHeight * 0.9, behavior: 'smooth' });
        return;
      }
      const target = spreads[spreadIndex + delta];
      if (target) goToPage(target[0]);
    },
    [mode, spreads, spreadIndex, goToPage],
  );

  /** Forward and back in *reading* order, which RTL reverses. */
  const advance = useCallback(() => step(1), [step]);
  const retreat = useCallback(() => step(-1), [step]);

  // Track which pages are landscape so spreads pair correctly.
  const notePageShape = useCallback((index: number, image: HTMLImageElement) => {
    if (image.naturalWidth <= image.naturalHeight) return;
    setWidePages((current) => {
      if (current.has(index)) return current;
      const next = new Set(current);
      next.add(index);
      return next;
    });
  }, []);

  // Warm the next few pages so a page turn is instant.
  useEffect(() => {
    for (let offset = 1; offset <= PREFETCH_AHEAD; offset += 1) {
      const target = page + offset;
      if (target >= pageCount) break;
      const image = new Image();
      // Measuring here rather than on display means a wide page is known to be
      // wide before it is paired, so the spread does not re-form under the
      // reader a moment after it appears.
      image.onload = () => notePageShape(target, image);
      image.src = window.longbox.pageUrl(comic.id, target);
    }
  }, [comic.id, page, pageCount, notePageShape]);

  // Continuous mode scrolls rather than paging, so derive position from scroll.
  useEffect(() => {
    if (mode !== 'continuous') return;
    const stage = stageRef.current;
    if (!stage) return;

    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const images = stage.querySelectorAll('img[data-page]');
        for (const image of images) {
          const box = image.getBoundingClientRect();
          // The page occupying the middle of the viewport is the one being read.
          if (box.bottom > window.innerHeight * 0.4) {
            const index = Number.parseInt(image.getAttribute('data-page') ?? '0', 10);
            setPage(index);
            report(index);
            break;
          }
        }
      });
    };

    stage.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      stage.removeEventListener('scroll', onScroll);
    };
  }, [mode, report]);

  const close = useCallback(() => {
    flush();
    onClose();
  }, [flush, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The slider and the mode/fit menus handle arrow keys themselves. Letting
      // this run as well moved the page twice for one press.
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') &&
        event.key !== 'Escape'
      ) {
        return;
      }

      const rtl = direction === 'rtl';
      switch (event.key) {
        case 'ArrowRight':
          rtl ? retreat() : advance();
          break;
        case 'ArrowLeft':
          rtl ? advance() : retreat();
          break;
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          event.preventDefault();
          advance();
          break;
        case 'ArrowUp':
        case 'PageUp':
          event.preventDefault();
          retreat();
          break;
        case 'Home':
          goToPage(0);
          break;
        case 'End':
          goToPage(pageCount - 1);
          break;
        case 'Escape':
          close();
          break;
        case 'f':
        case 'F':
          void document.documentElement.requestFullscreen?.().catch(() => {});
          break;
        case 'h':
        case 'H':
          setChromeVisible((visible) => !visible);
          break;
        case 'd':
        case 'D':
          onChangeMode(mode === 'double' ? 'single' : 'double');
          break;
        case 'w':
        case 'W':
          onChangeFit(fit === 'width' ? 'height' : 'width');
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, retreat, goToPage, close, pageCount, direction, mode, fit, onChangeMode, onChangeFit]);

  // Flush the final position if the window closes while the reader is open.
  useEffect(() => flush, [flush]);

  const visiblePages = spreads[spreadIndex] ?? [0];
  const ordered = direction === 'rtl' ? [...visiblePages].reverse() : visiblePages;

  const fitClass =
    fit === 'width' ? 'fit-width' : fit === 'height' ? 'fit-height' : fit === 'original' ? 'fit-original' : '';

  return (
    <div className="reader">
      <div ref={stageRef} className={`reader-stage ${mode === 'continuous' ? 'continuous' : ''} ${fitClass}`}>
        {mode === 'continuous' ? (
          Array.from({ length: pageCount }, (_, index) => (
            <img
              key={index}
              data-page={index}
              src={window.longbox.pageUrl(comic.id, index)}
              alt={`Page ${index + 1}`}
              loading="lazy"
              decoding="async"
            />
          ))
        ) : (
          <>
            <div
              className="tap-zone prev"
              onClick={direction === 'rtl' ? advance : retreat}
              aria-label="Previous page"
            />
            <div
              className="tap-zone next"
              onClick={direction === 'rtl' ? retreat : advance}
              aria-label="Next page"
            />
            <div className="spread">
              {ordered.map((index) => (
                <img
                  key={index}
                  src={window.longbox.pageUrl(comic.id, index)}
                  alt={`Page ${index + 1}`}
                  decoding="async"
                  onLoad={(event) => notePageShape(index, event.currentTarget)}
                />
              ))}
            </div>
          </>
        )}

        {pageCount === 0 && <div className="reader-loading">Opening…</div>}
      </div>

      {chromeVisible && (
        <div className="reader-bar">
          <button className="btn" onClick={close} title="Close (Esc)">
            ← Library
          </button>

          <span className="title">{formatComicTitle(comic.metadata, comic.filename)}</span>

          <span className="spacer" style={{ flex: 1 }} />

          <select
            className="btn"
            value={mode}
            onChange={(event) => onChangeMode(event.target.value as ReadingMode)}
            title="Reading mode (D toggles two-page)"
          >
            <option value="single">Single page</option>
            <option value="double">Two pages</option>
            <option value="continuous">Continuous scroll</option>
          </select>

          <select
            className="btn"
            value={fit}
            onChange={(event) => onChangeFit(event.target.value as FitMode)}
            title="Fit (W toggles width)"
          >
            <option value="height">Fit height</option>
            <option value="width">Fit width</option>
            <option value="page">Fit page</option>
            <option value="original">Original size</option>
          </select>

          <button
            className="btn"
            onClick={() => onChangeDirection(direction === 'rtl' ? 'ltr' : 'rtl')}
            title="Reading direction"
          >
            {direction === 'rtl' ? 'Manga ←' : 'Western →'}
          </button>

          <input
            className="reader-slider"
            type="range"
            min={0}
            max={Math.max(0, pageCount - 1)}
            value={page}
            onChange={(event) => goToPage(Number(event.target.value))}
          />

          <span className="page-count">
            {page + 1} / {pageCount || '?'}
          </span>
        </div>
      )}
    </div>
  );
}
