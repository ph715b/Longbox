import { strict as assert } from 'node:assert';
import test from 'node:test';
import { groupIntoSeries } from './grouping.ts';
import type { Comic } from '../types.ts';

let counter = 0;
function comic(series: string, issue: string, overrides: Partial<Comic> = {}): Comic {
  counter += 1;
  return {
    id: `id-${counter}`,
    path: `D:/Comics/${series} ${issue}.cbz`,
    filename: `${series} ${issue}.cbz`,
    format: 'cbz',
    size: 1000,
    modifiedAt: 0,
    addedAt: counter,
    pageCount: 24,
    metadata: { series, issue, issueNumber: Number(issue) },
    state: { currentPage: 0, furthestPage: 0, completed: false, timeSpentMs: 0 },
    tags: [],
    rating: 0,
    favorite: false,
    ...overrides,
  };
}

test('a series counts only the issues still on disk', () => {
  const [series] = groupIntoSeries([
    comic('Absolute Batman', '1', { missing: true }),
    comic('Absolute Batman', '23'),
  ]);

  assert.equal(series.issueCount, 1);
  assert.equal(series.missingCount, 1);
});

test('the series cover skips a missing issue', () => {
  // #1 sorts first but its file has gone, so it cannot represent the series.
  const gone = comic('Absolute Batman', '1', { missing: true });
  const present = comic('Absolute Batman', '23');
  const [series] = groupIntoSeries([gone, present]);

  assert.equal(series.coverComicId, present.id, 'must not point at a file that is not there');
});

test('a completed issue that has gone missing is not counted as read', () => {
  const [series] = groupIntoSeries([
    comic('Bone', '1', {
      missing: true,
      state: { currentPage: 0, furthestPage: 30, completed: true, timeSpentMs: 0 },
    }),
    comic('Bone', '2'),
  ]);

  assert.equal(series.readCount, 0);
  assert.equal(series.issueCount, 1);
});

test('a series whose issues have all gone still exists, reporting zero present', () => {
  const [series] = groupIntoSeries([
    comic('Saga', '1', { missing: true }),
    comic('Saga', '2', { missing: true }),
  ]);

  assert.equal(series.issueCount, 0);
  assert.equal(series.missingCount, 2);
  assert.notEqual(series.coverComicId, undefined, 'the series is still addressable');
});

test('missing issues keep their series id so their history stays attached', () => {
  const gone = comic('Watchmen', '1', { missing: true });
  const [series] = groupIntoSeries([gone, comic('Watchmen', '2')]);

  assert.equal(gone.seriesId, series.id);
});

test('a library with nothing missing is unaffected', () => {
  const [series] = groupIntoSeries([comic('Maus', '1'), comic('Maus', '2')]);
  assert.equal(series.issueCount, 2);
  assert.equal(series.missingCount, 0);
});
