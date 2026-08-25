import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { formatComicTitle } from '@longbox/core';
import type { Collection, Comic } from '@longbox/core';
import { COMIC_MIME } from './useFileDrop.ts';

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
  /** When given, the cover carries a control for adding to these collections. */
  collections?: Collection[];
  onCollectionsChanged?: () => void;
  /**
   * Makes the card draggable, and optionally a drop target for another card.
   * Absent means the card does not participate in dragging at all.
   */
  drag?: {
    onStart: () => void;
    onEnd: () => void;
    onOver?: (event: React.DragEvent) => void;
    onDrop?: () => void;
    /** This card is the one being dragged. */
    lifted?: boolean;
    /** A dragged card would land here. */
    over?: boolean;
  };
}

export function ComicCard({
  comic,
  onOpen,
  title,
  subtitle,
  collections,
  onCollectionsChanged,
  drag,
}: ComicCardProps) {
  const [failed, setFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // A click anywhere else closes the menu. Registered only while it is open so
  // a grid of several hundred cards is not all listening at once.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocumentClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocumentClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const toggleMembership = useCallback(
    async (collection: Collection) => {
      const member = collection.comicIds.includes(comic.id);
      await window.longbox.setCollectionMembers(collection.id, [comic.id], !member);
      onCollectionsChanged?.();
    },
    [comic.id, onCollectionsChanged],
  );

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
    // A div rather than a button: the collections control is itself a button and
    // one cannot be nested inside another.
    <div
      className={[
        'card',
        comic.missing ? 'is-missing' : '',
        drag?.lifted ? 'is-lifted' : '',
        drag?.over ? 'is-drop-target' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="button"
      tabIndex={0}
      draggable={drag !== undefined}
      onDragStart={(event) => {
        if (!drag) return;
        // A payload has to be set or Firefox-style drags never start, and the
        // custom type is what tells the window-wide file drop zone to ignore us.
        event.dataTransfer.setData(COMIC_MIME, comic.id);
        event.dataTransfer.effectAllowed = 'move';
        drag.onStart();
      }}
      onDragEnd={() => drag?.onEnd()}
      onDragOver={(event) => {
        if (!drag?.onOver) return;
        event.preventDefault();
        drag.onOver(event);
      }}
      onDrop={(event) => {
        if (!drag?.onDrop) return;
        event.preventDefault();
        event.stopPropagation();
        drag.onDrop();
      }}
      onClick={() => onOpen(comic)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(comic);
        }
      }}
      title={comic.filename}
    >
      <div className="cover">
        {comic.missing ? (
          <div className="cover-fallback missing-cover">
            <span className="missing-glyph">⚠</span>
            {comic.filename}
          </div>
        ) : failed ? (
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

        {comic.missing ? (
          <span className="badge missing">No file</span>
        ) : completed ? (
          <span className="badge done">Read</span>
        ) : started ? null : (
          <span className="badge unread">New</span>
        )}

        {started && !completed && (
          <div className="progress-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
        )}

        {collections && (
          <div className="card-menu-anchor" ref={menuRef}>
            <button
              className="card-add"
              title="Add to a collection"
              aria-label="Add to a collection"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((open) => !open);
              }}
            >
              +
            </button>

            {menuOpen && (
              <div className="card-menu" onClick={(event) => event.stopPropagation()}>
                {collections.length === 0 ? (
                  <p className="card-menu-empty">No collections yet.</p>
                ) : (
                  collections.map((collection) => {
                    const member = collection.comicIds.includes(comic.id);
                    return (
                      <button
                        key={collection.id}
                        className={`card-menu-item ${member ? 'on' : ''}`}
                        onClick={() => void toggleMembership(collection)}
                      >
                        <span className="tick">{member ? '✓' : ''}</span>
                        {collection.name}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card-title">{heading}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </div>
  );
}
