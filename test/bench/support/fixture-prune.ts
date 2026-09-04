/**
 * Reclaims stale bench fixture caches under `cacheRoot()` — the `<label>-v<N>`
 * directories `fixture-generator.ts` no longer builds, plus the transient
 * siblings a run leaves behind when it dies: `.tmp.<pid>.<ms>` builds,
 * `.corrupt.<pid>.<ms>` retirements and `.scratch.<pid>.<random>` copies. A
 * sibling whose pid is still alive belongs to a running process and is never
 * touched. Reclaim is a deliberate developer action (`bench:fixture -- --prune`)
 * — nothing here runs automatically.
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

/** Answers whether a pid still belongs to a running process. */
export type ProcessLiveness = (pid: number) => boolean;

const VERSIONED = /^(?<label>[a-z][a-z0-9-]*)-v(?<version>\d+)$/;
// `leftoverDirName` (fixture-generator.ts) and `copyFixtureToScratch`
// (fixture-scratch.ts) both write `<label>-v<N>.<kind>.<pid>.<token>`.
const LEFTOVER =
  /^(?<label>[a-z][a-z0-9-]*)-v\d+\.(?:tmp|corrupt|scratch)\.(?<pid>\d+)\.[A-Za-z0-9]+$/;

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

const isKnownLabel = (label: string): boolean => Object.hasOwn(KNOWN_LABELS, label);

const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;

/**
 * Signal 0 delivers nothing; it only asks whether the pid exists. Only "no such
 * process" means dead: a pid that exists but is not ours (EPERM, EACCES) and any
 * argument the kernel or Node refuses both keep the safe answer.
 */
export const isProcessAlive: ProcessLiveness = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) !== 'ESRCH';
  }
};

type NamedGroups = Record<string, string | undefined>;

const leftoverVerdict = (groups: NamedGroups, isAlive: ProcessLiveness): CacheEntryVerdict => {
  const pid = Number(groups.pid);
  if (!isKnownLabel(groups.label ?? '') || !Number.isSafeInteger(pid) || isAlive(pid)) {
    return 'keep';
  }
  return 'leftover';
};

const versionVerdict = (name: string): CacheEntryVerdict => {
  const groups = VERSIONED.exec(name)?.groups;
  if (groups === undefined) return 'keep';
  if (!isKnownLabel(groups.label ?? '')) return 'keep';
  return Number(groups.version) < FIXTURE_GENERATOR_VERSION ? 'stale-version' : 'keep';
};

/**
 * Name-level classification of one cache-root entry. Only known labels are ever
 * candidates: a directory left by a checkout that knows a label this one does
 * not is kept. Versions newer than this checkout's are kept too — a prune run
 * from an older checkout must never remove a sibling worktree's live fixtures.
 */
export const classifyCacheEntry = (
  name: string,
  isAlive: ProcessLiveness = isProcessAlive,
): CacheEntryVerdict => {
  const leftover = LEFTOVER.exec(name)?.groups;
  return leftover === undefined ? versionVerdict(name) : leftoverVerdict(leftover, isAlive);
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
    if (errorCode(err) === 'ENOENT') return [];
    throw err;
  }
};

/**
 * Sequential on purpose: a fan-out over every entry queues the whole tree's
 * `lstat`s at once, which measured hundreds of MB on a 200 000-file fixture.
 * `entry.isDirectory()` reflects `lstat`, so a symlink never recurses into its
 * target — it is sized as its own link, like any other non-directory entry.
 */
const walkBytes = async (dir: string): Promise<number> => {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    total += entry.isDirectory() ? await walkBytes(entryPath) : (await lstat(entryPath)).size;
  }
  return total;
};

const isGone = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return false;
  } catch (err) {
    return errorCode(err) === 'ENOENT';
  }
};

interface PruneOutcome {
  readonly removed?: PrunedEntry;
  readonly failed?: PruneFailure;
}

/** Bytes are measured before removal so a failed `rm` never inflates the report. */
const pruneCandidate = async (candidate: PruneCandidate): Promise<PruneOutcome> => {
  try {
    const bytes = await walkBytes(candidate.path);
    await rm(candidate.path, { recursive: true, force: true });
    return { removed: { path: candidate.path, bytes } };
  } catch (err) {
    // A concurrent run that already removed the whole candidate is not a failure.
    if (errorCode(err) === 'ENOENT' && (await isGone(candidate.path))) return {};
    const reason = err instanceof Error ? err.message : String(err);
    return { failed: { path: candidate.path, reason } };
  }
};

/** One candidate at a time — an occasional developer verb, sized for memory, not for speed. */
export const pruneFixtureCache = async (): Promise<PruneReport> => {
  const root = cacheRoot();
  const outcomes: PruneOutcome[] = [];
  for (const candidate of await listCandidates(root)) {
    outcomes.push(await pruneCandidate(candidate));
  }
  return {
    root,
    removed: outcomes.flatMap((outcome) =>
      outcome.removed !== undefined ? [outcome.removed] : [],
    ),
    failed: outcomes.flatMap((outcome) => (outcome.failed !== undefined ? [outcome.failed] : [])),
  };
};
