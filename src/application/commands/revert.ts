/**
 * `revert` — record new commits that undo the changes introduced by existing
 * commits. The inverse of `cherry-pick`: each revert is a new single-parent
 * commit authored by the **current identity** (not the reverted commit's author)
 * whose patch is the **reverse** 3-way merge (`base = C`, `ours = HEAD`,
 * `theirs = parent(C)`) applied through the shared `applyMergeToWorktree`
 * primitive. Conflicts stop with a dedicated `REVERT_HEAD` state; an empty
 * revert (no net change) stops markerless (git has no `--allow-empty`).
 */
import {
  invalidOption,
  mergeHasConflicts,
  noInitialCommit,
  noOperationInProgress,
  revertMergeNoMainline,
  workingTreeDirty,
} from '../../domain/commands/error.js';
import { sortedRecordedPaths } from '../../domain/diff/index.js';
import { TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { unsupportedOperation } from '../../domain/index.js';
import { type ConflictType, type MergeConflict, revertLabels } from '../../domain/merge/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { subjectLine } from '../../domain/objects/commit-message.js';
import type { FilePath, ObjectId, RefName } from '../../domain/objects/index.js';
import type { TodoEntry } from '../../domain/sequencer/index.js';
import type { Context } from '../../ports/context.js';
import { applyMergeToWorktree } from '../primitives/apply-merge-to-worktree.js';
import { createCommit } from '../primitives/create-commit.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertOperationalRepository,
  readHeadRaw,
} from '../primitives/internal/repo-state.js';
import { readIndex } from '../primitives/read-index.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { synthesizeTreeFromIndex } from '../primitives/synthesize-tree-from-index.js';
import { updateRef } from '../primitives/update-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { writeTree } from '../primitives/write-tree.js';
import { abortSequencerReset } from './internal/abort-sequencer-reset.js';
import { conflictMergeMsg } from './internal/cherry-pick-state.js';
import { assertCleanWorkTree } from './internal/clean-work-tree.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { sanitizeMessage, stripComments } from './internal/commit-message.js';
import { resolveCurrentIdentity } from './internal/current-identity.js';
import { readCommitData, requireSymbolicHead, treeOf } from './internal/history-rewrite.js';
import { acquireIndexLock } from './internal/index-update.js';
import { clearMergeMsg, readMergeMsg, writeMergeMsg } from './internal/merge-state.js';
import { hardResetWorktreeToCommit } from './internal/reset-worktree.js';
import {
  clearRevertHead,
  readRevertHead,
  revertMessage,
  writeRevertHead,
} from './internal/revert-state.js';
import {
  clearSequencer,
  readSequencerHead,
  readSequencerTodo,
  writeAbortSafety,
  writeSequencerHead,
  writeSequencerOpts,
  writeSequencerTodo,
} from './internal/sequencer-state.js';
import { revParse } from './rev-parse.js';

export interface RevertRunInput {
  /** Revisions to revert, in argument order — a commit-ish each. */
  readonly commits: ReadonlyArray<string>;
  /** -n / --no-commit: apply each reverse change to the index + working tree
   *  only; never commit, never persist REVERT_HEAD / sequencer state. */
  readonly noCommit?: boolean;
}

export interface RevertedCommit {
  readonly source: ObjectId;
  readonly created: ObjectId;
}

export interface RevertConflict {
  readonly path: FilePath;
  readonly type: ConflictType;
}

export type RevertResult =
  | { readonly kind: 'reverted'; readonly commits: ReadonlyArray<RevertedCommit> }
  | { readonly kind: 'no-commit'; readonly sources: ReadonlyArray<ObjectId> }
  | {
      readonly kind: 'conflict';
      readonly commit: ObjectId;
      readonly conflicts: ReadonlyArray<RevertConflict>;
      readonly remaining: number;
    }
  | { readonly kind: 'empty'; readonly commit: ObjectId; readonly remaining: number };

