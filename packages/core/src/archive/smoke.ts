import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { openArchive, sniffFormat, isMetadataEntry } from './index.ts';

/**
 * Opens real comic files and reports what the archive layer found. Not a unit
 * test -- a smoke check to run against actual downloads, since archive bugs
 * only ever show up on files made by tools we don't control.
 *
 * Usage: node --experimental-strip-types smoke.ts <file> [<file> ...]
 */

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: smoke.ts <comic file> [...]');
  process.exit(2);
}

for (const target of targets) {
  const label = basename(target);
  console.log(`\n=== ${label}`);

  try {
    const data = new Uint8Array(await readFile(target));
    console.log(`    size:      ${(data.length / 1024 / 1024).toFixed(1)} MB`);
    console.log(`    sniffed:   ${sniffFormat(data) ?? 'unknown'}`);

    const started = performance.now();
    const { archive, actualFormat, claimedFormat } = await openArchive(data, label);
    const openMs = performance.now() - started;

    if (claimedFormat && claimedFormat !== actualFormat) {
      console.log(`    MISLABELED: named .${claimedFormat}, actually ${actualFormat}`);
    }
    console.log(`    opened in: ${openMs.toFixed(0)} ms`);
    console.log(`    entries:   ${archive.entries.length}`);
    console.log(`    pages:     ${archive.pageEntries.length}`);

    const metadata = archive.entries.filter((entry) => isMetadataEntry(entry.name));
    console.log(`    metadata:  ${metadata.map((m) => m.name).join(', ') || 'none'}`);

    console.log('    first 3 pages in reading order:');
    for (const name of archive.pageEntries.slice(0, 3)) console.log(`      ${name}`);
    if (archive.pageEntries.length > 3) {
      console.log(`      ... last: ${archive.pageEntries.at(-1)}`);
    }

    // Decode the cover to prove extraction actually works, not just indexing.
    const pageStart = performance.now();
    const cover = await archive.readPage(0);
    const pageMs = performance.now() - pageStart;
    const magic = [...cover.subarray(0, 4)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' ');
    console.log(
      `    cover:     ${(cover.length / 1024).toFixed(0)} KB in ${pageMs.toFixed(0)} ms (magic ${magic})`,
    );

    // A page from the middle exercises the non-sequential path.
    if (archive.pageEntries.length > 2) {
      const middle = Math.floor(archive.pageEntries.length / 2);
      const midStart = performance.now();
      const page = await archive.readPage(middle);
      console.log(
        `    page ${middle}:    ${(page.length / 1024).toFixed(0)} KB in ${(performance.now() - midStart).toFixed(0)} ms`,
      );
    }

    archive.close();
    console.log('    OK');
  } catch (error) {
    console.log(`    FAILED: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && 'cause' in error && error.cause) {
      console.log(`    cause: ${String(error.cause).slice(0, 300)}`);
    }
  }
}
