/**
 * Reclaims stale bench fixture caches under `cacheRoot()` — the `<label>-v<N>`
 * directories `fixture-generator.ts` no longer builds, plus `.tmp.<pid>.<ms>`
 * / `.corrupt.<pid>.<ms>` leftovers from an interrupted build or a rebuild
 * that failed its identity probe. Reclaim is a deliberate developer action
 * (`bench:fixture -- --prune`) — nothing here runs automatically.
 */
import { lstat, readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';

// `.ts`, not the sibling files' `.js`: this module is also loaded (via
// `tooling/gen-bench-fixture.ts`) under `node --experimental-strip-types`,
// which does not rewrite a `.js` specifier to the `.ts` file that exists.
import { cacheRoot, FIXTURE_GENERATOR_VERSION, type FixtureSpec } from './fixture-generator.ts';

export interface PrunedEntry {
  readonly path: string;
  /** Logical bytes — sum of file sizes under the directory, measured before removal. */
  readonly bytes: number;
}

export interface PruneFailure {
  readonly path: string;
  readonly reason: string;
}

export interface PruneReport {
  readonly root: string;
  readonly removed: readonly PrunedEntry[];
  readonly failed: readonly PruneFailure[];
}

export type CacheEntryVerdict = 'stale-version' | 'leftover' | 'keep';

const VERSIONED = /^(?<label>[a-z][a-z0-9-]*)-v(?<version>\d+)$/;
const LEFTOVER = /\.(?:tmp|corrupt)\.\d+\.\d+$/;

/** Exhaustive by construction: a new `FixtureSpec` label that is not listed fails `check:types`. */
const KNOWN_LABELS: Readonly<Record<FixtureSpec['label'], true>> = {
  small: true,
  'small-fat-blob': true,
  medium: true,
  'medium-commit-graph': true,
  large: true,
  'delta-chain': true,
  'deep-ancestry-small': true,
  'deep-ancestry-medium': true,
  'deep-ancestry-large': true,
  'header-cache': true,
  'many-pack': true,
  'many-pack-no-midx': true,
  'single-pack': true,
  'loose-only': true,
};

export const classifyCacheEntry = (name: string): CacheEntryVerdict => {
  if (LEFTOVER.test(name)) return 'leftover';
  const match = VERSIONED.exec(name);
  const label = match?.groups?.label;
  const version = match?.groups?.version;
  if (label === undefined || version === undefined || !Object.hasOwn(KNOWN_LABELS, label)) {
    return 'keep';
  }
  return Number.parseInt(version, 10) < FIXTURE_GENERATOR_VERSION ? 'stale-version' : 'keep';
};

interface PruneCandidate {
  readonly name: string;
  readonly path: string;
}

/** A missing root means nothing has ever been cached here — an empty report, not an error. */
const listCandidates = async (root: string): Promise<readonly PruneCandidate[]> => {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && classifyCacheEntry(entry.name) !== 'keep')
      .map((entry) => ({ name: entry.name, path: path.join(root, entry.name) }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
};

/** `entry.isDirectory()` reflects `lstat`, so a symlink never recurses into its
 *  target — it is sized as its own link, exactly like any other non-directory entry. */
const walkBytes = async (dir: string): Promise<number> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(dir, entry.name);
      return entry.isDirectory()
        ? walkBytes(entryPath)
        : lstat(entryPath).then((stat) => stat.size);
    }),
  );
  return sizes.reduce((total, size) => total + size, 0);
};

/** Bytes are measured before removal so a failed `rm` never inflates the report. */
const pruneCandidate = async (
  candidate: PruneCandidate,
): Promise<{ readonly removed?: PrunedEntry; readonly failed?: PruneFailure }> => {
  try {
    const bytes = await walkBytes(candidate.path);
    await rm(candidate.path, { recursive: true, force: true });
    return { removed: { path: candidate.path, bytes } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { failed: { path: candidate.path, reason } };
  }
};

export const pruneFixtureCache = async (): Promise<PruneReport> => {
  const root = cacheRoot();
  const candidates = await listCandidates(root);
  const outcomes = await Promise.all(candidates.map(pruneCandidate));
  return {
    root,
    removed: outcomes.flatMap((outcome) =>
      outcome.removed !== undefined ? [outcome.removed] : [],
    ),
    failed: outcomes.flatMap((outcome) => (outcome.failed !== undefined ? [outcome.failed] : [])),
  };
};
