/**
 * `rebase` (non-interactive) — replay the commits unique to the current branch on
 * top of another base, faithful to git's merge backend. HEAD is detached at the
 * new base, each commit is replayed as a cherry-pick (3-way merge through the
 * shared `applyMergeToWorktree` primitive, preserving the source author with the
 * current committer), then the branch is updated and HEAD reattached at finish.
 * Conflicts stop under a byte-faithful `.git/rebase-merge/` state + `REBASE_HEAD`.
 */
import { noInitialCommit, workingTreeDirty } from '../../domain/commands/error.js';
import { renderPatch } from '../../domain/diff/index.js';
import { TsgitError } from '../../domain/error.js';
import { unsupportedOperation } from '../../domain/index.js';
import type { ConflictType, MergeConflict } from '../../domain/merge/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { FilePath, ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { applyMergeToWorktree } from '../primitives/apply-merge-to-worktree.js';
import { createCommit } from '../primitives/create-commit.js';
import { diffTrees } from '../primitives/diff-trees.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  readHeadRaw,
} from '../primitives/internal/repo-state.js';
import { materialisePatchFiles } from '../primitives/materialise-patch-files.js';
import { mergeBase } from '../primitives/merge-base.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { recordRefUpdate } from '../primitives/record-ref-update.js';
import { getRefStore } from '../primitives/ref-store.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { writeSymbolicRef } from '../primitives/write-symbolic-ref.js';
import { conflictMergeMsg } from './internal/cherry-pick-state.js';
import { assertCleanWorkTree } from './internal/clean-work-tree.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { resolveCurrentIdentity } from './internal/current-identity.js';
import { acquireIndexLock } from './internal/index-update.js';
import { writeOrigHead } from './internal/merge-state.js';
import { type RebaseStop, writeRebaseStop } from './internal/rebase-state.js';

const HEAD = 'HEAD' as RefName;

export interface RebaseRunInput {
  /** The fork-point side — a commit-ish (`git rebase <upstream>`). */
  readonly upstream: string;
  /** `--onto <newbase>`: replay onto this base instead of `upstream`. */
  readonly onto?: string;
}

export interface RebasedCommit {
  readonly source: ObjectId;
  readonly created: ObjectId;
}

export interface RebaseConflict {
  readonly path: FilePath;
  readonly type: ConflictType;
}

export type RebaseResult =
  | { readonly kind: 'rebased'; readonly commits: ReadonlyArray<RebasedCommit> }
  | { readonly kind: 'up-to-date' }
  | {
      readonly kind: 'conflict';
      readonly commit: ObjectId;
      readonly conflicts: ReadonlyArray<RebaseConflict>;
      readonly remaining: number;
    };

type ReplayOutcome =
  | { readonly kind: 'committed'; readonly id: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
  | { readonly kind: 'empty' };

/** A resolved work-list entry (full oid + subject) threaded through the replay. */
interface PlannedPick {
  readonly oid: ObjectId;
  readonly subject: string;
}

const readCommitData = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, id);
  return obj.data;
};

const treeOf = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> =>
  (await readCommitData(ctx, commitId)).tree;

const subjectOf = (message: string): string => message.split('\n')[0] as string;
const shortOid = (oid: ObjectId): string => oid.slice(0, 7);

/** Resolve the (symbolic) HEAD branch to its commit, or refuse on an unborn branch. */
const resolveHeadCommit = async (ctx: Context, branch: RefName): Promise<ObjectId> => {
  try {
    return await resolveRef(ctx, branch);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_NOT_FOUND') throw noInitialCommit();
    throw err;
  }
};

/** Commits in `base..head`, oldest-first (the rebase work-list). `base`'s whole
 *  ancestor set is excluded so a shared root reached down a divergent branch
 *  cannot leak in. */
const commitsToReplay = async (
  ctx: Context,
  base: ObjectId,
  head: ObjectId,
): Promise<ReadonlyArray<ObjectId>> => {
  const excluded = new Set<ObjectId>();
  for await (const c of walkCommits(ctx, { from: [base] })) excluded.add(c.id);
  const ids: ObjectId[] = [];
  for await (const c of walkCommits(ctx, { from: [head], until: [...excluded] })) ids.push(c.id);
  return ids.reverse();
};

const buildTodoEntries = async (
  ctx: Context,
  oids: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<PlannedPick>> => {
  const entries: PlannedPick[] = [];
  for (const oid of oids) {
    entries.push({ oid, subject: subjectOf((await readCommitData(ctx, oid)).message) });
  }
  return entries;
};

/** Detach HEAD from its branch onto `onto`, recording git's `rebase (start)` reflog. */
const detachHead = async (
  ctx: Context,
  fromHead: ObjectId,
  onto: ObjectId,
  ontoName: string,
): Promise<void> => {
  await getRefStore(ctx).writeLoose(HEAD, onto);
  await recordRefUpdate(ctx, HEAD, fromHead, onto, `rebase (start): checkout ${ontoName}`);
};

/** Apply one commit onto the detached HEAD `ourId`; commit it when the merge is clean. */
const replayOne = async (
  ctx: Context,
  cData: CommitData,
  ourId: ObjectId,
  reflogLabel: string,
): Promise<ReplayOutcome> => {
  const parentId = cData.parents[0];
  const baseTree = parentId !== undefined ? await treeOf(ctx, parentId) : undefined;
  const oursTree = await treeOf(ctx, ourId);
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const res = await applyMergeToWorktree(ctx, {
      baseTree,
      oursTree,
      theirsTree: cData.tree,
      currentIndex,
    });
    if (res.kind === 'would-overwrite') throw workingTreeDirty(res.paths);
    if (res.kind === 'conflict') {
      await lock.commit(res.indexEntries);
      return { kind: 'conflict', conflicts: res.conflicts };
    }
    if (res.mergedTree === oursTree) return { kind: 'empty' };
    await lock.commit(res.result.newIndexEntries);
    const committer = await resolveCurrentIdentity(ctx);
    const id = await createCommit(ctx, {
      tree: res.mergedTree,
      parents: [ourId],
      author: cData.author,
      committer,
      message: cData.message,
      extraHeaders: [],
    });
    await updateRef(ctx, HEAD, id, {
      expected: ourId,
      reflogMessage: `rebase (${reflogLabel}): ${subjectOf(cData.message)}`,
    });
    return { kind: 'committed', id };
  } finally {
    await lock.release();
  }
};

