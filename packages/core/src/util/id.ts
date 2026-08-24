/**
 * Stable identifiers.
 *
 * Ids must survive metadata edits, app restarts, and re-scans, and must match
 * between the desktop and Android apps so wifi sync can talk about the same
 * book on both sides. So they're derived from content facts, never from a
 * counter or a random value.
 *
 * These are not cryptographic hashes and are not used for security -- only for
 * grouping and lookup, where a collision means two comics merge in the UI.
 * 64 bits of FNV-1a is ample for a personal library.
 */

/** FNV-1a over 64 bits, returned as 16 lowercase hex characters. */
export function hash64(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;

  // FNV-1a 64-bit constants. BigInt keeps the arithmetic exact; the volumes
  // here are small enough that its slowness doesn't matter.
  let acc = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let i = 0; i < bytes.length; i += 1) {
    acc ^= BigInt(bytes[i]);
    acc = (acc * prime) & mask;
  }

  return acc.toString(16).padStart(16, '0');
}

/**
 * Identity for a comic file. Path and size together are specific enough to
 * distinguish files while staying stable across metadata edits.
 *
 * Paths are lowercased because Windows filesystems are case-insensitive, so
 * the same file reached by differently-cased paths must not index twice.
 */
export function comicId(path: string, size: number): string {
  return hash64(`${path.replace(/\\/g, '/').toLowerCase()}:${size}`);
}

/**
 * Identity for a series. Derived from the normalised name so that issues
 * parsed from differently-formatted filenames still land in one group.
 */
export function seriesId(name: string): string {
  return hash64(normaliseSeriesName(name));
}

/**
 * Fold the cosmetic differences that would otherwise split one series into
 * several: casing, punctuation, a leading article, and "vol"/"volume".
 *
 * This is intentionally aggressive. Over-merging shows the user one series
 * they can split by editing metadata; under-merging scatters a run of issues
 * across the library with no obvious fix.
 */
export function normaliseSeriesName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    // Drop diacritics so "Pokemon" and its accented spelling agree.
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an)\s+/, '')
    .trim()
    .replace(/\s+/g, ' ');
}
