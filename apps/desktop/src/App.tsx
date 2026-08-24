import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  compareIssues,
  formatIssue,
  matchesFilter,
  missingIssues,
  nextUnread,
  sortComics,
} from '@longbox/core';
import type {
  Comic,
  FitMode,
  LibraryFilter,
  LibrarySort,
  ReadingDirection,
  ReadingMode,
  SortField,
} from '@longbox/core';
import { ComicCard } from './ComicCard.tsx';
import { CollectionsView } from './Collections.tsx';
import { Duplicates } from './Duplicates.tsx';
import { Reader } from './Reader.tsx';
import { Stats } from './Stats.tsx';
import { useLibrary } from './useLibrary.ts';

type View = 'library' | 'series' | 'reading' | 'collections' | 'stats' | 'duplicates' | 'settings';

/**
 * Views that stand on their own and must not be replaced by the "library is
 * empty" prompt -- settings and backup are exactly where someone with an empty
 * library needs to go, and the rest explain their own emptiness.
 */
const STANDALONE_VIEWS = new Set<View>(['settings', 'collections', 'stats', 'duplicates']);

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'series', label: 'Series' },
  { value: 'added', label: 'Recently added' },
  { value: 'lastRead', label: 'Recently read' },
  { value: 'year', label: 'Year' },
  { value: 'title', label: 'Title' },
  { value: 'rating', label: 'Rating' },
  { value: 'size', label: 'File size' },
];

