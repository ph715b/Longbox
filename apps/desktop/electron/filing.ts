import { copyFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { parseFilename, normaliseSeriesName } from '@longbox/core';

/**
 * Filing a downloaded comic into the folder it belongs in.
 *
 * The app proposes and the person decides. Measured against realistic release
 * names, parsing the series out of a filename is right about three times in
 * four, and the quarter it gets wrong is the interesting quarter: a miniseries
 * like "Batman - One Bad Day - Ra's al Ghul" collapses to "Batman", which would
 * bury it in the main run. A wrong group is one edit to undo; a wrong folder is
 * a file in the wrong place on disk, found months later. So nothing here moves
 * a file until a destination has been confirmed.
 *
 * Existing folders are offered rather than names invented, which is also what
 * stops "World's Finest" and "Worlds Finest" becoming two directories.
 */

/** How far below a watched root to look for series folders. */
const MAX_DEPTH = 2;

export interface Destination {
  /** Absolute path of the folder. */
  path: string;
  /** Path relative to its watched root, for display. */
  label: string;
  /** The watched root this sits under. */
  root: string;
}

/** Every folder under the watched roots that a comic could be filed into. */
export async function listDestinations(roots: string[]): Promise<Destination[]> {
  const found: Destination[] = [];

  async function walk(root: string, dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // An unreadable or disconnected folder is not worth failing the whole
      // list over; the others are still useful.
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      found.push({ path, label: path.slice(root.length + 1), root });
      if (depth < MAX_DEPTH) await walk(root, path, depth + 1);
    }
  }

  for (const root of roots) {
    found.push({ path: root, label: basename(root), root });
    await walk(root, root, 1);
  }

  found.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return found;
}

export interface FilingCandidate {
  source: string;
  filename: string;
  /** Series parsed from the filename, which is only a suggestion. */
  series?: string;
  issue?: string;
  /** Best existing folder for it, or undefined when nothing matches. */
  suggestedPath?: string;
  /** True when a file of this name is already in the suggested folder. */
  conflict: boolean;
}

/**
 * Work out where each dropped file probably goes.
 *
 * Matching is done on the normalised series name so that punctuation and a
 * leading article do not stop a file finding the folder it belongs in -- the
 * same folding the library uses to group issues into series.
 */
export async function planFiling(
  sources: string[],
  destinations: Destination[],
): Promise<FilingCandidate[]> {
  const byName = new Map<string, string>();
  for (const destination of destinations) {
    // Deeper folders are listed later; keep the first (shallowest) match.
    const key = normaliseSeriesName(basename(destination.path));
    if (!byName.has(key)) byName.set(key, destination.path);
  }

  const plan: FilingCandidate[] = [];

  for (const source of sources) {
    const filename = basename(source);
    const parsed = parseFilename(filename);
    const suggestedPath = parsed.series ? byName.get(normaliseSeriesName(parsed.series)) : undefined;

    plan.push({
      source,
      filename,
      series: parsed.series,
      issue: parsed.issue,
      suggestedPath,
      conflict: suggestedPath ? await exists(join(suggestedPath, filename)) : false,
    });
  }

  return plan;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A name that does not collide, by the convention Windows itself uses. */
async function freeName(dir: string, filename: string): Promise<string> {
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!(await exists(join(dir, candidate)))) return candidate;
  }
  throw new Error(`Could not find a free name for ${filename}`);
}

export interface FilingInstruction {
  source: string;
  /** Where to put it. Undefined means leave the file where it is. */
  targetDir?: string;
  /** What to do when a file of that name is already there. */
  onConflict?: 'skip' | 'keepBoth' | 'replace';
}

export interface FilingOutcome {
  source: string;
  /** Where the file ended up, absent when nothing was done. */
  path?: string;
  status: 'moved' | 'left' | 'skipped' | 'failed';
  message?: string;
}

/**
 * Move one file, preferring a rename.
 *
 * Within a volume a rename is atomic and instant, whatever the file's size --
 * which matters when comics run to tens of megabytes. Across volumes there is
 * no such thing, so the copy is verified against the source's size before the
 * original is removed. A half-copied comic must never be the only one left.
 */
async function moveFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EXDEV is the POSIX spelling; Windows reports EPERM for a cross-volume
    // rename of a file.
    if (code !== 'EXDEV' && code !== 'EPERM') throw error;
  }

  const original = await stat(source);
  await copyFile(source, target);
  const copied = await stat(target);

  if (copied.size !== original.size) {
    await unlink(target).catch(() => {});
    throw new Error('Copy came out a different size, so the original was left alone');
  }

  await unlink(source);
}

/** Carry out a confirmed filing plan. */
export async function fileComics(instructions: FilingInstruction[]): Promise<FilingOutcome[]> {
  const outcomes: FilingOutcome[] = [];

  for (const instruction of instructions) {
    const { source, targetDir } = instruction;

    if (!targetDir) {
      outcomes.push({ source, path: source, status: 'left' });
      continue;
    }

    try {
      const filename = basename(source);

      if (dirname(source).toLowerCase() === targetDir.toLowerCase()) {
        outcomes.push({ source, path: source, status: 'left', message: 'Already in that folder' });
        continue;
      }

      await mkdir(targetDir, { recursive: true });

      let name = filename;
      if (await exists(join(targetDir, filename))) {
        const onConflict = instruction.onConflict ?? 'skip';
        if (onConflict === 'skip') {
          outcomes.push({
            source,
            status: 'skipped',
            message: 'A file of that name is already there',
          });
          continue;
        }
        if (onConflict === 'keepBoth') name = await freeName(targetDir, filename);
        else await unlink(join(targetDir, filename));
      }

      const target = join(targetDir, name);
      await moveFile(source, target);
      outcomes.push({ source, path: target, status: 'moved' });
    } catch (error) {
      outcomes.push({
        source,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcomes;
}
