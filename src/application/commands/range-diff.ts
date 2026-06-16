/**
 * Tier-1 `range-diff` command — git's `git range-diff`: compare two commit
 * ranges and report, commit-by-commit, which patches were added, removed, left
 * unchanged, or changed. Returns structured data only (ADR-249): the ordered
 * correspondence list, each changed pair carrying the structured diff-of-diffs.
 * The command owns the I/O — resolving the range endpoints, walking each
 * `base..tip` (date order, oldest-first, merges excluded), and reading the trees
 * and blobs — then hands the pure domain orchestrator two hydrated patch series.
 */

import { invalidOption } from '../../domain/commands/error.js';
import { foldSubject } from '../../domain/objects/commit-message.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { Commit, ObjectId } from '../../domain/objects/index.js';
import {
  type CommitPatchInput,
  type RangeDiffEntry,
  rangeDiffEntries,
} from '../../domain/range-diff/index.js';
import type { Context } from '../../ports/context.js';
import { diffTrees } from '../primitives/diff-trees.js';
import { materialisePatchFiles } from '../primitives/materialise-patch-files.js';
import { readObject } from '../primitives/read-object.js';
import { walkCommitsByDate } from '../primitives/walk-commits-by-date.js';
import { assertCommandPreamble } from './internal/repo-state.js';
import { resolveCommit } from './internal/resolve-rev.js';

export type {
  RangeDiffCommit,
  RangeDiffEntry,
  RangeDiffStatus,
} from '../../domain/range-diff/index.js';

/** A commit range — `base..tip`, each a commit-ish (full rev grammar). */
export interface RangeDiffRange {
  readonly base: string;
  readonly tip: string;
}

export interface RangeDiffOptions {
  /** The first / "old" range. */
  readonly old: RangeDiffRange;
  /** The second / "new" range. */
  readonly new: RangeDiffRange;
  /** git's `--creation-factor` (percentage); default `60`. */
  readonly creationFactor?: number;
}

const DEFAULT_CREATION_FACTOR = 60;
/** Bound on commit hydrations in flight while reading a series. */
const MAX_CONCURRENT_COMMITS = 16;

const resolveCreationFactor = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_CREATION_FACTOR;
  if (!Number.isInteger(value) || value < 0) {
    throw invalidOption('creationFactor', `must be a non-negative integer; got ${value}`);
  }
  return value;
};

const readTreeOf = async (ctx: Context, id: ObjectId): Promise<ObjectId> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, id);
  return obj.data.tree;
};

const hydrate = async (ctx: Context, commit: Commit): Promise<CommitPatchInput> => {
  const parentId = commit.data.parents[0];
  const parentTree = parentId !== undefined ? await readTreeOf(ctx, parentId) : undefined;
  const diff = await diffTrees(ctx, parentTree, commit.data.tree, {
    recursive: true,
    detectRenames: true,
  });
  const files = await materialisePatchFiles(ctx, diff.changes);
  return {
    id: commit.id,
    authorName: commit.data.author.name,
    authorEmail: commit.data.author.email,
    subject: foldSubject(commit.data.message),
    message: commit.data.message,
    files,
  };
};

/** Hydrate the series with bounded concurrency, preserving series order. */
const hydrateSeries = async (
  ctx: Context,
  commits: ReadonlyArray<Commit>,
): Promise<ReadonlyArray<CommitPatchInput>> => {
  const results = new Array<CommitPatchInput>(commits.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < commits.length) {
      const index = cursor++;
      results[index] = await hydrate(ctx, commits[index]!);
    }
  };
  const concurrency = Math.min(MAX_CONCURRENT_COMMITS, commits.length);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
};

/** Walk `base..tip` (date order), drop merges, reverse to a patch series. */
const readSeries = async (
  ctx: Context,
  range: RangeDiffRange,
): Promise<ReadonlyArray<CommitPatchInput>> => {
  const base = await resolveCommit(ctx, range.base);
  const tip = await resolveCommit(ctx, range.tip);
  const commits: Commit[] = [];
  for await (const commit of walkCommitsByDate(ctx, { from: [tip], until: [base] })) {
    if (commit.data.parents.length <= 1) commits.push(commit); // git's --no-merges
  }
  commits.reverse(); // oldest-first patch order
  return hydrateSeries(ctx, commits);
};

export const rangeDiff = async (
  ctx: Context,
  opts: RangeDiffOptions,
): Promise<ReadonlyArray<RangeDiffEntry>> => {
  await assertCommandPreamble(ctx);
  const creationFactor = resolveCreationFactor(opts.creationFactor);
  const oldSeries = await readSeries(ctx, opts.old);
  const newSeries = await readSeries(ctx, opts.new);
  return rangeDiffEntries(oldSeries, newSeries, creationFactor);
};