export function App() {
  const library = useLibrary();

  const [view, setView] = useState<View>('library');
  const [search, setSearch] = useState('');
  const [readStatus, setReadStatus] = useState<LibraryFilter['readStatus']>('all');
  const [sortField, setSortField] = useState<SortField>('series');
  const [sortDescending, setSortDescending] = useState(false);
  const [openSeriesId, setOpenSeriesId] = useState<string | undefined>();
  const [openCollectionId, setOpenCollectionId] = useState<string | undefined>();
  const [reading, setReading] = useState<Comic | undefined>();

  // Bumped whenever the library changes underneath a view that fetched derived
  // data of its own, so stats and duplicate reports do not go stale.
  const [dataVersion, setDataVersion] = useState(0);
  const noteChanged = useCallback(() => {
    void library.refresh();
    setDataVersion((value) => value + 1);
  }, [library]);

  // Reader preferences start from the global defaults and are overridden per
  // series once the user changes them while reading that series.
  const [mode, setMode] = useState<ReadingMode>('single');
  const [fit, setFit] = useState<FitMode>('height');
  const [direction, setDirection] = useState<ReadingDirection>('ltr');

  useEffect(() => {
    setMode(library.settings.defaultReadingMode);
    setFit(library.settings.defaultFitMode);
  }, [library.settings.defaultReadingMode, library.settings.defaultFitMode]);

  const filter = useMemo<LibraryFilter>(
    () => ({ search: search.trim() || undefined, readStatus }),
    [search, readStatus],
  );

  const sort = useMemo<LibrarySort>(
    () => ({ field: sortField, direction: sortDescending ? 'desc' : 'asc' }),
    [sortField, sortDescending],
  );

  const visibleComics = useMemo(
    () => sortComics(library.comics.filter((comic) => matchesFilter(comic, filter)), sort),
    [library.comics, filter, sort],
  );

  const unreadCount = useMemo(
    () => library.comics.filter((comic) => !comic.state.completed && !comic.missing).length,
    [library.comics],
  );

  const inProgress = useMemo(
    () =>
      library.comics
        .filter((comic) => comic.state.furthestPage > 0 && !comic.state.completed && !comic.missing)
        .sort((a, b) => (b.state.lastReadAt ?? 0) - (a.state.lastReadAt ?? 0)),
    [library.comics],
  );

  /** Apply the series' saved preferences, if any, when opening a comic. */
  const openComic = useCallback(
    (comic: Comic) => {
      const series = library.series.find((item) => item.id === comic.seriesId);
      const preferences = series?.preferences;
      setMode(preferences?.readingMode ?? library.settings.defaultReadingMode);
      setFit(preferences?.fitMode ?? library.settings.defaultFitMode);
      // A book that declares itself right-to-left wins over the series default.
      setDirection(comic.metadata.direction ?? preferences?.direction ?? 'ltr');
      setReading(comic);
    },
    [library.series, library.settings],
  );

  const closeReader = useCallback(() => {
    setReading(undefined);
    void library.refresh();
  }, [library]);

  /** Persist a reader preference against the series being read. */
  const persistPreference = useCallback(
    (patch: { readingMode?: ReadingMode; fitMode?: FitMode; direction?: ReadingDirection }) => {
      const seriesId = reading?.seriesId;
      if (seriesId) void window.longbox.setSeriesPreferences(seriesId, patch);
    },
    [reading],
  );

  if (reading) {
    const series = library.series.find((item) => item.id === reading.seriesId);
    return (
      <Reader
        comic={reading}
        mode={mode}
        fit={fit}
        direction={direction}
        coverIsSingle={series?.preferences?.coverIsSingle ?? true}
        onClose={closeReader}
        onChangeMode={(next) => {
          setMode(next);
          persistPreference({ readingMode: next });
        }}
        onChangeFit={(next) => {
          setFit(next);
          persistPreference({ fitMode: next });
        }}
        onChangeDirection={(next) => {
          setDirection(next);
          persistPreference({ direction: next });
        }}
      />
    );
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark">L</span>
          Longbox
        </div>

        <div>
          <div className="nav-section-label">Library</div>
          <NavItem
            icon="▦"
            label="All comics"
            count={library.comics.length}
            active={view === 'library' && !openSeriesId}
            onClick={() => {
              setView('library');
              setOpenSeriesId(undefined);
            }}
          />
          <NavItem
            icon="◷"
            label="Continue reading"
            count={inProgress.length}
            active={view === 'reading'}
            onClick={() => setView('reading')}
          />
          <NavItem
            icon="◈"
            label="Series"
            count={library.series.length}
            active={view === 'series'}
            onClick={() => {
              setView('series');
              setOpenSeriesId(undefined);
            }}
          />
          <NavItem
            icon="✦"
            label="Unread"
            count={unreadCount}
            active={view === 'library' && readStatus === 'unread'}
            onClick={() => {
              setView('library');
              setOpenSeriesId(undefined);
              setReadStatus('unread');
            }}
          />
          <NavItem
            icon="▤"
            label="Collections"
            count={library.collections.length}
            active={view === 'collections'}
            onClick={() => {
              setView('collections');
              setOpenCollectionId(undefined);
            }}
          />
          <NavItem
            icon="▨"
            label="Stats"
            active={view === 'stats'}
            onClick={() => setView('stats')}
          />
          <NavItem
            icon="⧉"
            label="Duplicates"
            active={view === 'duplicates'}
            onClick={() => setView('duplicates')}
          />
        </div>

        <div style={{ marginTop: 'auto' }}>
          <NavItem
            icon="⚙"
            label="Settings"
            active={view === 'settings'}
            onClick={() => setView('settings')}
          />
        </div>
      </nav>

      <main className="main">
        <Toolbar
          view={view}
          search={search}
          onSearch={setSearch}
          readStatus={readStatus}
          onReadStatus={setReadStatus}
          sortField={sortField}
          onSortField={setSortField}
          sortDescending={sortDescending}
          onToggleSortDirection={() => setSortDescending((value) => !value)}
          scanning={library.scanning}
          onScan={() => void library.scan()}
          hasFolders={library.folders.length > 0}
          openSeriesName={
            openSeriesId ? library.series.find((s) => s.id === openSeriesId)?.name : undefined
          }
          onBack={() => setOpenSeriesId(undefined)}
        />

        {library.scanning && library.progress && (
          <div className="scan-banner">
            <span>
              {library.progress.phase === 'discovering'
                ? 'Looking for comics…'
                : `Reading ${library.progress.filesProcessed} of ${library.progress.filesFound}`}
            </span>
            <div className="track">
              <span
                style={{
                  width: `${
                    library.progress.filesFound
                      ? (library.progress.filesProcessed / library.progress.filesFound) * 100
                      : 0
                  }%`,
                }}
              />
            </div>
            <span style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {library.progress.current}
            </span>
            <button className="btn" onClick={() => void window.longbox.cancelScan()}>
              Cancel
            </button>
          </div>
        )}

        <div className="content">
          {library.loading ? null : library.comics.length === 0 && !STANDALONE_VIEWS.has(view) ? (
            <EmptyLibrary
              hasFolders={library.folders.length > 0}
              onAddFolder={() => void library.addFolder().then((added) => {
                if (added) void library.scan();
              })}
              onScan={() => void library.scan()}
            />
          ) : openSeriesId ? (
            <SeriesDetail
              comics={library.comicsOfSeries(openSeriesId)}
              onOpen={openComic}
            />
          ) : view === 'series' ? (
            <SeriesGrid
              series={library.series}
              comics={library.comics}
              onOpen={setOpenSeriesId}
            />
          ) : view === 'reading' ? (
            inProgress.length === 0 ? (
              <div className="empty">
                <h2>Nothing in progress</h2>
                <p>Comics you have started but not finished will collect here.</p>
              </div>
            ) : (
              <div className="grid">
                {inProgress.map((comic) => (
                  <ComicCard key={comic.id} comic={comic} onOpen={openComic} />
                ))}
              </div>
            )
          ) : view === 'collections' ? (
            <CollectionsView
              collections={library.collections}
              comics={library.comics}
              openId={openCollectionId}
              onOpen={setOpenCollectionId}
              onChanged={noteChanged}
              onOpenComic={openComic}
            />
          ) : view === 'stats' ? (
            <Stats refreshKey={dataVersion} />
          ) : view === 'duplicates' ? (
            <Duplicates comics={library.comics} onChanged={noteChanged} />
          ) : view === 'settings' ? (
            <Settings library={library} />
          ) : visibleComics.length === 0 ? (
            <div className="empty">
              <h2>No matches</h2>
              <p>Nothing here matches “{search}”. Try a different search or clear the filter.</p>
            </div>
          ) : (
            <div className="grid">
              {visibleComics.map((comic) => (
                <ComicCard key={comic.id} comic={comic} onOpen={openComic} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// --- Pieces ---------------------------------------------------------------

function NavItem({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      {label}
      {count !== undefined && <span className="count">{count}</span>}
    </button>
  );
}

function Toolbar(props: {
  view: View;
  search: string;
  onSearch: (value: string) => void;
  readStatus: LibraryFilter['readStatus'];
  onReadStatus: (value: LibraryFilter['readStatus']) => void;
  sortField: SortField;
  onSortField: (value: SortField) => void;
  sortDescending: boolean;
  onToggleSortDirection: () => void;
  scanning: boolean;
  onScan: () => void;
  hasFolders: boolean;
  openSeriesName?: string;
  onBack: () => void;
}) {
  const showFilters = props.view === 'library' && !props.openSeriesName;

  return (
    <div className="toolbar">
      {props.openSeriesName ? (
        <>
          <button className="btn" onClick={props.onBack}>
            ← Series
          </button>
          <h1>{props.openSeriesName}</h1>
        </>
      ) : (
        <h1>
          {props.view === 'series'
            ? 'Series'
            : props.view === 'reading'
              ? 'Continue reading'
              : props.view === 'settings'
                ? 'Settings'
                : 'All comics'}
        </h1>
      )}

      <div className="spacer" />

      {props.view !== 'settings' && (
        <div className="search">
          <span className="search-icon">⌕</span>
          <input
            type="search"
            placeholder="Search series, writer, title…"
            value={props.search}
            onChange={(event) => props.onSearch(event.target.value)}
          />
        </div>
      )}

      {showFilters && (
        <>
          <select
            className="btn"
            value={props.readStatus}
            onChange={(event) =>
              props.onReadStatus(event.target.value as LibraryFilter['readStatus'])
            }
          >
            <option value="all">All</option>
            <option value="unread">Unread</option>
            <option value="inProgress">In progress</option>
            <option value="completed">Finished</option>
          </select>

          <select
            className="btn"
            value={props.sortField}
            onChange={(event) => props.onSortField(event.target.value as SortField)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <button
            className="btn"
            onClick={props.onToggleSortDirection}
            title={props.sortDescending ? 'Descending' : 'Ascending'}
          >
            {props.sortDescending ? '↓' : '↑'}
          </button>
        </>
      )}

      {props.hasFolders && (
        <button className="btn primary" onClick={props.onScan} disabled={props.scanning}>
          {props.scanning ? 'Scanning…' : 'Scan'}
        </button>
      )}
    </div>
  );
}

function EmptyLibrary({
  hasFolders,
  onAddFolder,
  onScan,
}: {
  hasFolders: boolean;
  onAddFolder: () => void;
  onScan: () => void;
}) {
  return (
    <div className="empty">
      <h2>{hasFolders ? 'No comics found yet' : 'Your longbox is empty'}</h2>
      <p>
        {hasFolders
          ? 'The folders you added did not contain any readable comics. Scan again after adding files, or add another folder.'
          : 'Point Longbox at the folder where you keep your downloads. It reads CBZ, CBR, CBT, and PDF, and never moves or changes your files unless you ask it to.'}
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" onClick={onAddFolder}>
          Add a folder
        </button>
        {hasFolders && (
          <button className="btn" onClick={onScan}>
            Scan again
          </button>
        )}
      </div>
    </div>
  );
}

function SeriesGrid({
  series,
  comics,
  onOpen,
}: {
  series: ReturnType<typeof useLibrary>['series'];
  comics: Comic[];
  onOpen: (id: string) => void;
}) {
  const byId = useMemo(() => new Map(comics.map((comic) => [comic.id, comic])), [comics]);

  return (
    <div className="grid">
      {series.map((item) => {
        const cover = item.coverComicId ? byId.get(item.coverComicId) : undefined;
        if (!cover) return null;
        return (
          <ComicCard
            key={item.id}
            comic={cover}
            title={item.name}
            subtitle={`${item.issueCount} issue${item.issueCount === 1 ? '' : 's'}${
              item.readCount ? ` · ${item.readCount} read` : ''
            }`}
            onOpen={() => onOpen(item.id)}
          />
        );
      })}
    </div>
  );
}

function SeriesDetail({ comics, onOpen }: { comics: Comic[]; onOpen: (comic: Comic) => void }) {
  const ordered = useMemo(() => [...comics].sort(compareIssues), [comics]);
  const gaps = useMemo(() => missingIssues(comics), [comics]);
  const next = useMemo(() => nextUnread(comics), [comics]);

  return (
    <div>
      {next && (
        <div style={{ marginBottom: 18 }}>
          <button className="btn primary" onClick={() => onOpen(next)}>
            {next.state.furthestPage > 0 ? 'Continue' : 'Start'} {formatIssue(next.metadata)}
          </button>
          {gaps.length > 0 && (
            <span style={{ marginLeft: 14, color: 'var(--text-faint)', fontSize: 12.5 }}>
              Missing #{gaps.slice(0, 12).join(', #')}
              {gaps.length > 12 ? '…' : ''}
            </span>
          )}
        </div>
      )}

      <div className="grid">
        {ordered.map((comic) => (
          <ComicCard key={comic.id} comic={comic} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

/**
 * Export and import of the library file.
 *
 * Reading progress is keyed to a comic's path and size, so moving a collection
 * to another drive would otherwise strand every position, rating, and favourite.
 * An export carries that history and the import re-attaches it by filename, so
 * reorganising files costs nothing.
 */
function BackupSection({ library }: { library: ReturnType<typeof useLibrary> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string }>();

  const doExport = useCallback(async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await window.longbox.exportLibrary();
      if (result.cancelled) return;
      if (!result.ok) {
        setMessage({ kind: 'error', text: result.error });
        return;
      }
      setMessage({
        kind: 'ok',
        text: `Saved ${result.comics} ${result.comics === 1 ? 'comic' : 'comics'} to ${result.path}`,
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const doImport = useCallback(async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await window.longbox.importLibrary();
      if (result.cancelled) return;
      if (!result.ok) {
        setMessage({ kind: 'error', text: result.error });
        return;
      }

      const { summary } = result;
      const parts = [
        `${summary.progressUpdated} of ${summary.matched} matched ${summary.matched === 1 ? 'comic' : 'comics'} updated`,
      ];
      // Worth surfacing: a name match means the files moved since the export.
      const byName = summary.matchedByNameAndSize + summary.matchedByName;
      if (byName > 0) parts.push(`${byName} re-matched by filename after a move`);
      if (summary.unmatched > 0) parts.push(`${summary.unmatched} not in this library yet`);
      if (summary.foldersAdded > 0) parts.push(`${summary.foldersAdded} folder(s) added`);
      if (summary.collectionsAdded > 0) parts.push(`${summary.collectionsAdded} collection(s) added`);

      setMessage({ kind: 'ok', text: parts.join(' · ') });
      await library.refresh();
    } finally {
      setBusy(false);
    }
  }, [library]);

  return (
    <section>
      <h2>Backup</h2>
      <p className="hint">
        An export holds reading progress, ratings, favourites, tags, and collections — not the
        comics themselves. Importing only ever moves progress forward, so it is safe to run
        against a library you have kept reading.
      </p>

      <div className="folder-row">
        <button className="btn primary" onClick={() => void doExport()} disabled={busy}>
          Export library…
        </button>
        <button className="btn" onClick={() => void doImport()} disabled={busy}>
          Import library…
        </button>
      </div>

      {message && (
        <p className={message.kind === 'error' ? 'hint error' : 'hint'}>{message.text}</p>
      )}
    </section>
  );
}

function Settings({ library }: { library: ReturnType<typeof useLibrary> }) {
  return (
    <div className="panel">
      <section>
        <h2>Watched folders</h2>
        <p className="hint">
          Longbox indexes these folders. It reads your files in place and never moves, renames, or
          deletes anything on its own.
        </p>

        {library.folders.map((folder) => (
          <div key={folder.id} className="folder-row">
            <span className="path">{folder.path}</span>
            <button className="btn" onClick={() => void library.removeFolder(folder.id)}>
              Remove
            </button>
          </div>
        ))}

        <button
          className="btn primary"
          onClick={() => void library.addFolder().then((added) => {
            if (added) void library.scan();
          })}
        >
          Add folder
        </button>
      </section>

      <section>
        <h2>Reading defaults</h2>
        <p className="hint">Applied to series you have not set a preference for.</p>

        <div className="field">
          <label htmlFor="default-mode">Page layout</label>
          <select
            id="default-mode"
            className="btn"
            value={library.settings.defaultReadingMode}
            onChange={(event) =>
              void window.longbox
                .updateSettings({ defaultReadingMode: event.target.value as ReadingMode })
                .then(library.refresh)
            }
          >
            <option value="single">Single page</option>
            <option value="double">Two pages</option>
            <option value="continuous">Continuous scroll</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="default-fit">Fit</label>
          <select
            id="default-fit"
            className="btn"
            value={library.settings.defaultFitMode}
            onChange={(event) =>
              void window.longbox
                .updateSettings({ defaultFitMode: event.target.value as FitMode })
                .then(library.refresh)
            }
          >
            <option value="height">Fit height</option>
            <option value="width">Fit width</option>
            <option value="page">Fit page</option>
            <option value="original">Original size</option>
          </select>
        </div>
      </section>

      <BackupSection library={library} />

      <section>
        <h2>Keyboard</h2>
        <p className="hint">
          Arrow keys or space turn pages · <b>D</b> two-page · <b>W</b> fit width · <b>F</b>{' '}
          fullscreen · <b>H</b> hide the bar · <b>Esc</b> close
        </p>
      </section>
    </div>
  );
}