type RevertOutcome =
  | { readonly kind: 'committed'; readonly id: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
  | { readonly kind: 'empty' };

/** A merge commit (≥2 parents) cannot be reverted without a chosen mainline (`-m`). */
const isMergeCommit = (cData: CommitData): boolean => cData.parents.length >= 2;

const toConflictList = (conflicts: ReadonlyArray<MergeConflict>): ReadonlyArray<RevertConflict> =>
  conflicts.map((c) => ({ path: c.path, type: c.type }));

/** Resolve the (always symbolic) HEAD branch to its commit, or refuse if unborn. */
const resolveHeadCommit = async (ctx: Context, branch: RefName): Promise<ObjectId> => {
  try {
    return await resolveRef(ctx, branch);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_NOT_FOUND') throw noInitialCommit();
    throw err;
  }
};

/** The empty tree (`theirs` of a root-commit revert): materialised so it can be read. */
const emptyTree = (ctx: Context): Promise<ObjectId> => writeTree(ctx, []);

/** Build the new single-parent revert commit; returns its id and message subject (reflog). */
const buildRevertCommit = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  parentId: ObjectId,
  tree: ObjectId,
): Promise<{ readonly id: ObjectId; readonly subject: string }> => {
  const identity = await resolveCurrentIdentity(ctx);
  // equivalent-mutant (`allowEmpty: false` → `true`): `revertMessage` always
  // yields a non-empty `Revert "<subject>"` body, so the empty-message guard is
  // never exercised here — `allowEmpty` true vs false is indistinguishable.
  const message = sanitizeMessage(revertMessage(cData, source), { allowEmpty: false });
  const id = await createCommit(ctx, {
    tree,
    parents: [parentId],
    author: identity,
    committer: identity,
    message,
    extraHeaders: [],
  });
  return { id, subject: subjectLine(message) };
};

/** Apply one commit's reverse change onto `ourId`, committing when the merge is clean. */
const applyOneRevert = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  branch: RefName,
  ourId: ObjectId,
): Promise<RevertOutcome> => {
  const parentId = cData.parents[0];
  const theirsTree = parentId !== undefined ? await treeOf(ctx, parentId) : await emptyTree(ctx);
  const oursTree = await treeOf(ctx, ourId);
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const res = await applyMergeToWorktree(ctx, {
      baseTree: cData.tree,
      oursTree,
      theirsTree,
      currentIndex,
      labels: revertLabels(source, subjectLine(cData.message)),
    });
    if (res.kind === 'would-overwrite')
      throw workingTreeDirty({ localChanges: res.localChanges, untracked: res.untracked });
    if (res.kind === 'conflict') {
      await lock.commit(res.indexEntries);
      return { kind: 'conflict', conflicts: res.conflicts };
    }
    if (res.mergedTree === oursTree) return { kind: 'empty' };
    await lock.commit(res.result.newIndexEntries);
    const { id, subject } = await buildRevertCommit(ctx, source, cData, ourId, res.mergedTree);
    await updateRef(ctx, branch, id, { expected: ourId, reflogMessage: `revert: ${subject}` });
    return { kind: 'committed', id };
  } finally {
    await lock.release();
  }
};

/** Persist single-revert conflict state (`REVERT_HEAD` + the `Revert "…"` MERGE_MSG). */
const persistStop = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  conflicts: ReadonlyArray<MergeConflict>,
): Promise<void> => {
  await writeRevertHead(ctx, source);
  await writeMergeMsg(
    ctx,
    conflictMergeMsg(revertMessage(cData, source), sortedRecordedPaths(conflicts)),
  );
};

interface SequenceState {
  readonly multiPick: boolean;
  readonly sequenceHead: ObjectId;
  /**
   * What to do when the leading commit reverts empty: `'stop'` (a fresh run —
   * surface it as `kind:'empty'`) or `'drop'` (a `continue` that acknowledged
   * the empty — discard it and proceed past it).
   */
  readonly onEmpty: 'stop' | 'drop';
}

