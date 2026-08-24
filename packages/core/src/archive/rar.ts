import { createExtractorFromData } from 'node-unrar-js';
import type { Extractor } from 'node-unrar-js';
import type { ArchiveEntry, ComicArchive } from './types.ts';
import { ArchiveError } from './types.ts';
import { orderPages } from './pages.ts';

/**
 * A CBR reader backed by the WebAssembly build of unrar.
 *
 * RAR is the awkward format: it's proprietary, and the only complete
 * implementation is the reference C one. `node-unrar-js` compiles that to wasm,
 * which is what lets the same code run in Electron and in an Android WebView
 * without a native module or a bundled `unrar.exe`.
 *
 * Unlike zip, RAR cannot cheaply seek to one member -- solid archives compress
 * files as a single stream, so pulling out page 40 means decompressing the 39
 * before it. We therefore cache extracted pages, since a reader almost always
 * walks forward through the whole book anyway.
 */
export class RarArchive implements ComicArchive {
  readonly format = 'cbr' as const;
  readonly entries: ArchiveEntry[];
  readonly pageEntries: string[];

  private cache = new Map<string, Uint8Array>();
  private extractor: Extractor<Uint8Array>;

  private constructor(extractor: Extractor<Uint8Array>) {
    this.extractor = extractor;
    const list = extractor.getFileList();
    const headers = [...list.fileHeaders];

    this.entries = headers
      .filter((header) => !header.flags.directory)
      .map((header) => ({
        name: header.name.replace(/\\/g, '/'),
        size: header.unpSize,
      }));

    if (this.entries.length === 0) throw new ArchiveError('RAR archive contains no files');
    this.pageEntries = orderPages(this.entries.map((entry) => entry.name));
  }

  static async open(data: Uint8Array): Promise<RarArchive> {
    try {
      // The extractor needs a standalone ArrayBuffer, not a view into a larger
      // one, so slice when the input is a subarray of a bigger allocation.
      const buffer =
        data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
          ? (data.buffer as ArrayBuffer)
          : (data.slice().buffer as ArrayBuffer);
      const extractor = await createExtractorFromData({ data: buffer });
      return new RarArchive(extractor);
    } catch (cause) {
      if (cause instanceof ArchiveError) throw cause;
      throw new ArchiveError('Could not open RAR archive', cause);
    }
  }

  /**
   * Extract one member. Names are matched against the archive's own spelling,
   * which uses backslashes on archives made by Windows tools.
   */
  private extractByName(name: string): Uint8Array {
    const cached = this.cache.get(name);
    if (cached) return cached;

    try {
      // Ask for both slash spellings; unrar matches literally.
      const wanted = [name, name.replace(/\//g, '\\')];
      const result = this.extractor.extract({ files: wanted });

      let found: Uint8Array | undefined;
      for (const file of result.files) {
        const key = file.fileHeader.name.replace(/\\/g, '/');
        if (file.extraction) {
          this.cache.set(key, file.extraction);
          if (key === name) found = file.extraction;
        }
      }

      if (!found) throw new ArchiveError(`Entry "${name}" not found in RAR archive`);
      return found;
    } catch (cause) {
      if (cause instanceof ArchiveError) throw cause;
      throw new ArchiveError(`Failed to extract "${name}" from RAR archive`, cause);
    }
  }

  async readPage(index: number): Promise<Uint8Array> {
    const name = this.pageEntries[index];
    if (name === undefined) throw new ArchiveError(`Page ${index} out of range`);
    return this.extractByName(name);
  }

  async readEntry(name: string): Promise<Uint8Array | undefined> {
    if (!this.entries.some((entry) => entry.name === name)) return undefined;
    return this.extractByName(name);
  }

  close(): void {
    this.cache.clear();
  }
}
