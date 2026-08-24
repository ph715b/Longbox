import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildExport, mergeImport, parseExport, EXPORT_FORMAT } from './transfer.ts';
import { emptySnapshot } from './store.ts';
import { comicId } from '../util/id.ts';
import type { Comic } from '../types.ts';
import type { LibrarySnapshot } from './store.ts';

function comic(path: string, size: number, overrides: Partial<Comic> = {}): Comic {
  const filename = path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1);
  return {
    id: comicId(path, size),
    path,
    filename,
    format: 'cbz',
    size,
    modifiedAt: 1_700_000_000_000,
    addedAt: 1_700_000_000_000,
    pageCount: 24,
    metadata: { series: 'Absolute Batman' },
    state: { currentPage: 0, furthestPage: 0, completed: false, timeSpentMs: 0 },
    tags: [],
    rating: 0,
    favorite: false,
    ...overrides,
  };
}

function snapshotOf(comics: Comic[]): LibrarySnapshot {
  return { ...emptySnapshot(), comics };
}

const read = (currentPage: number, furthestPage: number, extra = {}) => ({
  state: { currentPage, furthestPage, completed: false, timeSpentMs: 60_000, ...extra },
});

test('an export round-trips through parse', () => {
  const source = snapshotOf([comic('D:/Comics/Batman 001.cbz', 100)]);
  const parsed = parseExport(JSON.stringify(buildExport(source, '0.1.0')));
  assert.equal(parsed.format, EXPORT_FORMAT);
  assert.equal(parsed.appVersion, '0.1.0');
  assert.equal(parsed.snapshot.comics.length, 1);
});

test('non-Longbox JSON is refused rather than half-applied', () => {
  assert.throws(() => parseExport('{"hello":"world"}'), /not a Longbox library export/);
  assert.throws(() => parseExport('not json at all'), /not valid JSON/);
  assert.throws(
    () => parseExport(JSON.stringify({ format: EXPORT_FORMAT, exportVersion: 99, snapshot: {} })),
    /newer version of Longbox/,
  );
});

test('progress re-attaches after the library moves to another drive', () => {
  // Same files, same sizes, different drive: every id changes.
  const before = snapshotOf([
    comic('D:/Comics/Batman 001.cbz', 100, read(9, 12)),
    comic('D:/Comics/Batman 002.cbz', 200, read(3, 3)),
  ]);
  const after = snapshotOf([
    comic('E:/Media/Comics/Batman 001.cbz', 100),
    comic('E:/Media/Comics/Batman 002.cbz', 200),
  ]);
  assert.notEqual(before.comics[0].id, after.comics[0].id, 'ids must differ for this test to mean anything');

  const { snapshot, summary } = mergeImport(after, buildExport(before));

  assert.equal(summary.matched, 2);
  assert.equal(summary.matchedById, 0);
  assert.equal(summary.matchedByNameAndSize, 2);
  assert.equal(summary.progressUpdated, 2);
  assert.equal(snapshot.comics[0].state.furthestPage, 12);
  assert.equal(snapshot.comics[0].state.currentPage, 9);
  assert.equal(snapshot.comics[1].state.furthestPage, 3);
});

test('a re-compressed file still matches when its name is unique', () => {
  const before = snapshotOf([comic('D:/Comics/Watchmen 001.cbz', 100, read(5, 8))]);
  const after = snapshotOf([comic('D:/Comics/Watchmen 001.cbz', 999)]);

  const { snapshot, summary } = mergeImport(after, buildExport(before));
  assert.equal(summary.matchedByName, 1);
  assert.equal(snapshot.comics[0].state.furthestPage, 8);
});

test('ambiguous filenames never match across series', () => {
  // Two different series both containing "01.cbz" at different sizes.
  const before = snapshotOf([comic('D:/Comics/Saga/01.cbz', 100, read(20, 20))]);
  const after = snapshotOf([
    comic('E:/Saga/01.cbz', 555),
    comic('E:/Bone/01.cbz', 777),
  ]);

  const { snapshot, summary } = mergeImport(after, buildExport(before));
  assert.equal(summary.matched, 0, 'must not guess between two files called 01.cbz');
  assert.equal(summary.unmatched, 1);
  assert.equal(snapshot.comics[0].state.furthestPage, 0);
  assert.equal(snapshot.comics[1].state.furthestPage, 0);
});

