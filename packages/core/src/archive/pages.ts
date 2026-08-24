/**
 * Turning a bag of archive entries into an ordered list of pages.
 *
 * Comic archives are just folders in a zip, with no page-order metadata, so
 * order comes entirely from filenames. Two things go wrong if you sort them
 * naively: plain lexicographic sort puts page 10 before page 2, and archives
 * routinely carry non-page files (credits, junk, macOS resource forks) that
 * would otherwise show up as blank or broken pages.
 */

/** Extensions we can decode as a page image in both Chromium and Android WebView. */
const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'jfif', 'jpe',
]);

/**
 * Entries that are never pages. `__MACOSX` holds resource forks that mirror
 * every real filename, so without this a Mac-made archive shows each page twice.
 */
const JUNK_PATTERNS = [
  /(^|\/)__MACOSX\//i,
  /(^|\/)\._/,           // AppleDouble sidecar files
  /(^|\/)\.DS_Store$/i,
  /(^|\/)Thumbs\.db$/i,
  /(^|\/)desktop\.ini$/i,
];

/** Sidecar metadata files, extracted separately rather than shown as pages. */
export const METADATA_ENTRIES = ['comicinfo.xml', 'series.json', 'book.json'];

export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

export function isImageEntry(name: string): boolean {
  if (name.endsWith('/')) return false;
  if (JUNK_PATTERNS.some((pattern) => pattern.test(name))) return false;
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

export function isMetadataEntry(name: string): boolean {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
  return METADATA_ENTRIES.includes(base);
}

/**
 * Compare two paths the way a person would read them, so "page2" precedes
 * "page10". Digit runs compare numerically, everything else compares as
 * case-insensitive text.
 *
 * Directory depth is respected first: an archive with `ch01/` and `ch02/`
 * folders must not interleave their pages just because the leaf names collide.
 */
export function naturalCompare(a: string, b: string): number {
  const aParts = a.split('/');
  const bParts = b.split('/');

  // Compare directory segments before filenames.
  const shared = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < shared; i += 1) {
    // The last segment of either path is a filename, not a directory; only
    // compare like with like once one path has run out of directories.
    const result = compareSegment(aParts[i], bParts[i]);
    if (result !== 0) return result;
  }
  return aParts.length - bParts.length;
}

function compareSegment(a: string, b: string): number {
  const chunks = /(\d+)|(\D+)/g;
  const aChunks = a.toLowerCase().match(chunks) ?? [];
  const bChunks = b.toLowerCase().match(chunks) ?? [];

  const shared = Math.min(aChunks.length, bChunks.length);
  for (let i = 0; i < shared; i += 1) {
    const aChunk = aChunks[i];
    const bChunk = bChunks[i];
    const aNum = /^\d/.test(aChunk);
    const bNum = /^\d/.test(bChunk);

    if (aNum && bNum) {
      // Compare as numbers so zero-padding is irrelevant.
      const diff = Number.parseInt(aChunk, 10) - Number.parseInt(bChunk, 10);
      if (diff !== 0) return diff;
      // Same value, different padding ("01" vs "1"): keep it deterministic.
      if (aChunk.length !== bChunk.length) return aChunk.length - bChunk.length;
    } else if (aChunk !== bChunk) {
      return aChunk < bChunk ? -1 : 1;
    }
  }
  return aChunks.length - bChunks.length;
}

/** Filter an entry list down to pages, in reading order. */
export function orderPages(entryNames: string[]): string[] {
  return entryNames.filter(isImageEntry).sort(naturalCompare);
}
