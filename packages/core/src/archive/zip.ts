import { inflateSync } from 'fflate';
import type { ArchiveEntry, ComicArchive } from './types.ts';
import { ArchiveError } from './types.ts';
import { orderPages } from './pages.ts';

/**
 * A lazy CBZ reader.
 *
 * fflate can unzip a whole archive in one call, but that decompresses every
 * page up front -- wasteful when a library scan only wants the cover, and
 * memory-hostile on a 300MB collected edition. So we parse the zip central
 * directory ourselves to build an index of offsets, then inflate individual
 * entries on demand. The format is stable and the parsing is short.
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

interface ZipEntry extends ArchiveEntry {
  compressedSize: number;
  method: number;
  localHeaderOffset: number;
}

export class ZipArchive implements ComicArchive {
  readonly format = 'cbz' as const;
  readonly entries: ArchiveEntry[];
  readonly pageEntries: string[];

  private readonly view: DataView;
  private readonly index = new Map<string, ZipEntry>();
  private data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const parsed = this.readCentralDirectory();
    for (const entry of parsed) this.index.set(entry.name, entry);
    this.entries = parsed.map(({ name, size }) => ({ name, size }));
    this.pageEntries = orderPages(parsed.map((e) => e.name));
  }

  /** Locate the End Of Central Directory record by scanning backwards. */
  private findEocd(): number {
    // The EOCD is last, but a trailing comment of up to 64KB can follow it.
    const minSize = 22;
    const searchStart = Math.max(0, this.data.length - (minSize + 0xffff));
    for (let i = this.data.length - minSize; i >= searchStart; i -= 1) {
      if (this.view.getUint32(i, true) === SIG_EOCD) return i;
    }
    throw new ArchiveError('Not a zip file: no end-of-central-directory record');
  }

  private readCentralDirectory(): ZipEntry[] {
    const eocd = this.findEocd();
    let entryCount = this.view.getUint16(eocd + 10, true);
    let directoryOffset = this.view.getUint32(eocd + 16, true);

    // Zip64: the 32-bit fields saturate and the real values live in a separate
    // record. Rare for comics, but a large omnibus can trip it.
    if (directoryOffset === 0xffffffff || entryCount === 0xffff) {
      const locator = eocd - 20;
      if (locator >= 0 && this.view.getUint32(locator, true) === SIG_EOCD64_LOCATOR) {
        const eocd64 = Number(this.view.getBigUint64(locator + 8, true));
        if (this.view.getUint32(eocd64, true) === SIG_EOCD64) {
          entryCount = Number(this.view.getBigUint64(eocd64 + 32, true));
          directoryOffset = Number(this.view.getBigUint64(eocd64 + 48, true));
        }
      }
    }

    const entries: ZipEntry[] = [];
    let cursor = directoryOffset;

    for (let i = 0; i < entryCount; i += 1) {
      if (cursor + 46 > this.data.length) break;
      if (this.view.getUint32(cursor, true) !== SIG_CENTRAL) break;

      const method = this.view.getUint16(cursor + 10, true);
      const compressedSize = this.view.getUint32(cursor + 20, true);
      const uncompressedSize = this.view.getUint32(cursor + 24, true);
      const nameLength = this.view.getUint16(cursor + 28, true);
      const extraLength = this.view.getUint16(cursor + 30, true);
      const commentLength = this.view.getUint16(cursor + 32, true);
      const localHeaderOffset = this.view.getUint32(cursor + 42, true);

      const nameBytes = this.data.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = decodeEntryName(nameBytes);

      // Directory records have no content; skip them rather than indexing them.
      if (!name.endsWith('/')) {
        entries.push({
          name,
          size: uncompressedSize,
          compressedSize,
          method,
          localHeaderOffset,
        });
      }

      cursor += 46 + nameLength + extraLength + commentLength;
    }

    if (entries.length === 0) throw new ArchiveError('Zip archive contains no files');
    return entries;
  }

  private extract(entry: ZipEntry): Uint8Array {
    const base = entry.localHeaderOffset;
    if (this.view.getUint32(base, true) !== SIG_LOCAL) {
      throw new ArchiveError(`Corrupt local header for "${entry.name}"`);
    }
    // The local header repeats the name and extra fields, and its extra-field
    // length can differ from the central directory's -- so read it here.
    const nameLength = this.view.getUint16(base + 26, true);
    const extraLength = this.view.getUint16(base + 28, true);
    const start = base + 30 + nameLength + extraLength;
    const raw = this.data.subarray(start, start + entry.compressedSize);

    switch (entry.method) {
      case METHOD_STORE:
        return raw;
      case METHOD_DEFLATE:
        try {
          // Pass the expected size so fflate can allocate once.
          return inflateSync(raw, { out: new Uint8Array(entry.size) });
        } catch (cause) {
          throw new ArchiveError(`Failed to inflate "${entry.name}"`, cause);
        }
      default:
        throw new ArchiveError(
          `"${entry.name}" uses unsupported zip compression method ${entry.method}`,
        );
    }
  }

  async readPage(index: number): Promise<Uint8Array> {
    const name = this.pageEntries[index];
    if (name === undefined) throw new ArchiveError(`Page ${index} out of range`);
    return this.extract(this.index.get(name)!);
  }

  async readEntry(name: string): Promise<Uint8Array | undefined> {
    const entry = this.index.get(name);
    return entry ? this.extract(entry) : undefined;
  }

  close(): void {
    this.index.clear();
    // Drop the reference so the buffer can be collected while the object lives.
    this.data = new Uint8Array(0);
  }
}

/**
 * Zip stores names as either CP437 or UTF-8, flagged per entry. Decoding UTF-8
 * unconditionally is right often enough, but mangles accented CP437 names, so
 * fall back when the bytes are not valid UTF-8.
 */
function decodeEntryName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\\/g, '/');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes).replace(/\\/g, '/');
  }
}
