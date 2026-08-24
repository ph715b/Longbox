import { XMLParser } from 'fast-xml-parser';
import type { ComicMetadata, ReadingDirection } from '../types.ts';

/**
 * Reader for ComicInfo.xml, the de-facto metadata standard that ComicRack
 * established and most taggers still write. When a file has one it is far more
 * trustworthy than anything guessed from the filename, so it wins the merge.
 *
 * The schema is loose in practice: writers disagree on casing, empty elements
 * are common, and list fields are comma-separated strings rather than repeated
 * elements. We normalise all of that here so the rest of the app sees clean
 * data.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  trimValues: true,
  // Keep everything as strings; we do our own numeric coercion so that a
  // malformed "Year" doesn't silently become NaN deep in the UI.
  parseTagValue: false,
  parseAttributeValue: false,
});

/** Case-insensitive field lookup, since writers disagree on casing. */
function field(node: Record<string, unknown>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(node)) {
    if (key.toLowerCase() !== target) continue;
    if (value === null || value === undefined) return undefined;
    // An empty element parses to an empty object, which means "absent".
    if (typeof value === 'object') return undefined;
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function numberField(node: Record<string, unknown>, name: string): number | undefined {
  const raw = field(node, name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  // ComicRack writes -1 for "unset" in several numeric fields.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Split a comma-separated list field, dropping blanks. */
function listField(node: Record<string, unknown>, name: string): string[] | undefined {
  const raw = field(node, name);
  if (!raw) return undefined;
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Join the several credit fields that all mean "who drew this". */
function creditField(node: Record<string, unknown>, ...names: string[]): string | undefined {
  const found = names.map((name) => field(node, name)).filter(Boolean);
  return found.length > 0 ? found.join(', ') : undefined;
}

/**
 * Parse ComicInfo.xml bytes into our metadata shape.
 * Returns undefined when the payload isn't a usable ComicInfo document, so
 * callers can fall back to the filename guess.
 */
export function parseComicInfo(data: Uint8Array | string): ComicMetadata | undefined {
  let text = typeof data === 'string' ? data : decodeXml(data);
  if (!text.trim()) return undefined;

  // Strip a UTF-8 BOM, which fast-xml-parser treats as content.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  // The root element is `ComicInfo`, but tolerate casing variants.
  const rootKey = Object.keys(doc).find((key) => key.toLowerCase() === 'comicinfo');
  if (!rootKey) return undefined;
  const root = doc[rootKey];
  if (!root || typeof root !== 'object') return undefined;
  const node = root as Record<string, unknown>;

  const meta: ComicMetadata = {};

  const series = field(node, 'Series');
  if (series) meta.series = series;

  const number = field(node, 'Number');
  if (number) {
    meta.issue = number;
    const parsed = Number.parseFloat(number);
    if (Number.isFinite(parsed)) meta.issueNumber = parsed;
  }

  const title = field(node, 'Title');
  if (title) meta.title = title;

  const volume = field(node, 'Volume');
  if (volume) meta.volume = volume;

  const count = numberField(node, 'Count');
  if (count !== undefined) meta.count = count;

  const year = numberField(node, 'Year');
  if (year !== undefined && year > 1000) meta.year = year;

  const month = numberField(node, 'Month');
  if (month !== undefined && month >= 1 && month <= 12) meta.month = month;

  const publisher = field(node, 'Publisher');
  if (publisher) meta.publisher = publisher;

  const writer = creditField(node, 'Writer', 'Script');
  if (writer) meta.writer = writer;

  const penciller = creditField(node, 'Penciller', 'Artist');
  if (penciller) meta.penciller = penciller;

  const coverArtist = field(node, 'CoverArtist');
  if (coverArtist) meta.coverArtist = coverArtist;

  const summary = field(node, 'Summary');
  if (summary) meta.summary = summary;

  const genre = listField(node, 'Genre');
  if (genre) meta.genre = genre;

  const characters = listField(node, 'Characters');
  if (characters) meta.characters = characters;

  const ageRating = field(node, 'AgeRating');
  if (ageRating && ageRating.toLowerCase() !== 'unknown') meta.ageRating = ageRating;

  const direction = readingDirection(node);
  if (direction) meta.direction = direction;

  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * The `Manga` element doubles as the reading-direction flag: the value
 * "YesAndRightToLeft" is how ComicRack marks a book that pages right-to-left.
 */
function readingDirection(node: Record<string, unknown>): ReadingDirection | undefined {
  const manga = field(node, 'Manga');
  if (!manga) return undefined;
  return manga.toLowerCase() === 'yesandrighttoleft' ? 'rtl' : undefined;
}

/**
 * ComicInfo.xml is usually UTF-8, but Windows taggers sometimes emit UTF-16
 * with a BOM. Detect that rather than producing a string full of NUL bytes.
 */
function decodeXml(data: Uint8Array): string {
  if (data.length >= 2) {
    if (data[0] === 0xff && data[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(data);
    }
    if (data[0] === 0xfe && data[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(data);
    }
  }
  return new TextDecoder('utf-8').decode(data);
}

/**
 * Serialise metadata back to ComicInfo.xml, for writing user edits into the
 * archive so other readers (and a future re-scan) can see them.
 */
export function buildComicInfo(meta: ComicMetadata): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
  ];

  const put = (tag: string, value: string | number | undefined): void => {
    if (value === undefined || value === '') return;
    lines.push(`  <${tag}>${escapeXml(String(value))}</${tag}>`);
  };

  put('Series', meta.series);
  put('Number', meta.issue);
  put('Title', meta.title);
  put('Volume', meta.volume);
  put('Count', meta.count);
  put('Year', meta.year);
  put('Month', meta.month);
  put('Publisher', meta.publisher);
  put('Writer', meta.writer);
  put('Penciller', meta.penciller);
  put('CoverArtist', meta.coverArtist);
  put('Summary', meta.summary);
  put('Genre', meta.genre?.join(', '));
  put('Characters', meta.characters?.join(', '));
  put('AgeRating', meta.ageRating);
  if (meta.direction === 'rtl') put('Manga', 'YesAndRightToLeft');

  lines.push('</ComicInfo>');
  return lines.join('\n');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
