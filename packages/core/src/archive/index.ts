import type { ComicFormat } from '../types.ts';
import type { ComicArchive } from './types.ts';
import { ArchiveError } from './types.ts';
import { ZipArchive } from './zip.ts';
import { RarArchive } from './rar.ts';
import { TarArchive, looksLikeTar } from './tar.ts';

export * from './types.ts';
export * from './pages.ts';
export { ZipArchive } from './zip.ts';
export { RarArchive } from './rar.ts';
export { TarArchive } from './tar.ts';

/**
 * Identify a container by its leading bytes.
 *
 * The extension is a hint, not a fact. Files named `.cbr` that are really zips
 * are extremely common -- repackagers rename without recompressing -- and are
 * the single biggest cause of "this comic won't open" in other readers. So we
 * always sniff, and only fall back to the extension when the bytes are
 * inconclusive.
 */
export function sniffFormat(data: Uint8Array): ComicFormat | undefined {
  if (data.length < 8) return undefined;

  const b = data;

  // Zip: "PK\x03\x04". Empty and spanned archives use \x05\x06 and \x07\x08.
  if (b[0] === 0x50 && b[1] === 0x4b) {
    const third = b[2];
    const fourth = b[3];
    const isZip =
      (third === 0x03 && fourth === 0x04) ||
      (third === 0x05 && fourth === 0x06) ||
      (third === 0x07 && fourth === 0x08);
    if (isZip) return 'cbz';
  }

  // RAR v1.5-4.x: "Rar!\x1a\x07\x00"; RAR v5: "Rar!\x1a\x07\x01\x00".
  if (b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 &&
      b[4] === 0x1a && b[5] === 0x07) {
    return 'cbr';
  }

  // 7z: "7z\xbc\xaf\x27\x1c".
  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf &&
      b[4] === 0x27 && b[5] === 0x1c) {
    return 'cb7';
  }

  // PDF: "%PDF".
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return 'pdf';
  }

  if (looksLikeTar(b)) return 'cbt';

  return undefined;
}

/** Map a filename extension to the format it claims to be. */
export function formatFromExtension(filename: string): ComicFormat | undefined {
  const match = filename.toLowerCase().match(/\.(cbz|cbr|cb7|cbt|pdf|zip|rar|7z|tar)$/);
  if (!match) return undefined;
  switch (match[1]) {
    case 'cbz':
    case 'zip':
      return 'cbz';
    case 'cbr':
    case 'rar':
      return 'cbr';
    case 'cb7':
    case '7z':
      return 'cb7';
    case 'cbt':
    case 'tar':
      return 'cbt';
    case 'pdf':
      return 'pdf';
    default:
      return undefined;
  }
}

/** Extensions the library scanner should pick up. */
export const SUPPORTED_EXTENSIONS = ['cbz', 'cbr', 'cb7', 'cbt', 'pdf'] as const;

export interface OpenResult {
  archive: ComicArchive;
  /** What the bytes actually were. */
  actualFormat: ComicFormat;
  /** What the filename claimed. Differs from `actualFormat` on mislabeled files. */
  claimedFormat?: ComicFormat;
}

/**
 * Open a comic container from its bytes.
 *
 * PDFs are deliberately not handled here: decoding them needs pdf.js, which is
 * large and renderer-only, so the desktop and Android apps wrap them at the UI
 * layer instead of in this shared, environment-free module.
 */
export async function openArchive(data: Uint8Array, filename = ''): Promise<OpenResult> {
  const claimedFormat = formatFromExtension(filename);
  const sniffed = sniffFormat(data);
  const actualFormat = sniffed ?? claimedFormat;

  if (!actualFormat) {
    throw new ArchiveError(
      `Unrecognised file format${filename ? ` for "${filename}"` : ''}`,
    );
  }

  switch (actualFormat) {
    case 'cbz':
      return { archive: new ZipArchive(data), actualFormat, claimedFormat };
    case 'cbr':
      return { archive: await RarArchive.open(data), actualFormat, claimedFormat };
    case 'cbt':
      return { archive: new TarArchive(data), actualFormat, claimedFormat };
    case 'cb7':
      throw new ArchiveError(
        '7-Zip comics (.cb7) are not supported yet. Convert it to .cbz to read it.',
      );
    case 'pdf':
      throw new ArchiveError('PDFs are opened by the reader, not the archive layer');
    default:
      throw new ArchiveError(`Unsupported format "${actualFormat}"`);
  }
}
