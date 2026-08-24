import { useCallback, useMemo, useState } from 'react';
import { formatComicTitle } from '@longbox/core';
import type { Comic, DuplicateGroup } from '@longbox/core';
import type { DuplicateReport } from './global.d.ts';

/**
 * Candidate duplicates, for a person to judge.
 *
 * Nothing is removed automatically. The strategies range from near-certain to
 * merely suggestive, and only the reader knows whether two files of the same
 * issue are a duplicate or a variant cover worth keeping, so this screen
 * presents evidence and leaves the decision alone.
 */

const REASON_LABEL: Record<DuplicateGroup['reason'], string> = {
  'same-cover': 'Identical cover',
  'identical-size': 'Same size and page count',
  'same-series-issue': 'Same series and issue',
};

const REASON_NOTE: Record<DuplicateGroup['reason'], string> = {
  'same-cover': 'The first page is byte-for-byte the same in both files.',
  'identical-size': 'Almost certainly the same download twice.',
  'same-series-issue': 'Could also be a variant cover or a different scan — worth a look.',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function Duplicates({
  comics,
  onChanged,
}: {
  comics: Comic[];
  onChanged: () => void;
}) {
  const [report, setReport] = useState<DuplicateReport>();
  const [busy, setBusy] = useState<'scanning' | 'hashing'>();
  const [note, setNote] = useState<string>();

  const byId = useMemo(() => new Map(comics.map((comic) => [comic.id, comic])), [comics]);
  const unhashed = useMemo(
    () => comics.filter((comic) => !comic.coverHash && !comic.missing).length,
    [comics],
  );

  const scan = useCallback(async () => {
    setBusy('scanning');
    setNote(undefined);
    try {
      setReport(await window.longbox.findDuplicates());
    } finally {
      setBusy(undefined);
    }
  }, []);

  const hashThenScan = useCallback(async () => {
    setBusy('hashing');
    setNote(undefined);
    try {
      const result = await window.longbox.hashCovers();
      setNote(
        `Fingerprinted ${result.hashed} ${result.hashed === 1 ? 'cover' : 'covers'}` +
          (result.failed > 0 ? `, ${result.failed} could not be opened` : '') +
          (result.cancelled ? ' (stopped early)' : ''),
      );
      onChanged();
      setReport(await window.longbox.findDuplicates());
    } finally {
      setBusy(undefined);
    }
  }, [onChanged]);

  const forget = useCallback(
    async (id: string) => {
      await window.longbox.removeComics([id]);
      onChanged();
      setReport(await window.longbox.findDuplicates());
    },
    [onChanged],
  );

  return (
    <div className="panel wide">
      <section>
        <h2>Duplicates</h2>
        <p className="hint">
          Files that look like the same book. <b>Remove</b> takes a comic out of the library only —
          it never deletes anything from disk. Use <b>Show in folder</b> if you want to delete the
          file yourself.
        </p>

        <div className="folder-row">
          <button className="btn primary" onClick={() => void scan()} disabled={busy !== undefined}>
            {busy === 'scanning' ? 'Checking…' : 'Check for duplicates'}
          </button>
          <button
            className="btn"
            onClick={() => void hashThenScan()}
            disabled={busy !== undefined || unhashed === 0}
            title="Opens every archive and fingerprints its first page. Slow, but catches copies that share nothing else."
          >
            {busy === 'hashing' ? 'Fingerprinting covers…' : `Also match by cover (${unhashed} to read)`}
          </button>
          {busy === 'hashing' && (
            <button className="btn" onClick={() => void window.longbox.cancelScan()}>
              Stop
            </button>
          )}
        </div>

        {note && <p className="hint">{note}</p>}

        {report && (
          report.groups.length === 0 ? (
            <p className="hint">
              No duplicates found{unhashed > 0 ? ' — matching by cover would look harder.' : '.'}
            </p>
          ) : (
            <>
              <p className="hint">
                {report.groups.length} {report.groups.length === 1 ? 'group' : 'groups'} ·{' '}
                {formatBytes(report.wastedBytes)} recoverable by keeping one of each.
              </p>

              {report.groups.map((group, index) => (
                <div key={index} className="dupe-group">
                  <div className="dupe-head">
                    <span className="badge reason">{REASON_LABEL[group.reason]}</span>
                    <span className="hint" style={{ margin: 0 }}>
                      {REASON_NOTE[group.reason]}
                    </span>
                  </div>

                  {group.comicIds.map((id, position) => {
                    const comic = byId.get(id);
                    if (!comic) return null;
                    return (
                      <div key={id} className={`dupe-row ${position === 0 ? 'keep' : ''}`}>
                        <span className="dupe-mark">{position === 0 ? 'Keep' : ''}</span>
                        <div className="dupe-detail">
                          <span className="dupe-name">
                            {formatComicTitle(comic.metadata, comic.filename)}
                          </span>
                          <span className="dupe-path" title={comic.path}>
                            {comic.path}
                          </span>
                        </div>
                        <span className="dupe-facts">
                          {comic.pageCount}p · {formatBytes(comic.size)} · {comic.format}
                        </span>
                        <button
                          className="btn"
                          onClick={() => void window.longbox.revealInFolder(comic.id)}
                        >
                          Show in folder
                        </button>
                        <button className="btn" onClick={() => void forget(comic.id)}>
                          Remove
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          )
        )}
      </section>
    </div>
  );
}
