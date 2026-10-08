/**
 * Tier-1 `range-diff` command — git's `git range-diff`: compare two commit
 * ranges and report, commit-by-commit, which patches were added, removed, left
 * unchanged, or changed. Returns structured data only (ADR-249): the ordered
 * correspondence list, each changed pair carrying the structured diff-of-diffs.
 * The command owns the I/O — resolving the range endpoints, walking each
 * `base..tip` (date order, oldest-first, merges excluded), and reading the trees
 * and blobs — then hands the pure domain orchestrator two hydrated patch series.
 */

import {
  invalidOption,
  invalidRevisionRange,
  needTwoCommitRanges,
  revparseUnresolved,
} from '../../domain/commands/error.js';
import { foldSubject } from '../../domain/objects/commit-message.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { Commit, ObjectId } from '../../domain/objects/index.js';
import {
  type RangeDiffEntry,
  type RenderedPatch,
  rangeDiffEntries,
  renderRangePatch,
} from '../../domain/range-diff/index.js';
import type { Context } from '../../ports/context.js';
import { diffTrees } from '../primitives/diff-trees.js';
import { boundedMapFor } from '../primitives/internal/concurrency.js';
import {
  createObjectTypeTable,
  type ObjectTypeTable,
  parseTypedObjectOrAbsent,
} from '../primitives/internal/object-type-table.js';
import { peelChain, tagHop } from '../primitives/internal/peel-chain.js';
import { materialisePatchFiles } from '../primitives/materialise-patch-files.js';
import { readObject } from '../primitives/read-object.js';
import { walkCommitsByDate } from '../primitives/walk-commits-by-date.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { readCommittish } from './rev-parse.js';

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

/** Reads, diffs and renders one commit's patch text immediately — the
 *  `PatchFile` `oldContent`/`newContent` this hydrates go out of scope here,
 *  never surviving past this call as part of the series. */
const hydrate = async (ctx: Context, commit: Commit): Promise<RenderedPatch> => {
  const parentId = commit.data.parents[0];
  const parentTree = parentId !== undefined ? await readTreeOf(ctx, parentId) : undefined;
  const diff = await diffTrees(ctx, parentTree, commit.data.tree, {
    recursive: true,
    detectRenames: true,
  });
  const files = await materialisePatchFiles(ctx, diff.changes);
  return renderRangePatch({
    id: commit.id,
    authorName: commit.data.author.name,
    authorEmail: commit.data.author.email,
    subject: foldSubject(commit.data.message),
    message: commit.data.message,
    files,
  });
};

/** Hydrate the series with bounded concurrency, preserving series order. */
const hydrateSeries = (
  ctx: Context,
  commits: ReadonlyArray<Commit>,
): Promise<ReadonlyArray<RenderedPatch>> =>
  boundedMapFor(ctx, 'ioBound', commits, (commit) => hydrate(ctx, commit));

interface RangeEnds {
  readonly base: ObjectId;
  readonly tip: ObjectId;
}

const HEAD = 'HEAD';

/** git's `handle_dotdot_1`: an empty side reads as `HEAD`. */
const sideOf = (spelt: string): string => (spelt === '' ? HEAD : spelt);

/** Both ends read commit-ish into the table, the tip once the base resolves; `undefined` once either names no object. */
const readRangeEnds = async (
  ctx: Context,
  table: ObjectTypeTable,
  range: RangeDiffRange,
): Promise<RangeEnds | undefined> => {
  const base = await readCommittish(ctx, table, sideOf(range.base));
  if (base === undefined) return undefined;
  const tip = await readCommittish(ctx, table, sideOf(range.tip));
  return tip === undefined ? undefined : { base, tip };
};

/**
 * git's `is_range_diff_range`: both ends read — one naming no object is a bad
 * revision — then parsed into the table — a failed parse dies `Invalid
 * revision range` — and ends that are one object exclude all they include,
 * which is no commit range.
 */
const setUpRange = async (
  ctx: Context,
  table: ObjectTypeTable,
  range: RangeDiffRange,
): Promise<RangeEnds> => {
  const expression = `${range.base}..${range.tip}`;
  const ends = await readRangeEnds(ctx, table, range);
  if (ends === undefined) throw revparseUnresolved(expression);
  const parsedBase = await parseTypedObjectOrAbsent(ctx, table, ends.base);
  const parsedTip = await parseTypedObjectOrAbsent(ctx, table, ends.tip);
  if (parsedBase === undefined || parsedTip === undefined) {
    throw invalidRevisionRange(expression);
  }
  if (ends.base === ends.tip) throw needTwoCommitRanges(expression);
  return ends;
};

/** The commit `id` reaches through its tags, or `undefined` for a tree or blob, which git log walks nothing from. */
const commitBehind = async (ctx: Context, id: ObjectId): Promise<ObjectId | undefined> => {
  const { id: peeled, result } = await peelChain(ctx, id, readObject, tagHop);
  return result.type === 'commit' ? peeled : undefined;
};

/** Walk `base..tip` (date order), drop merges, reverse to a patch series. */
const readSeries = async (ctx: Context, ends: RangeEnds): Promise<ReadonlyArray<RenderedPatch>> => {
  const base = await commitBehind(ctx, ends.base);
  const tip = await commitBehind(ctx, ends.tip);
  if (tip === undefined) return [];
  const until = base === undefined ? [] : [base];
  const commits: Commit[] = [];
  for await (const commit of walkCommitsByDate(ctx, { from: [tip], until })) {
    if (commit.data.parents.length <= 1) commits.push(commit); // git's --no-merges
  }
  commits.reverse(); // oldest-first patch order
  return hydrateSeries(ctx, commits);
};

export const rangeDiff = async (
  ctx: Context,
  opts: RangeDiffOptions,
): Promise<ReadonlyArray<RangeDiffEntry>> => {
  await assertOperationalRepository(ctx);
  const creationFactor = resolveCreationFactor(opts.creationFactor);
  // git validates both ranges, in one object table, before it walks either.
  const table = createObjectTypeTable();
  const oldEnds = await setUpRange(ctx, table, opts.old);
  const newEnds = await setUpRange(ctx, table, opts.new);
  const oldSeries = await readSeries(ctx, oldEnds);
  const newSeries = await readSeries(ctx, newEnds);
  return rangeDiffEntries(oldSeries, newSeries, creationFactor);
};
