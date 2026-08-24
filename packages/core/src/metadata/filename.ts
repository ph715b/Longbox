import type { ComicMetadata } from '../types.ts';

/**
 * Best-effort metadata extraction from a comic filename.
 *
 * Scene releases have no single convention, but they do share a shape:
 * `<series> <issue> (<year>) (<junk>) [<junk>]`. So rather than matching whole
 * filenames against a list of patterns, we peel off the parts we recognise --
 * brackets, then volume, then issue -- and treat whatever survives as the
 * series name. That degrades gracefully: an unrecognised filename still yields
 * a usable series instead of nothing.
 *
 * Everything here is a guess. Embedded ComicInfo.xml and user edits both
 * override it -- see `mergeMetadata`.
 */

/** Release-group and quality noise that should never be mistaken for a title. */
const SCAN_NOISE = new RegExp(
  '^(' +
    'digital|webrip|web|scan|c2c|f\\d+|fiche|' +
    'minutemen|zone[- ]empire|dcp|empire|bchry|phillywilly|' +
    'the last kryptonian[- ]?dcp|' +
    'covers?|no ?ads|repack|fixed|re[- ]?edit|' +
    'rus|eng|esp|fra|ger|ita|jpn|' +
    '\\d{3,4}p|hd|hq|lq|scanned|joined' +
  ')$',
  'i',
);

/** Collected-edition markers. Presence means "this is a book, not an issue". */
const COLLECTION_MARKERS = /\b(tpb|ogn|hc|hardcover|omnibus|deluxe|compendium)\b/i;

/** Issue kinds that carry a word in front of the number. */
const SPECIAL_ISSUE = /\b(annual|special|giant[- ]size|one[- ]shot|prologue|epilogue)\b/i;

const YEAR_RE = /^(19\d{2}|20\d{2})$/;

/**
 * A dash-separated tail that is purely an issue reference rather than a story
 * title: "Chapter 097", "Ch. 12", "#5", "003".
 */
const ISSUE_ONLY_TAIL = /^(?:#|c(?:h(?:apter)?)?\.?\s*)?\s*\d{1,5}(?:\.\d+)?[a-z]{0,2}$/i;

interface Bracketed {
  text: string;
  /** Bracket style hints at intent: () is metadata, [] is usually a group tag. */
  kind: 'paren' | 'square' | 'curly';
}

/**
 * Pull every bracketed group out of the name, returning the stripped remainder.
 * Only handles one level of nesting, which is all real filenames use.
 */
function extractBrackets(name: string): { rest: string; groups: Bracketed[] } {
  const groups: Bracketed[] = [];
  const rest = name.replace(
    /\(([^()]*)\)|\[([^\[\]]*)\]|\{([^{}]*)\}/g,
    (_match, paren, square, curly) => {
      const text = (paren ?? square ?? curly ?? '').trim();
      if (text) {
        groups.push({
          text,
          kind: paren !== undefined ? 'paren' : square !== undefined ? 'square' : 'curly',
        });
      }
      return ' ';
    },
  );
  return { rest, groups };
}

/** Normalise separators, collapse whitespace, drop dangling punctuation. */
function tidy(value: string): string {
  return value
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—,.]+|[\s\-–—,.]+$/g, '')
    .trim();
}

/** Strip a trailing container extension, if the input still has one. */
export function stripExtension(filename: string): string {
  return filename.replace(/\.(cbz|cbr|cb7|cbt|pdf|zip|rar|7z|tar)$/i, '');
}

/**
 * Parse an issue string into a sortable number. Handles decimals ("1.5"),
 * zero-padding, and letter suffixes ("1a"). Undefined for pure words.
 */