/** Read each commit's subject to build `revert <oid> <subject>` todo entries. */
const buildTodoEntries = async (
  ctx: Context,
  oids: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<TodoEntry>> => {
  const entries: TodoEntry[] = [];
  for (const oid of oids) {
    const cData = await readCommitData(ctx, oid);
    entries.push({ command: 'revert', oid, subject: subjectLine(cData.message) });
  }
  return entries;
};

/** Persist the git-faithful sequencer dir on a multi-revert stop. */
const writeSequencerStop = async (
  ctx: Context,
  seq: SequenceState,
  remaining: ReadonlyArray<ObjectId>,
  currentHead: ObjectId,
): Promise<void> => {
  await writeSequencerHead(ctx, seq.sequenceHead);
  await writeSequencerTodo(ctx, await buildTodoEntries(ctx, remaining));
  await writeAbortSafety(ctx, currentHead);
  // revert exposes no record-origin/allow-empty/no-commit resume flags, so the
  // opts file is always absent (the writer skips it when all options default).
  await writeSequencerOpts(ctx, { recordOrigin: false, allowEmpty: false, noCommit: false });
};

interface StopContext {
  readonly seq: SequenceState;
  readonly source: ObjectId;
  readonly cData: CommitData;
  readonly remaining: ReadonlyArray<ObjectId>;
  readonly currentHead: ObjectId;
}

/** Persist a conflict/empty stop (markers + sequencer for a multi-revert) and shape the result. */
const stopRun = async (
  ctx: Context,
  outcome:
    | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
    | { readonly kind: 'empty' },
  stop: StopContext,
): Promise<RevertResult> => {
  if (outcome.kind === 'conflict')
    await persistStop(ctx, stop.source, stop.cData, outcome.conflicts);
  if (stop.seq.multiPick) await writeSequencerStop(ctx, stop.seq, stop.remaining, stop.currentHead);
  const remaining = stop.remaining.length - 1;
  return outcome.kind === 'conflict'
    ? {
        kind: 'conflict',
        commit: stop.source,
        conflicts: toConflictList(outcome.conflicts),
        remaining,
      }
    : { kind: 'empty', commit: stop.source, remaining };
};

/**
 * Drive the revert work-list from `startOurId`, committing each clean revert and
 * advancing HEAD. A conflict persists `REVERT_HEAD` + `MERGE_MSG`; an empty revert
 * or a merge commit stops markerless (git has no `--allow-empty`). For a multi-
 * revert sequence each stop also persists the sequencer dir (current at `todo[0]`).
 */
const runSequence = async (
  ctx: Context,
  todo: ReadonlyArray<ObjectId>,
  branch: RefName,
  startOurId: ObjectId,
  seq: SequenceState,
): Promise<RevertResult> => {
  let ourId = startOurId;
  const applied: RevertedCommit[] = [];
  for (let i = 0; i < todo.length; i += 1) {
    const source = todo[i] as ObjectId;
    const cData = await readCommitData(ctx, source);
    if (isMergeCommit(cData)) {
      // Partial-apply: earlier reverts are committed. Stop AT the merge, keeping
      // it as todo[0] (no REVERT_HEAD — it never started).
      if (seq.multiPick) await writeSequencerStop(ctx, seq, todo.slice(i), ourId);
      throw revertMergeNoMainline(source);
    }
    const outcome = await applyOneRevert(ctx, source, cData, branch, ourId);
    if (outcome.kind === 'committed') {
      applied.push({ source, created: outcome.id });
      ourId = outcome.id;
      continue;
    }
    // A `continue` that already acknowledged the leading empty drops it and
    // proceeds; a later empty (i > 0) still stops on its own.
    if (outcome.kind === 'empty' && seq.onEmpty === 'drop' && i === 0) continue;
    return stopRun(ctx, outcome, {
      seq,
      source,
      cData,
      remaining: todo.slice(i),
      currentHead: ourId,
    });
  }
  await clearSequencer(ctx);
  return { kind: 'reverted', commits: applied };
};

const RANGE = /^(.+)\.\.(.+)$/;

/**
 * Commits in `from..to`, **newest-first** (git's revert range order — to undo a
 * span you revert its tip first). The whole ancestor set of `from` is excluded.
 */
const expandRange = async (
  ctx: Context,
  from: ObjectId,
  to: ObjectId,
): Promise<ReadonlyArray<ObjectId>> => {
  const excluded = new Set<ObjectId>();
  for await (const commit of walkCommits(ctx, { from: [from] })) {
    excluded.add(commit.id);
  }
  const ids: ObjectId[] = [];
  for await (const commit of walkCommits(ctx, { from: [to], until: [...excluded] })) {
    ids.push(commit.id);
  }
  return ids;
};

/**
 * Expand each argument to ordered commit oids — a single commit-ish or an `A..B`
 * range (newest-first). `A...B` / `^`-exclusion forms are rejected, not
 * mis-expanded.
 */
const expandRevisions = async (
  ctx: Context,
  args: ReadonlyArray<string>,
): Promise<ReadonlyArray<ObjectId>> => {
  const todo: ObjectId[] = [];
  for (const arg of args) {
    if (arg.includes('...') || arg.includes('^')) {
      throw invalidOption(
        'commits',
        `unsupported revision form '${arg}' (use a commit-ish or A..B)`,
      );
    }
    const match = RANGE.exec(arg);
    if (match === null) {
      todo.push(await resolveCommitIsh(ctx, arg));
      continue;
    }
    const from = await revParse(ctx, match[1] as string);
    const to = await revParse(ctx, match[2] as string);
    todo.push(...(await expandRange(ctx, from, to)));
  }
  return todo;
};

/**
 * `-n` / `--no-commit`: apply each reverse change to the index + working tree,
 * accumulating across the list, without creating any commit or persisting resume
 * state — even on conflict (verified against git). There is nothing to continue.
 */
const runNoCommit = async (ctx: Context, todo: ReadonlyArray<ObjectId>): Promise<RevertResult> => {
  const lock = await acquireIndexLock(ctx);
  try {
    let currentIndex = await readIndex(ctx);
    for (let i = 0; i < todo.length; i += 1) {
      const source = todo[i] as ObjectId;
      const cData = await readCommitData(ctx, source);
      if (isMergeCommit(cData)) throw revertMergeNoMainline(source);
      const parentId = cData.parents[0];
      const theirsTree =
        parentId !== undefined ? await treeOf(ctx, parentId) : await emptyTree(ctx);
      const oursTree = await synthesizeTreeFromIndex(ctx, currentIndex.entries);
      const res = await applyMergeToWorktree(ctx, {
        baseTree: cData.tree,
        oursTree,
        theirsTree,
        currentIndex,
        labels: revertLabels(source, subjectLine(cData.message)),
      });
      if (res.kind === 'would-overwrite')
        throw workingTreeDirty({ localChanges: res.localChanges, untracked: res.untracked });
      if (res.kind === 'conflict') {
        await lock.commit(res.indexEntries);
        return {
          kind: 'conflict',
          commit: source,
          conflicts: toConflictList(res.conflicts),
          remaining: todo.length - (i + 1),
        };
      }
      currentIndex = { ...currentIndex, entries: res.result.newIndexEntries };
    }
    await lock.commit(currentIndex.entries);
    return { kind: 'no-commit', sources: todo };
  } finally {
    await lock.release();
  }
};

export const revertRun = async (ctx: Context, input: RevertRunInput): Promise<RevertResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'revert');
  await assertNoPendingOperation(ctx);
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('revert', 'cannot revert with detached HEAD');
  }
  const ourId = await resolveHeadCommit(ctx, head.target);
  const todo = await expandRevisions(ctx, input.commits);
  await assertCleanWorkTree(ctx, await treeOf(ctx, ourId));
  if (input.noCommit === true) return runNoCommit(ctx, todo);
  const seq: SequenceState = { multiPick: todo.length > 1, sequenceHead: ourId, onEmpty: 'stop' };
  return runSequence(ctx, todo, head.target, ourId, seq);
};

