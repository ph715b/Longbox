import { strict as assert } from 'node:assert';
import test from 'node:test';
import { normaliseSeriesName, seriesId, comicId, coverHash } from './id.ts';

test('punctuation does not split one series into two', () => {
  const same: [string, string][] = [
    ["Batman Superman World's Finest", 'Batman Superman Worlds Finest'],
    ["Ra's al Ghul", 'Ras al Ghul'],
    ['The Amazing Spider-Man', 'Amazing Spider Man'],
    ['Hawkeye & Mockingbird', 'Hawkeye and Mockingbird'],
  ];

  for (const [a, b] of same) {
    assert.equal(normaliseSeriesName(a), normaliseSeriesName(b), `${a} vs ${b}`);
    assert.equal(seriesId(a), seriesId(b), `ids for ${a} vs ${b}`);
  }
});

test('genuinely different series stay apart', () => {
  const different: [string, string][] = [
    ['Batman', 'Batman Beyond'],
    ['X-Men', 'X-Force'],
    ['Saga', 'Saga of the Swamp Thing'],
  ];
  for (const [a, b] of different) {
    assert.notEqual(normaliseSeriesName(a), normaliseSeriesName(b), `${a} vs ${b}`);
  }
});

/**
 * Abbreviation dots are not folded away. "G.I. Joe" and "GI Joe" stay separate,
 * because collapsing them would need the separators removed entirely, and that
 * merges names that genuinely differ. Recorded here so the behaviour is a
 * decision rather than a surprise.
 */
test('abbreviation dots are left alone', () => {
  assert.notEqual(normaliseSeriesName('G.I. Joe'), normaliseSeriesName('GI Joe'));
});

test('a comic id ignores separator style and case, as Windows does', () => {
  const forward = comicId('D:/Comics/Batman 001.cbz', 100);
  const backward = comicId(String.raw`d:\comics\Batman 001.cbz`, 100);
  assert.equal(forward, backward, 'the same file reached two ways is one comic');

  assert.notEqual(
    comicId('D:/Comics/Batman 001.cbz', 100),
    comicId('D:/Comics/Batman 001.cbz', 101),
    'a different size is a different file',
  );
});

test('cover fingerprints separate different images and match identical ones', () => {
  const a = new Uint8Array(200_000).fill(7);
  const b = new Uint8Array(200_000).fill(7);
  const different = new Uint8Array(200_000).fill(8);
  const shorter = new Uint8Array(100_000).fill(7);

  assert.equal(coverHash(a), coverHash(b), 'identical bytes must agree');
  assert.notEqual(coverHash(a), coverHash(different), 'different bytes must differ');
  // Only a prefix is sampled, so length has to be mixed in or these collide.
  assert.notEqual(coverHash(a), coverHash(shorter), 'length must be part of it');
});