export function issueToNumber(issue: string | undefined): number | undefined {
  if (!issue) return undefined;
  const match = issue.match(/(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseFilename(filename: string): ComicMetadata {
  const meta: ComicMetadata = {};
  const scanTags: string[] = [];
  let name = tidy(stripExtension(filename));

  // --- 1. Peel off bracketed groups. --------------------------------------
  const { rest, groups } = extractBrackets(name);
  name = tidy(rest);

  for (const group of groups) {
    const text = group.text;

    // A bare year in brackets is the publication year.
    if (YEAR_RE.test(text) && meta.year === undefined) {
      meta.year = Number.parseInt(text, 10);
      continue;
    }

    // "2024-05" style dates.
    const dateMatch = text.match(/^(19\d{2}|20\d{2})[-/.](\d{1,2})$/);
    if (dateMatch && meta.year === undefined) {
      meta.year = Number.parseInt(dateMatch[1], 10);
      meta.month = Number.parseInt(dateMatch[2], 10);
      continue;
    }

    // A volume marker can live in brackets too: "(v02)".
    const volMatch = text.match(/^v(?:ol)?\.?\s*(\d{1,3})$/i);
    if (volMatch && meta.volume === undefined) {
      meta.volume = volMatch[1].replace(/^0+(?=\d)/, '');
      continue;
    }

    scanTags.push(text);
  }

  // --- 2. Split off a title after " - ". ----------------------------------
  // Require surrounding spaces so hyphenated names ("Spider-Man") survive.
  let titlePart: string | undefined;
  const dashSplit = name.split(/\s+[-–—]\s+/);
  if (dashSplit.length > 1) {
    const candidate = tidy(dashSplit.slice(1).join(' - '));
    // "Chainsaw Man - Chapter 097" puts the issue where a title would go. If
    // the tail is nothing but an issue marker, fold it back into the name so
    // step 5 can read it, rather than losing it to `title`.
    if (ISSUE_ONLY_TAIL.test(candidate)) {
      name = dashSplit[0] + ' ' + candidate;
    } else {
      name = dashSplit[0];
      if (candidate && !SCAN_NOISE.test(candidate)) titlePart = candidate;
    }
  }

  // --- 3. Collected-edition and special-issue markers. ---------------------
  const collectionMatch = name.match(COLLECTION_MARKERS);
  if (collectionMatch) {
    scanTags.push(collectionMatch[1].toUpperCase());
    name = tidy(name.replace(COLLECTION_MARKERS, ' '));
  }

  let specialWord: string | undefined;
  const specialMatch = name.match(SPECIAL_ISSUE);
  if (specialMatch) {
    specialWord = specialMatch[1];
    name = tidy(name.replace(SPECIAL_ISSUE, ' '));
  }

  // --- 4. Volume. ----------------------------------------------------------
  const volInline = name.match(/\bv(?:ol(?:ume)?)?\.?\s*(\d{1,3})\b/i);
  if (volInline && volInline.index !== undefined) {
    if (meta.volume === undefined) meta.volume = volInline[1].replace(/^0+(?=\d)/, '');
    name = tidy(
      name.slice(0, volInline.index) + ' ' + name.slice(volInline.index + volInline[0].length),
    );
  }

  // --- 5. Issue or chapter number. ----------------------------------------
  // An explicit "#12" beats position; then manga "c012"; then a trailing number.
  const hashed = name.match(/#\s*(\d{1,5}(?:\.\d+)?[a-z]{0,3})\b/i);
  const chapter = name.match(/\bc(?:h(?:apter)?)?\.?\s*(\d{1,4}(?:\.\d+)?)\b/i);
  const trailing = name.match(/(?:^|\s)(\d{1,5}(?:\.\d+)?[a-z]{0,2})\s*$/i);

  let issueRaw: string | undefined;
  if (hashed) {
    issueRaw = hashed[1];
    name = tidy(name.replace(hashed[0], ' '));
  } else if (chapter && chapter.index !== undefined) {
    issueRaw = chapter[1];
    name = tidy(
      name.slice(0, chapter.index) + ' ' + name.slice(chapter.index + chapter[0].length),
    );
  } else if (trailing && trailing.index !== undefined) {
    // Guard against swallowing a bare year, and against series names that
    // genuinely end in a number -- "Fantastic Four" is safe, "2000 AD" is not.
    const remainder = tidy(name.slice(0, trailing.index));
    if (remainder.length > 0) {
      if (YEAR_RE.test(trailing[1])) {
        // A trailing 4-digit year with no issue: record the year, not an issue.
        if (meta.year === undefined) meta.year = Number.parseInt(trailing[1], 10);
        name = remainder;
      } else {
        issueRaw = trailing[1];
        name = remainder;
      }
    }
  }

  // Re-attach the special word so "Annual 1" stays distinct from "#1".
  if (specialWord) {
    const word = specialWord.replace(/\b\w/g, (c) => c.toUpperCase());
    issueRaw = issueRaw ? word + ' ' + issueRaw : word;
  }

  // A collected edition with only a volume number: use the volume as the issue
  // so sorting and grouping behave, while keeping `volume` set for display.
  if (!issueRaw && meta.volume) issueRaw = meta.volume;

  if (issueRaw) {
    meta.issue = issueRaw.replace(/^0+(?=\d)/, '') || issueRaw;
    meta.issueNumber = issueToNumber(issueRaw);
  }

  // --- 6. Whatever survives is the series. --------------------------------
  // A year can still be trailing here if it sat outside brackets.
  let series = tidy(name);
  const trailingYear = series.match(/\s(19\d{2}|20\d{2})$/);
  if (trailingYear && meta.year === undefined && series.length > trailingYear[0].length) {
    meta.year = Number.parseInt(trailingYear[1], 10);
    series = tidy(series.slice(0, -trailingYear[0].length));
  }

  if (series) meta.series = series;
  if (titlePart) meta.title = titlePart;
  if (scanTags.length > 0) meta.scanTags = scanTags;

  return meta;
}

/**
 * Combine metadata from several sources. Later arguments win, but only for
 * fields they actually define -- a ComicInfo.xml with a blank publisher must
 * not erase a publisher we guessed elsewhere.
 */
export function mergeMetadata(...sources: (ComicMetadata | undefined)[]): ComicMetadata {
  const out: ComicMetadata = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      (out as Record<string, unknown>)[key] = value;
    }
  }
  // Keep the numeric form in sync with whichever `issue` won.
  if (out.issue) out.issueNumber = issueToNumber(out.issue);
  return out;
}

/** Human-readable issue label: "#12", "Vol. 3", "Annual 1". */
export function formatIssue(meta: ComicMetadata): string {
  if (!meta.issue) return '';
  if (/^[a-z]/i.test(meta.issue)) return meta.issue;
  if (meta.volume && meta.issue === meta.volume) return 'Vol. ' + meta.volume;
  return '#' + meta.issue;
}

/** Display name for a comic: "Absolute Batman #1 - Chapter One". */
export function formatComicTitle(meta: ComicMetadata, fallback: string): string {
  const parts: string[] = [];
  if (meta.series) parts.push(meta.series);
  const issue = formatIssue(meta);
  if (issue) parts.push(issue);
  if (parts.length === 0) return fallback;
  const head = parts.join(' ');
  return meta.title ? head + ' - ' + meta.title : head;
}