/** Render the failed pick's `parent..commit` diff for `.git/rebase-merge/patch`. */
const renderCommitPatch = async (ctx: Context, cData: CommitData): Promise<string> => {
  const parentId = cData.parents[0];
  const parentTree = parentId !== undefined ? await treeOf(ctx, parentId) : undefined;
  const diff = await diffTrees(ctx, parentTree, cData.tree);
  const files = await materialisePatchFiles(ctx, diff.changes);
  return renderPatch(files, { contextLines: 3, pathPrefix: { old: 'a/', new: 'b/' } });
};

interface SequenceContext {
  readonly branch: RefName;
  readonly upstream: ObjectId;
  readonly onto: ObjectId;
  readonly ontoName: string;
  readonly origHead: ObjectId;
  readonly todo: ReadonlyArray<PlannedPick>;
}

/** Persist the byte-faithful stop state when a replay conflicts. */
const persistStop = async (
  ctx: Context,
  seq: SequenceContext,
  index: number,
  cData: CommitData,
  conflicts: ReadonlyArray<MergeConflict>,
  rewritten: ReadonlyArray<readonly [ObjectId, ObjectId]>,
): Promise<void> => {
  const stop: RebaseStop = {
    headName: seq.branch,
    onto: seq.onto,
    origHead: seq.origHead,
    done: seq.todo.slice(0, index + 1),
    remaining: seq.todo.slice(index + 1),
    stoppedSha: seq.todo[index]!.oid,
    stoppedAuthor: cData.author,
    message: conflictMergeMsg(
      cData.message,
      conflicts.map((c) => c.path),
    ),
    rewritten,
    patch: await renderCommitPatch(ctx, cData),
    backupHeader: {
      shortUpstream: shortOid(seq.upstream),
      shortOrigHead: shortOid(seq.origHead),
      shortOnto: shortOid(seq.onto),
    },
  };
  await writeRebaseStop(ctx, stop);
};

/** Reattach `branch` to the replayed tip and record git's `rebase (finish)` reflogs. */
const finishRebase = async (
  ctx: Context,
  branch: RefName,
  origHead: ObjectId,
  newTip: ObjectId,
  onto: ObjectId,
): Promise<void> => {
  await updateRef(ctx, branch, newTip, {
    expected: origHead,
    reflogMessage: `rebase (finish): ${branch} onto ${onto}`,
  });
  await writeSymbolicRef(ctx, HEAD, branch);
  await recordRefUpdate(ctx, HEAD, newTip, newTip, `rebase (finish): returning to ${branch}`);
};

/** Detach, replay every commit, and finish — or stop at the first conflict. */
const runSequence = async (ctx: Context, seq: SequenceContext): Promise<RebaseResult> => {
  await detachHead(ctx, seq.origHead, seq.onto, seq.ontoName);
  let ourId = seq.onto;
  const applied: RebasedCommit[] = [];
  const rewritten: Array<readonly [ObjectId, ObjectId]> = [];
  for (let i = 0; i < seq.todo.length; i += 1) {
    const source = seq.todo[i]!.oid;
    const cData = await readCommitData(ctx, source);
    const outcome = await replayOne(ctx, cData, ourId, 'pick');
    if (outcome.kind === 'committed') {
      applied.push({ source, created: outcome.id });
      rewritten.push([source, outcome.id]);
      ourId = outcome.id;
      continue;
    }
    if (outcome.kind === 'empty') continue;
    await persistStop(ctx, seq, i, cData, outcome.conflicts, rewritten);
    return {
      kind: 'conflict',
      commit: source,
      conflicts: outcome.conflicts.map((c) => ({ path: c.path, type: c.type })),
      remaining: seq.todo.length - (i + 1),
    };
  }
  await finishRebase(ctx, seq.branch, seq.origHead, ourId, seq.onto);
  return { kind: 'rebased', commits: applied };
};

export const rebaseRun = async (ctx: Context, input: RebaseRunInput): Promise<RebaseResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'rebase');
  await assertNoPendingOperation(ctx);
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('rebase', 'cannot rebase with detached HEAD');
  }
  const branch = head.target;
  const headCommit = await resolveHeadCommit(ctx, branch);
  const upstream = await resolveCommitIsh(ctx, input.upstream);
  const onto = input.onto !== undefined ? await resolveCommitIsh(ctx, input.onto) : upstream;
  const ontoName = input.onto ?? input.upstream;
  await assertCleanWorkTree(ctx, await treeOf(ctx, headCommit));
  const [base] = await mergeBase(ctx, [upstream, headCommit]);
  if (base === undefined) {
    throw unsupportedOperation('rebase', 'no common ancestor between HEAD and upstream');
  }
  if (onto === base) return { kind: 'up-to-date' };
  const todo = await buildTodoEntries(ctx, await commitsToReplay(ctx, base, headCommit));
  await writeOrigHead(ctx, headCommit);
  return runSequence(ctx, { branch, upstream, onto, ontoName, origHead: headCommit, todo });
};
