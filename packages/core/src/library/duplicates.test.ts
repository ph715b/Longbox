import { strict as assert } from 'node:assert';
import test from 'node:test';
import { duplicateWaste, findDuplicates } from './duplicates.ts';
import type { Comic } from '../types.ts';

let counter = 0;
function comic(overrides: Partial<Comic> & { filename: string }): Comic {
  counter += 1;
  return {
    id: `id-${counter}-${overrides.filename}`,
    path: `D:/Comics/${overrides.filename}`,
    format: 'cbz',
    size: 1_000_000,
    modifiedAt: 0,
    addedAt: counter,
    pageCount: 24,
    metadata: {},
    state: { currentPage: 0, furthestPage: 0, completed: false, timeSpentMs: 0 },
    tags: [],
    rating: 0,
    favorite: false,
    ...overrides,
  };
}

test('a library with no duplicates reports none', () => {
  const comics = [
    comic({ filename: 'A.cbz', size: 1, pageCount: 10 }),
    comic({ filename: 'B.cbz', size: 2, pageCount: 20 }),
  ];
  assert.deepEqual(findDuplicates(comics), []);
});

test('the classic "(1)" re-download is caught by size', () => {
  const comics = [
    comic({ filename: 'Batman 001.cbz', size: 5_000_000, pageCount: 24 }),
    comic({ filename: 'Batman 001(1).cbz', size: 5_000_000, pageCount: 24 }),
    comic({ filename: 'Unrelated.cbz', size: 9_000_000, pageCount: 30 }),
  ];
  const groups = findDuplicates(comics);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, 'identical-size');
  assert.equal(groups[0].comicIds.length, 2);
});

test('same byte count but a different page count is not a duplicate', () => {
  const comics = [
    comic({ filename: 'A.cbz', size: 5_000_000, pageCount: 24 }),
    comic({ filename: 'B.cbz', size: 5_000_000, pageCount: 48 }),
  ];
  assert.deepEqual(findDuplicates(comics), []);
});

test('a CBR replaced by a CBZ is caught by series and issue', () => {
  const comics = [
    comic({
      filename: 'Absolute Batman 001.cbr',
      format: 'cbr',
      size: 40_000_000,
      pageCount: 45,
      metadata: { series: 'Absolute Batman', issue: '1' },
    }),
    comic({
      filename: 'Absolute Batman 01 (2024).cbz',
      size: 46_000_000,
      pageCount: 45,
      metadata: { series: 'absolute  batman', issue: '1' },
    }),
  ];
  const groups = findDuplicates(comics);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, 'same-series-issue');
});

test('different issues of one series are never grouped', () => {
  const comics = [
    comic({ filename: 'A.cbz', size: 1, metadata: { series: 'Saga', issue: '1' } }),
    comic({ filename: 'B.cbz', size: 2, metadata: { series: 'Saga', issue: '2' } }),
  ];
  assert.deepEqual(findDuplicates(comics), []);
});

test('a cover hash outranks the weaker strategies and claims the comics once', () => {
  const comics = [
    comic({
      filename: 'Bone 001.cbz',
      size: 3_000_000,
      pageCount: 30,
      coverHash: 'abc',
      metadata: { series: 'Bone', issue: '1' },
    }),
    comic({
      filename: 'Bone 001 alt.cbr',
      format: 'cbr',
      size: 3_000_000,
      pageCount: 30,
      coverHash: 'abc',
      metadata: { series: 'Bone', issue: '1' },
    }),
  ];
  const groups = findDuplicates(comics);
  assert.equal(groups.length, 1, 'must not report the same pair three times');
  assert.equal(groups[0].reason, 'same-cover');
});

test('the best copy is listed first', () => {
  const truncated = comic({ filename: 'part.cbz', size: 1_000_000, pageCount: 6 });
  const complete = comic({ filename: 'full.cbz', size: 9_000_000, pageCount: 24 });
  const comics = [
    truncated,
    complete,
  ];
  // Force them into one group on a reason that ignores size and pages.
  truncated.metadata = { series: 'Maus', issue: '1' };
  complete.metadata = { series: 'Maus', issue: '1' };

  const groups = findDuplicates(comics);
  assert.equal(groups[0].comicIds[0], complete.id, 'more pages wins');
});

test('missing files are left out unless asked for', () => {
  const comics = [
    comic({ filename: 'A.cbz', size: 5_000_000, pageCount: 24 }),
    comic({ filename: 'A.cbz', size: 5_000_000, pageCount: 24, missing: true }),
  ];
  assert.deepEqual(findDuplicates(comics), []);
  assert.equal(findDuplicates(comics, { includeMissing: true }).length, 1);
});

test('comics without metadata cannot be grouped by series and issue', () => {
  const comics = [
    comic({ filename: 'A.cbz', size: 1, metadata: {} }),
    comic({ filename: 'B.cbz', size: 2, metadata: {} }),
  ];
  assert.deepEqual(findDuplicates(comics), []);
});

test('waste counts every copy but the one worth keeping', () => {
  const comics = [
    comic({ filename: 'A.cbz', size: 5_000_000, pageCount: 24 }),
    comic({ filename: 'B.cbz', size: 5_000_000, pageCount: 24 }),
    comic({ filename: 'C.cbz', size: 5_000_000, pageCount: 24 }),
  ];
  const groups = findDuplicates(comics);
  assert.equal(groups[0].comicIds.length, 3);
  assert.equal(duplicateWaste(groups, comics), 10_000_000);
});
