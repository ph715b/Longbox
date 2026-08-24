import { parseFilename, formatComicTitle } from './filename.ts';

/**
 * Table-driven checks for the filename parser. Each case lists only the fields
 * that matter; anything unlisted is not asserted, so adding a new extracted
 * field doesn't break every case.
 */
const CASES: { file: string; expect: Record<string, unknown> }[] = [
  // The real file sitting in the user's Downloads folder.
  {
    file: 'Absolute Batman 001 (2024) (Webrip) (The Last Kryptonian-DCP).cbr',
    expect: { series: 'Absolute Batman', issue: '1', issueNumber: 1, year: 2024 },
  },
  // Volume-based collected edition.
  {
    file: 'Saga v01 (2012) (Digital) (Zone-Empire).cbz',
    expect: { series: 'Saga', volume: '1', issue: '1', year: 2012 },
  },
  // Explicit hash marker.
  {
    file: 'The Amazing Spider-Man #700 (2013).cbz',
    expect: { series: 'The Amazing Spider-Man', issue: '700', issueNumber: 700, year: 2013 },
  },
  // Issue plus a story title.
  {
    file: 'Batman 012 - The Long Halloween (2019).cbz',
    expect: { series: 'Batman', issue: '12', title: 'The Long Halloween', year: 2019 },
  },
  // Special issue keeps its word.
  {
    file: 'Detective Comics Annual 1 (2018).cbz',
    expect: { series: 'Detective Comics', issue: 'Annual 1', issueNumber: 1 },
  },
  // Manga chapter with a volume in brackets.
  {
    file: 'One Piece c1000 (v99) [Group].cbz',
    expect: { series: 'One Piece', issue: '1000', volume: '99' },
  },
  // Year appears before the issue number.
  {
    file: 'Watchmen (1986) 001.cbz',
    expect: { series: 'Watchmen', issue: '1', year: 1986 },
  },
  // Decimal issue numbers are real and must sort correctly.
  {
    file: 'Saga of the Swamp Thing 020.5 (1984).cbz',
    expect: { series: 'Saga of the Swamp Thing', issue: '20.5', issueNumber: 20.5 },
  },
  // Series name that genuinely ends in a word-number.
  {
    file: 'Fantastic Four 001 (1961).cbz',
    expect: { series: 'Fantastic Four', issue: '1', year: 1961 },
  },
  // Underscores instead of spaces, no brackets at all.
  {
    file: 'Invincible_Compendium_One.cbz',
    expect: { series: 'Invincible One' },
  },
  // Chapter word spelled out.
  {
    file: 'Chainsaw Man - Chapter 097.cbz',
    expect: { series: 'Chainsaw Man', issue: '97' },
  },
  // No recognisable issue at all: series should still survive.
  {
    file: 'Maus.cbz',
    expect: { series: 'Maus' },
  },
];

let failures = 0;
let checks = 0;

for (const testCase of CASES) {
  const actual = parseFilename(testCase.file) as Record<string, unknown>;
  const problems: string[] = [];

  for (const [key, want] of Object.entries(testCase.expect)) {
    checks += 1;
    const got = actual[key];
    if (got !== want) {
      problems.push(`    ${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }

  if (problems.length > 0) {
    failures += 1;
    console.log(`FAIL  ${testCase.file}`);
    console.log(problems.join('\n'));
    console.log(`    full: ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok    ${testCase.file}`);
    console.log(`        -> ${formatComicTitle(actual as never, testCase.file)}`);
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} cases passed (${checks} field checks)`);
if (failures > 0) process.exitCode = 1;
