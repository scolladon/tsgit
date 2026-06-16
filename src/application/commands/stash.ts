/**
 * `stash` porcelain — save the working tree + index onto the `refs/stash`
 * stack and restore it later, faithful to `git stash`. The saved W/I/U commit
 * trio, the reflog stack, and the post-push clean working tree read back
 * identically to canonical git.
 *
 * @writes
 *   surface: stash
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */
import { noInitialCommit, stashApplyWouldOverwrite } from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import { abbreviateOid, type ConflictType, STASH_LABELS } from '../../domain/merge/index.js';
import { subjectLine } from '../../domain/objects/commit-message.js';
import { invalidCommit, unexpectedObjectType } from '../../domain/objects/error.js';
import { deriveWorkingMode, type FilePath, type ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { FileStat } from '../../ports/file-system.js';
import { applyMergeToWorktree, mergeTreesToTree } from '../primitives/apply-merge-to-worktree.js';
import { buildIndexFromTree } from '../primitives/build-index-from-tree.js';
import { compareWorkingTreeEntry } from '../primitives/compare-working-tree-entry.js';
import { createCommit } from '../primitives/create-commit.js';
import { flattenTree } from '../primitives/flatten-tree.js';
import { hashBlob } from '../primitives/hash-blob.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertOperationalRepository,
  type HeadState,
  readHeadRaw,
} from '../primitives/internal/repo-state.js';
import { stage0Entry } from '../primitives/internal/synthetic-index-entry.js';
import {
  removeWorkingTreeFile,
  writeWorkingTreeFile,
} from '../primitives/internal/write-working-tree-file.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { readBlob } from '../primitives/read-blob.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { resolveReflogIdentity } from '../primitives/reflog-identity.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import {
  dropStashEntry,
  pushStashRef,
  readStashStack,
  resolveStashEntry,
  type StashDropResult,
  type StashStackEntry,
} from '../primitives/stash-ref.js';
import { synthesizeTreeFromIndex } from '../primitives/synthesize-tree-from-index.js';
import { MAX_WORKING_TREE_BLOB_BYTES } from '../primitives/types.js';
import { walkWorkingTree } from '../primitives/walk-working-tree.js';
import { buildRepoIgnorePredicate } from './internal/build-ignore-evaluator.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  indexMessage,
  onMessage,
  stashBranchLabel,
  untrackedMessage,
  wipMessage,
} from './internal/stash-message.js';

export interface StashPushInput {
  readonly message?: string;
  readonly includeUntracked?: boolean;
  readonly keepIndex?: boolean;
}

export type StashPushResult =
  | { readonly kind: 'saved'; readonly stash: ObjectId; readonly message: string }
  | { readonly kind: 'no-local-changes' };

const REASON_NOT_A_STASH_COMMIT = 'ref does not point at a stash commit';

interface BaseState {
  readonly b: ObjectId;
  readonly bTree: ObjectId;
  readonly branchRef: string | undefined;
  readonly subject: string;
}

const commitTreeOf = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> => {
  const obj = await readObject(ctx, commitId);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, commitId);
  return obj.data.tree;
};

/** Resolve HEAD to its commit oid, or refuse on an unborn branch. */
const resolveHeadCommit = async (ctx: Context, head: HeadState): Promise<ObjectId> => {
  if (head.kind === 'direct') return head.id;
  try {
    return await resolveRef(ctx, head.target);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_NOT_FOUND') throw noInitialCommit();
    throw err;
  }
};

/** Resolve HEAD to the base commit's id, tree, branch label, and subject (one read). */
const resolveBase = async (ctx: Context, head: HeadState): Promise<BaseState> => {
  const b = await resolveHeadCommit(ctx, head);
  const obj = await readObject(ctx, b);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, b);
  return {
    b,
    bTree: obj.data.tree,
    branchRef: head.kind === 'symbolic' ? head.target : undefined,
    subject: subjectLine(obj.data.message),
  };
};

const hashFileAt = async (
  ctx: Context,
  path: FilePath,
  stat: FileStat,
): Promise<{ readonly id: ObjectId; readonly mode: ReturnType<typeof deriveWorkingMode> }> => {
  const abs = `${ctx.layout.workDir}/${path}`;
  const content = stat.isSymbolicLink
    ? new TextEncoder().encode(await ctx.fs.readlink(abs))
    : await ctx.fs.read(abs);
  const id = await hashBlob(ctx, content, { write: true });
  return { id, mode: deriveWorkingMode(stat) };
};

