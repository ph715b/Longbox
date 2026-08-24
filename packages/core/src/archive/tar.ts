import type { ArchiveEntry, ComicArchive } from './types.ts';
import { ArchiveError } from './types.ts';
import { orderPages } from './pages.ts';

/**
 * A CBT reader. CBT is an uncompressed tar, which makes this the simplest
 * container of the lot: fixed 512-byte headers, data padded to 512-byte
 * boundaries, no compression to undo. Rare in the wild but trivial to support.
 */

const BLOCK = 512;

interface TarEntry extends ArchiveEntry {
  offset: number;
}

export class TarArchive implements ComicArchive {
  readonly format = 'cbt' as const;
  readonly entries: ArchiveEntry[];
  readonly pageEntries: string[];

  private readonly index = new Map<string, TarEntry>();
  private data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
    const parsed = this.readHeaders();
    for (const entry of parsed) this.index.set(entry.name, entry);
    this.entries = parsed.map(({ name, size }) => ({ name, size }));
    this.pageEntries = orderPages(parsed.map((entry) => entry.name));
  }

  private readHeaders(): TarEntry[] {
    const entries: TarEntry[] = [];
    const decoder = new TextDecoder('utf-8');
    let cursor = 0;

    while (cursor + BLOCK <= this.data.length) {
      const header = this.data.subarray(cursor, cursor + BLOCK);

      // Two consecutive zero blocks mark the end of the archive.
      if (header.every((byte) => byte === 0)) break;

      const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, '').trim();
      const sizeField = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim();
      const size = Number.parseInt(sizeField, 8);
      const typeFlag = String.fromCharCode(header[156] || 0x30);

      if (!name || !Number.isFinite(size)) break;

      // '0' and '\0' are regular files; everything else (dirs, links) is skipped.
      if (typeFlag === '0' || typeFlag === '\0') {
        entries.push({ name: name.replace(/\\/g, '/'), size, offset: cursor + BLOCK });
      }

      // Advance past the header and the file's data, rounded up to a block.
      cursor += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    }

    if (entries.length === 0) throw new ArchiveError('Tar archive contains no files');
    return entries;
  }

  async readPage(index: number): Promise<Uint8Array> {
    const name = this.pageEntries[index];
    if (name === undefined) throw new ArchiveError(`Page ${index} out of range`);
    const entry = this.index.get(name)!;
    return this.data.subarray(entry.offset, entry.offset + entry.size);
  }

  async readEntry(name: string): Promise<Uint8Array | undefined> {
    const entry = this.index.get(name);
    if (!entry) return undefined;
    return this.data.subarray(entry.offset, entry.offset + entry.size);
  }

  close(): void {
    this.index.clear();
    this.data = new Uint8Array(0);
  }
}

/** Tar has no leading magic; the `ustar` marker sits inside the first header. */
export function looksLikeTar(data: Uint8Array): boolean {
  if (data.length < 265) return false;
  const magic = String.fromCharCode(...data.subarray(257, 262));
  return magic === 'ustar';
}