const rejectUnmergedIndex = (entries: ReadonlyArray<IndexEntry>): void => {
  const unmerged = new Set<FilePath>();
  for (const entry of entries) {
    if (entry.flags.stage !== 0) unmerged.add(entry.path);
  }
  if (unmerged.size > 0) throw mergeHasConflicts(unmerged.size, [...unmerged]);
};

/**
 * Commit the resolved revert: single parent, current identity, the `MERGE_MSG`
 * draft (comments stripped), reflog **`commit: <subject>`** (plain — git writes no
 * `commit (revert):` prefix, verified).
 */
const commitResolvedRevert = async (
  ctx: Context,
  ourId: ObjectId,
  branch: RefName,
  tree: ObjectId,
): Promise<ObjectId> => {
  const identity = await resolveCurrentIdentity(ctx);
  const message = sanitizeMessage(stripComments((await readMergeMsg(ctx)) ?? ''), {
    allowEmpty: false,
  });
  const id = await createCommit(ctx, {
    tree,
    parents: [ourId],
    author: identity,
    committer: identity,
    message,
    extraHeaders: [],
  });
  await updateRef(ctx, branch, id, {
    expected: ourId,
    reflogMessage: `commit: ${subjectLine(message)}`,
  });
  return id;
};

/**
 * Finalise the in-progress conflicted revert from the resolved index. A no-change
 * resolution re-stops empty, **keeping** `REVERT_HEAD` (git's "nothing to commit"
 * — the user must `skip` or `commit --allow-empty`).
 */