interface WorkingTreeProjection {
  readonly entries: ReadonlyArray<IndexEntry>;
  readonly dirty: boolean;
}

/** Project the index's stage-0 entries onto their working-tree content (the W tree). */
const projectWorkingTree = async (
  ctx: Context,
  index: GitIndex,
): Promise<WorkingTreeProjection> => {
  const entries: IndexEntry[] = [];
  let dirty = false;
  for (const entry of index.entries) {
    // Stryker disable next-line ConditionalExpression: equivalent — a non-conflicted index (the only state stash push reaches) carries no stage!=0 entries, so this skip is never taken; the `if(true)` variant that drops every entry is killed by the W-tree-content tests.
    if (entry.flags.stage !== 0) continue;
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — a non-sparse index has no skip-worktree entries, so this verbatim-keep branch is never taken; the `if(true)` variant (keep stale id instead of re-hashing) is killed by the modified-content tests.
    if (entry.flags.skipWorktree) {
      entries.push(entry);
      continue;
    }
    const cmp = await compareWorkingTreeEntry(ctx, entry);
    if (cmp === 'absent') {
      dirty = true;
      continue;
    }
    if (cmp === 'unchanged') {
      entries.push(entry);
      continue;
    }
    dirty = true;
    const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/${entry.path}`);
    const { id, mode } = await hashFileAt(ctx, entry.path, stat);
    entries.push(stage0Entry(entry.path, id, mode));
  }
  return { entries, dirty };
};

interface UntrackedProjection {
  readonly paths: ReadonlyArray<FilePath>;
  readonly entries: ReadonlyArray<IndexEntry>;
}

/** Collect the untracked (non-ignored) working files as synthetic index entries. */
const collectUntracked = async (ctx: Context, index: GitIndex): Promise<UntrackedProjection> => {
  const tracked = new Set(index.entries.map((e) => e.path));
  const ignore = await buildRepoIgnorePredicate(ctx);
  const paths: FilePath[] = [];
  const entries: IndexEntry[] = [];
  for await (const { path, stat } of walkWorkingTree(ctx, { ignore })) {
    if (tracked.has(path)) continue;
    const { id, mode } = await hashFileAt(ctx, path, stat);
    entries.push(stage0Entry(path, id, mode));
    paths.push(path);
  }
  return { paths, entries };
};

export const stashPush = async (
  ctx: Context,
  opts: StashPushInput = {},
): Promise<StashPushResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'stash');
  await assertNoPendingOperation(ctx);
  const head = await readHeadRaw(ctx);
  const base = await resolveBase(ctx, head);

  const lock = await acquireIndexLock(ctx);
  try {
    const index = await readIndex(ctx);
    const iTree = await synthesizeTreeFromIndex(ctx, index.entries);
    const working = await projectWorkingTree(ctx, index);
    const untracked = opts.includeUntracked
      ? await collectUntracked(ctx, index)
      : { paths: [], entries: [] };

    const stagedDirty = iTree !== base.bTree;
    const hasUntracked = untracked.paths.length > 0;
    if (!stagedDirty && !working.dirty && !hasUntracked) {
      return { kind: 'no-local-changes' };
    }

    const w = await createStashCommits(ctx, { base, iTree, working, untracked, opts });
    await pushStashRef(ctx, w.stash, w.message);
    await resetAfterPush(ctx, lock, { base, iTree, untracked, opts });
    return { kind: 'saved', stash: w.stash, message: w.message };
  } finally {
    await lock.release();
  }
};

interface CommitInputs {
  readonly base: BaseState;
  readonly iTree: ObjectId;
  readonly working: WorkingTreeProjection;
  readonly untracked: UntrackedProjection;
  readonly opts: StashPushInput;
}

/** Build the index/untracked/WIP commit trio and return the W commit + its message. */
const createStashCommits = async (
  ctx: Context,
  inputs: CommitInputs,
): Promise<{ readonly stash: ObjectId; readonly message: string }> => {
  const { base, iTree, working, untracked, opts } = inputs;
  const identity = await resolveReflogIdentity(ctx);
  const branch = stashBranchLabel(base.branchRef);
  const abbrev = abbreviateOid(base.b);
  const subject = base.subject;
  const wipMsg =
    opts.message !== undefined
      ? onMessage(branch, opts.message)
      : wipMessage(branch, abbrev, subject);

  const mkCommit = (
    tree: ObjectId,
    parents: ReadonlyArray<ObjectId>,
    message: string,
  ): Promise<ObjectId> =>
    createCommit(ctx, {
      tree,
      parents,
      author: identity,
      committer: identity,
      message,
      extraHeaders: [],
    });

  const i = await mkCommit(iTree, [base.b], indexMessage(branch, abbrev, subject));
  const wTree = await synthesizeTreeFromIndex(ctx, working.entries);
  if (untracked.paths.length === 0) {
    const stash = await mkCommit(wTree, [base.b, i], wipMsg);
    return { stash, message: wipMsg };
  }
  const uTree = await synthesizeTreeFromIndex(ctx, untracked.entries);
  const u = await mkCommit(uTree, [], untrackedMessage(branch, abbrev, subject));
  const stash = await mkCommit(wTree, [base.b, i, u], wipMsg);
  return { stash, message: wipMsg };
};

export type { StashDropResult } from '../primitives/stash-ref.js';

export type StashListEntry = StashStackEntry;
export interface StashListResult {
  readonly entries: ReadonlyArray<StashListEntry>;
}

/** List the stash stack, newest-first (`stash@{0}` first). */
export const stashList = async (ctx: Context): Promise<StashListResult> => {
  await assertOperationalRepository(ctx);
  return { entries: await readStashStack(ctx) };
};

export interface StashDropInput {
  readonly index?: number;
}

/** Drop `stash@{index}` (default newest) from the stack. */
export const stashDrop = async (
  ctx: Context,
  input: StashDropInput = {},
): Promise<StashDropResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'stash drop');
  return dropStashEntry(ctx, input.index ?? 0);
};

interface ResetInputs {
  readonly base: BaseState;
  readonly iTree: ObjectId;
  readonly untracked: UntrackedProjection;
  readonly opts: StashPushInput;
}

/** Reset the working tree + index to HEAD (or the index tree under `--keep-index`). */
const resetAfterPush = async (
  ctx: Context,
  lock: Awaited<ReturnType<typeof acquireIndexLock>>,
  inputs: ResetInputs,
): Promise<void> => {
  const { base, iTree, untracked, opts } = inputs;
  const currentIndex = await readIndex(ctx);
  const target = opts.keepIndex === true ? iTree : base.bTree;
  const result = await materializeTree(ctx, {
    targetTree: target,
    currentIndex,
    force: true,
    forceRewriteAll: true,
  });
  await lock.commit(result.newIndexEntries);
  // Stryker disable next-line ConditionalExpression: equivalent — when `includeUntracked` is falsy `untracked.paths` is always empty, so the `if(true)` variant iterates an empty list (no-op); the `if(false)` variant is killed by the `-u` removal test.
  if (opts.includeUntracked === true) {
    for (const path of untracked.paths) await removeWorkingTreeFile(ctx, path);
  }
};

export interface StashApplyInput {
  readonly index?: number;
  readonly restoreIndex?: boolean;
}

export interface StashConflict {
  readonly path: FilePath;
  readonly type: ConflictType;
}

export type StashApplyResult =
  | { readonly kind: 'applied'; readonly stash: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<StashConflict> };

interface StashParents {
  readonly base: ObjectId;
  readonly indexParent: ObjectId;
  readonly untrackedParent: ObjectId | undefined;
  readonly wTree: ObjectId;
}

/** Parse a W commit's parents into the stash trio's commit oids. */
const parseStashCommit = async (ctx: Context, w: ObjectId): Promise<StashParents> => {
  const obj = await readObject(ctx, w);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, w);
  const [base, indexParent, untrackedParent] = obj.data.parents;
  // A well-formed stash W always has at least [base, index] parents; fewer means
  // the ref points at a non-stash commit.
  if (base === undefined || indexParent === undefined) {
    throw invalidCommit(REASON_NOT_A_STASH_COMMIT);
  }
  return { base, indexParent, untrackedParent, wTree: obj.data.tree };
};

/** Untracked paths whose restoration would overwrite an existing working file. */
const untrackedOverwrites = async (
  ctx: Context,
  uTree: ObjectId,
): Promise<ReadonlyArray<FilePath>> => {
  const flat = await flattenTree(ctx, uTree);
  const clobbered: FilePath[] = [];
  for (const path of flat.entries.keys()) {
    if (await ctx.fs.exists(`${ctx.layout.workDir}/${path}`)) clobbered.push(path);
  }
  return clobbered;
};

/** Check out the untracked tree into the working tree (clean-apply path only). */
const restoreUntracked = async (ctx: Context, uTree: ObjectId): Promise<void> => {
  const flat = await flattenTree(ctx, uTree);
  for (const [path, entry] of flat.entries) {
    // Cap the read so a hostile crafted `refs/stash` cannot load an unbounded
    // untracked blob (a tsgit-created stash never exceeds this — push hashes
    // working files under the same limit).
    // Stryker disable next-line ObjectLiteral: equivalent — the cap is unobservable without an oversize fixture; cap mechanics are covered by hash-blob.test.ts / read-blob.test.ts.
    const blob = await readBlob(ctx, entry.id, { maxBytes: MAX_WORKING_TREE_BLOB_BYTES });
    await writeWorkingTreeFile(ctx, path, blob.content);
  }
};

/** Reinstate the staged state (`--index`) when the index-side 3-way merge is clean. */
const reinstateIndex = async (
  ctx: Context,
  lock: Awaited<ReturnType<typeof acquireIndexLock>>,
  args: {
    readonly bTree: ObjectId;
    readonly cTree: ObjectId;
    readonly indexParent: ObjectId;
    readonly currentIndex: GitIndex;
  },
): Promise<void> => {
  const iTree = await commitTreeOf(ctx, args.indexParent);
  const merged = await mergeTreesToTree(ctx, {
    baseTree: args.bTree,
    oursTree: args.cTree,
    theirsTree: iTree,
    labels: STASH_LABELS,
  });
  if (merged.kind !== 'clean') return;
  const entries = await buildIndexFromTree(ctx, {
    targetTree: merged.mergedTree,
    currentIndex: args.currentIndex,
  });
  await lock.commit(entries);
};

/** Apply `stash@{index}` (default newest) onto the working tree via a 3-way merge. */
export const stashApply = async (
  ctx: Context,
  input: StashApplyInput = {},
): Promise<StashApplyResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'stash apply');
  await assertNoPendingOperation(ctx);
  const w = await resolveStashEntry(ctx, input.index ?? 0);
  const parsed = await parseStashCommit(ctx, w);
  const bTree = await commitTreeOf(ctx, parsed.base);
  const uTree =
    parsed.untrackedParent !== undefined
      ? await commitTreeOf(ctx, parsed.untrackedParent)
      : undefined;

  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const cTree = await synthesizeTreeFromIndex(ctx, currentIndex.entries);
    if (uTree !== undefined) {
      const clobbered = await untrackedOverwrites(ctx, uTree);
      if (clobbered.length > 0) throw stashApplyWouldOverwrite(clobbered);
    }
    const result = await applyMergeToWorktree(ctx, {
      baseTree: bTree,
      oursTree: cTree,
      theirsTree: parsed.wTree,
      currentIndex,
      labels: STASH_LABELS,
    });
    if (result.kind === 'would-overwrite')
      throw stashApplyWouldOverwrite([...result.localChanges, ...result.untracked]);
    if (result.kind === 'conflict') {
      await lock.commit(result.indexEntries);
      return {
        kind: 'conflict',
        conflicts: result.conflicts.map((c) => ({ path: c.path, type: c.type })),
      };
    }
    if (input.restoreIndex === true) {
      await reinstateIndex(ctx, lock, {
        bTree,
        cTree,
        indexParent: parsed.indexParent,
        currentIndex,
      });
    }
    if (uTree !== undefined) await restoreUntracked(ctx, uTree);
    return { kind: 'applied', stash: w };
  } finally {
    await lock.release();
  }
};

export type StashPopResult =
  | { readonly kind: 'applied'; readonly stash: ObjectId; readonly dropped: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<StashConflict> };

/** Apply `stash@{index}` then drop it; on conflict the stash is retained. */
export const stashPop = async (
  ctx: Context,
  input: StashApplyInput = {},
): Promise<StashPopResult> => {
  const applied = await stashApply(ctx, input);
  if (applied.kind === 'conflict') return applied;
  const dropped = await stashDrop(ctx, { index: input.index ?? 0 });
  return { kind: 'applied', stash: applied.stash, dropped: dropped.dropped };
};
