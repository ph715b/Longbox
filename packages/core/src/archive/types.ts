import type { ComicFormat } from '../types.ts';

/** One file inside a comic archive. */
export interface ArchiveEntry {
  /** Full path within the archive, using forward slashes. */
  name: string;
  /** Uncompressed size in bytes, when the container reports it. */
  size: number;
}

/**
 * A opened comic container.
 *
 * Implementations are lazy wherever the format allows: `entries` is cheap, and
 * page bytes are only decompressed when asked for. That keeps library scanning
 * fast, since a scan only ever needs page 0 for the cover thumbnail.
 */
export interface ComicArchive {
  readonly format: ComicFormat;
  /** Every file in the container, unfiltered and in stored order. */
  readonly entries: ArchiveEntry[];
  /** Image entries only, in reading order. */
  readonly pageEntries: string[];
  /** Decompress one page by its index in `pageEntries`. */
  readPage(index: number): Promise<Uint8Array>;
  /** Decompress an arbitrary entry by name; undefined when absent. */
  readEntry(name: string): Promise<Uint8Array | undefined>;
  /** Release any held resources. Safe to call more than once. */
  close(): void;
}

/** Thrown when a container is recognised but cannot be read. */
export class ArchiveError extends Error {
  constructor(message: string, cause?: unknown) {
    // `cause` is standard on Error, so there's no need for a own field.
    super(message, { cause });
    this.name = 'ArchiveError';
  }
}