test('importing an older backup never rewinds newer progress', () => {
  const backup = snapshotOf([comic('D:/Comics/Batman 001.cbz', 100, read(2, 2, { timeSpentMs: 5_000 }))]);
  const current = snapshotOf([comic('D:/Comics/Batman 001.cbz', 100, read(30, 40, { timeSpentMs: 90_000 }))]);

  const { snapshot, summary } = mergeImport(current, buildExport(backup));
  assert.equal(summary.matched, 1);
  assert.equal(summary.progressUpdated, 0, 'nothing should move backwards');
  assert.equal(snapshot.comics[0].state.furthestPage, 40);
  assert.equal(snapshot.comics[0].state.currentPage, 30);
  assert.equal(snapshot.comics[0].state.timeSpentMs, 90_000, 'time must not be summed or reduced');
});

test('a completed book stays completed', () => {
  const backup = snapshotOf([
    comic('D:/Comics/Maus.cbz', 100, { state: { currentPage: 0, furthestPage: 0, completed: true, timeSpentMs: 0 } }),
  ]);
  const current = snapshotOf([comic('D:/Comics/Maus.cbz', 100, read(5, 5))]);

  const { snapshot } = mergeImport(current, buildExport(backup));
  assert.equal(snapshot.comics[0].state.completed, true);
});

test('favourites, ratings, and tags merge rather than overwrite', () => {
  const backup = snapshotOf([
    comic('D:/Comics/Bone.cbz', 100, { favorite: true, rating: 5, tags: ['classic'] }),
  ]);
  const current = snapshotOf([
    comic('D:/Comics/Bone.cbz', 100, { favorite: false, rating: 2, tags: ['owned'] }),
  ]);

  const { snapshot } = mergeImport(current, buildExport(backup));
  assert.equal(snapshot.comics[0].favorite, true);
  assert.equal(snapshot.comics[0].rating, 5);
  assert.deepEqual([...snapshot.comics[0].tags].sort(), ['classic', 'owned']);
});

test('an import cannot shrink a library', () => {
  const backup = snapshotOf([comic('D:/Comics/A.cbz', 1)]);
  const current = snapshotOf([comic('D:/Comics/A.cbz', 1), comic('D:/Comics/B.cbz', 2)]);

  const { snapshot } = mergeImport(current, buildExport(backup));
  assert.equal(snapshot.comics.length, 2);
});

test('collections follow their comics to new ids', () => {
  const oldComic = comic('D:/Comics/Batman 001.cbz', 100);
  const backup: LibrarySnapshot = {
    ...snapshotOf([oldComic]),
    collections: [
      { id: 'queue', name: 'Want to read', comicIds: [oldComic.id], createdAt: 1_700_000_000_000 },
    ],
  };
  const moved = comic('E:/Comics/Batman 001.cbz', 100);
  const current = snapshotOf([moved]);

  const { snapshot, summary } = mergeImport(current, buildExport(backup));
  assert.equal(summary.collectionsAdded, 1);
  assert.deepEqual(snapshot.collections[0].comicIds, [moved.id], 'must point at the new id');
});

test('settings stay local unless explicitly asked for', () => {
  const backup: LibrarySnapshot = {
    ...snapshotOf([]),
    settings: { ...emptySnapshot().settings, theme: 'light', syncPort: 9999 },
  };
  const current = snapshotOf([]);

  const kept = mergeImport(current, buildExport(backup));
  assert.equal(kept.snapshot.settings.theme, 'dark');
  assert.equal(kept.summary.settingsApplied, false);

  const taken = mergeImport(current, buildExport(backup), { includeSettings: true });
  assert.equal(taken.snapshot.settings.theme, 'light');
  assert.equal(taken.snapshot.settings.syncPort, 9999);
  assert.equal(taken.summary.settingsApplied, true);
});

test('importing the same file twice changes nothing the second time', () => {
  const backup = snapshotOf([comic('D:/Comics/Batman 001.cbz', 100, read(9, 12))]);
  const current = snapshotOf([comic('D:/Comics/Batman 001.cbz', 100)]);

  const once = mergeImport(current, buildExport(backup));
  assert.equal(once.summary.progressUpdated, 1);

  const twice = mergeImport(once.snapshot, buildExport(backup));
  assert.equal(twice.summary.progressUpdated, 0, 'import must be idempotent');
});

test('the reading log merges by day and does not double on re-import', () => {
  const backup: LibrarySnapshot = {
    ...snapshotOf([]),
    activity: { '2026-08-01': 40, '2026-08-02': 10 },
  };
  const current: LibrarySnapshot = { ...snapshotOf([]), activity: { '2026-08-02': 25 } };

  const once = mergeImport(current, buildExport(backup));
  assert.deepEqual(once.snapshot.activity, { '2026-08-01': 40, '2026-08-02': 25 });
  assert.equal(once.summary.activityDaysMerged, 1);

  const twice = mergeImport(once.snapshot, buildExport(backup));
  assert.deepEqual(twice.snapshot.activity, { '2026-08-01': 40, '2026-08-02': 25 });
  assert.equal(twice.summary.activityDaysMerged, 0, 'must not accumulate');
});
