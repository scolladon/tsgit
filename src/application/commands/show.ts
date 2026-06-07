/**
 * Tier-1 `show` command — structured object data for commit / tag / tree / blob
 * revisions. Resolves each revision (full rev-parse grammar, no tag auto-peel),
 * reads the object, and returns a structured `ShowResult`: a commit carries its
 * `CommitData` plus the diff against its parent (`patch`) or, for a merge, one
 * diff per parent (`perParent`); a tag carries its `TagData` and the recursively
 * shown target; a tree carries its entries; a blob carries its raw content.
 *
 * The library renders nothing — assembling `git show`'s display (commit/Merge
 * headers, dates, the unified patch, combined-diff for merges) from these fields
 * is the caller's concern.
 */
import type { StatTreeDiff, TreeDiff } from '../../domain/diff/index.js';
import type {
  Commit,
  CommitData,
  FileMode,
  GitObject,
  ObjectId,
  Tag,
  TagData,
  Tree,
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readObject } from '../primitives/read-object.js';
import { diffCommitAgainstParent } from './internal/commit-diff.js';
import { assertRepository } from './internal/repo-state.js';
import { revParse } from './rev-parse.js';

export type ShowInput = string | ReadonlyArray<string>;

export interface ShowOptions {
  /**
   * Attach per-file line counts (`added` / `deleted` / `binary`) to the diff(s)
   * — the data half of git's `--numstat`. Off by default (no blob reads).
   */
  readonly withStat?: boolean;
}

export interface ShowTreeEntry {
  readonly name: string;
  readonly mode: FileMode;
  readonly id: ObjectId;
}

export interface ShowCommitResult<D = TreeDiff> {
  readonly kind: 'commit';
  readonly id: ObjectId;
  readonly commit: CommitData;
  /** Diff against the single parent (root: against the empty tree). Absent for merges. */
  readonly patch?: D;
  /** One diff per parent, for a merge (≥2 parents). Absent for non-merges. */
  readonly perParent?: ReadonlyArray<D>;
}

export interface ShowTagResult<D = TreeDiff> {
  readonly kind: 'tag';
  readonly id: ObjectId;
  readonly tag: TagData;
  readonly target: ShowResult<D>;
}

export interface ShowTreeResult {
  readonly kind: 'tree';
  readonly id: ObjectId;
  readonly entries: ReadonlyArray<ShowTreeEntry>;
}

export interface ShowBlobResult {
  readonly kind: 'blob';
  readonly id: ObjectId;
  readonly content: Uint8Array;
}

export type ShowResult<D = TreeDiff> =
  | ShowCommitResult<D>
  | ShowTagResult<D>
  | ShowTreeResult
  | ShowBlobResult;

const DEFAULT_REV = 'HEAD';

export function show(
  ctx: Context,
  rev: ReadonlyArray<string>,
  opts: ShowOptions & { withStat: true },
): Promise<ReadonlyArray<ShowResult<StatTreeDiff>>>;
export function show(
  ctx: Context,
  rev: string | undefined,
  opts: ShowOptions & { withStat: true },
): Promise<ShowResult<StatTreeDiff>>;
export function show(
  ctx: Context,
  rev: ReadonlyArray<string>,
  opts?: ShowOptions,
): Promise<ReadonlyArray<ShowResult>>;
export function show(ctx: Context, rev?: string, opts?: ShowOptions): Promise<ShowResult>;
export async function show(
  ctx: Context,
  rev: ShowInput = DEFAULT_REV,
  opts: ShowOptions = {},
): Promise<ShowResult | ReadonlyArray<ShowResult>> {
  await assertRepository(ctx);
  const withStat = opts.withStat === true;
  if (typeof rev === 'string') return buildForRev(ctx, rev, withStat);
  const results: ShowResult[] = [];
  for (const r of rev) results.push(await buildForRev(ctx, r, withStat));
  return results;
}

const buildForRev = async (ctx: Context, rev: string, withStat: boolean): Promise<ShowResult> =>
  buildResult(ctx, await readObject(ctx, await revParse(ctx, rev)), withStat);

async function buildResult(ctx: Context, obj: GitObject, withStat: boolean): Promise<ShowResult> {
  switch (obj.type) {
    case 'blob':
      return { kind: 'blob', id: obj.id, content: obj.content };
    case 'tree':
      return buildTree(obj);
    case 'commit':
      return buildCommit(ctx, obj, withStat);
    case 'tag':
      return buildTag(ctx, obj, withStat);
  }
}

function buildTree(obj: Tree): ShowTreeResult {
  const entries = obj.entries.map((e) => ({ name: e.name, mode: e.mode, id: e.id }));
  return { kind: 'tree', id: obj.id, entries };
}

async function buildCommit(
  ctx: Context,
  obj: Commit,
  withStat: boolean,
): Promise<ShowCommitResult> {
  const { parents, tree } = obj.data;
  if (parents.length >= 2) {
    const perParent: TreeDiff[] = [];
    for (const parent of parents)
      perParent.push(await diffCommitAgainstParent(ctx, parent, tree, withStat));
    return { kind: 'commit', id: obj.id, commit: obj.data, perParent };
  }
  const patch = await diffCommitAgainstParent(ctx, parents[0], tree, withStat);
  return { kind: 'commit', id: obj.id, commit: obj.data, patch };
}

async function buildTag(ctx: Context, obj: Tag, withStat: boolean): Promise<ShowTagResult> {
  const target = await buildResult(ctx, await readObject(ctx, obj.data.object), withStat);
  return { kind: 'tag', id: obj.id, tag: obj.data, target };
}
