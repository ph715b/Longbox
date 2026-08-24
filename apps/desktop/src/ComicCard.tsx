import { useCallback, useRef, useState } from 'react';
import { formatComicTitle } from '@longbox/core';
import type { Comic } from '@longbox/core';

/** Width of generated cover thumbnails, in CSS pixels before DPI scaling. */
const THUMB_WIDTH = 340;

/**
 * Anything wider than this is a full comic page rather than a cached
 * thumbnail, and is worth downscaling so the grid doesn't hold dozens of
 * multi-megapixel bitmaps in memory.
 */
const FULL_PAGE_THRESHOLD = 420;

/** Ids already thumbnailed this session, so a re-render doesn't redo the work. */
const generated = new Set<string>();

/**
 * Downscale a loaded cover and hand the JPEG to the main process to cache.
 *
 * The main process has no image decoder without pulling in a native module, so
 * the renderer does it: Chromium has already decoded the image to display it,
 * and a canvas re-encode is cheap next to a second decode elsewhere.
 */
async function cacheThumbnail(id: string, image: HTMLImageElement): Promise<void> {
  if (generated.has(id)) return;
  generated.add(id);

  const scale = THUMB_WIDTH / image.naturalWidth;
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_WIDTH;
  canvas.height = Math.round(image.naturalHeight * scale);

  const context = canvas.getContext('2d');
  if (!context) return;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.82),
  );
  if (!blob) return;

  await window.longbox.saveThumbnail(id, new Uint8Array(await blob.arrayBuffer()));
}

interface ComicCardProps {
  comic: Comic;
  onOpen: (comic: Comic) => void;
  /** Overrides the derived title, used when showing a series rather than an issue. */
  title?: string;
  subtitle?: string;
}

export function ComicCard({ comic, onOpen, title, subtitle }: ComicCardProps) {
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  const handleLoad = useCallback(() => {
    const image = imageRef.current;
    if (!image || image.naturalWidth < FULL_PAGE_THRESHOLD) return;
    void cacheThumbnail(comic.id, image);
  }, [comic.id]);

  const { furthestPage, completed } = comic.state;
  const pageCount = comic.pageCount || 1;
  const started = furthestPage > 0;
  const percent = completed ? 100 : Math.min(100, (furthestPage / pageCount) * 100);

  const heading = title ?? formatComicTitle(comic.metadata, comic.filename);
  const sub =
    subtitle ??
    [comic.metadata.year, comic.pageCount ? `${comic.pageCount}p` : undefined]
      .filter(Boolean)
      .join(' · ');

  return (
    <button className="card" onClick={() => onOpen(comic)} title={comic.filename}>
      <div className="cover">
        {failed ? (
          <div className="cover-fallback">{comic.filename}</div>
        ) : (
          <img
            ref={imageRef}
            src={window.longbox.coverUrl(comic.id)}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={handleLoad}
            onError={() => setFailed(true)}
          />
        )}

        {completed ? (
          <span className="badge done">Read</span>
        ) : started ? null : (
          <span className="badge unread">New</span>
        )}

        {started && !completed && (
          <div className="progress-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>

      <div className="card-title">{heading}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </button>
  );
}