const finaliseInProgressRevert = async (
  ctx: Context,
  branch: RefName,
  ourId: ObjectId,
): Promise<{ readonly created: ObjectId } | { readonly empty: true }> => {
  const index = await readIndex(ctx);
  rejectUnmergedIndex(index.entries);
  const indexTree = await synthesizeTreeFromIndex(ctx, index.entries);
  if (indexTree === (await treeOf(ctx, ourId))) return { empty: true };
  const created = await commitResolvedRevert(ctx, ourId, branch, indexTree);
  await clearRevertHead(ctx);
  await clearMergeMsg(ctx);
  return { created };
};

/**
 * Finalise the in-progress conflicted revert (if any) as a single-parent commit,
 * then resume the remaining sequencer reverts. Refuses when nothing is in progress
 * or the index is unmerged; a resolution that yields no change re-stops empty.
 */
export const revertContinue = async (ctx: Context): Promise<RevertResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'revert --continue');
  const source = await readRevertHead(ctx);
  const todoOnDisk = await readSequencerTodo(ctx);
  if (source === undefined && (todoOnDisk === undefined || todoOnDisk.length === 0)) {
    throw noOperationInProgress('revert');
  }
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('revert --continue', 'cannot continue with detached HEAD');
  }
  let ourId = await resolveRef(ctx, head.target);
  const applied: RevertedCommit[] = [];
  if (source !== undefined) {
    const remainingAfter = todoOnDisk !== undefined ? todoOnDisk.length - 1 : 0;
    const done = await finaliseInProgressRevert(ctx, head.target, ourId);
    if ('empty' in done) return { kind: 'empty', commit: source, remaining: remainingAfter };
    applied.push({ source, created: done.created });
    ourId = done.created;
  }
  // A finalised current revert is `todo[0]` — drop it; a markerless stop leaves it.
  // An empty `rest` flows through `runSequence` unchanged (it clears the sequencer
  // and returns `reverted []`), so no separate early-return is needed.
  const rest = (todoOnDisk ?? []).slice(source !== undefined ? 1 : 0).map((e) => e.oid);
  const sequenceHead = (await readSequencerHead(ctx)) ?? ourId;
  const onEmpty = source === undefined ? 'drop' : 'stop';
  const result = await runSequence(ctx, rest, head.target, ourId, {
    multiPick: true,
    sequenceHead,
    onEmpty,
  });
  return result.kind === 'reverted'
    ? { kind: 'reverted', commits: [...applied, ...result.commits] }
    : result;
};

export interface RevertAbortResult {
  readonly head: ObjectId;
  readonly branch: RefName;
}

/**
 * Drop the in-progress revert: hard-reset to HEAD (discarding its half-applied
 * state), then resume the remaining sequencer reverts (if any).
 */
export const revertSkip = async (ctx: Context): Promise<RevertResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'revert --skip');
  const source = await readRevertHead(ctx);
  const todoOnDisk = await readSequencerTodo(ctx);
  if (source === undefined && (todoOnDisk === undefined || todoOnDisk.length === 0)) {
    throw noOperationInProgress('revert');
  }
  const branch = await requireSymbolicHead(ctx, 'revert --skip');
  const ourId = await resolveRef(ctx, branch);
  await hardResetWorktreeToCommit(ctx, ourId);
  await clearRevertHead(ctx);
  await clearMergeMsg(ctx);
  // An empty `rest` flows through `runSequence` (clears the sequencer, returns
  // `reverted []`); no separate early-return is needed.
  const rest = (todoOnDisk ?? []).slice(1).map((e) => e.oid);
  const sequenceHead = (await readSequencerHead(ctx)) ?? ourId;
  return runSequence(ctx, rest, branch, ourId, { multiPick: true, sequenceHead, onEmpty: 'stop' });
};

/**
 * Abort the revert: hard-reset the working tree, index, and branch to the
 * pre-sequence HEAD (sequencer `head`, or the current HEAD for a lone revert),
 * and clear all state. The branch update records git's faithful
 * `reset: moving to <oid>` reflog. Refuses when nothing is in progress.
 */
export const revertAbort = async (ctx: Context): Promise<RevertAbortResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'revert --abort');
  const source = await readRevertHead(ctx);
  const seqHead = await readSequencerHead(ctx);
  if (source === undefined && seqHead === undefined) throw noOperationInProgress('revert');
  const branch = await requireSymbolicHead(ctx, 'revert --abort');
  const target = seqHead ?? (await resolveRef(ctx, branch));
  await abortSequencerReset(ctx, { branch, target, clearHead: clearRevertHead });
  return { head: target, branch };
};
