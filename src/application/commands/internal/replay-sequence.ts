/**
 * The replay machinery `cherry-pick` and `revert` share. Both replay each
 * commit as a 3-way merge onto HEAD through `applyMergeToWorktree`, stop on a
 * conflict or an empty change with git's sequencer state, and resume, skip or
 * abort that state the same way; a {@link ReplayCommand} carries what differs —
 * which trees play base and theirs, the conflict labels, the todo verb, the
 * stop-head file and the refusals.
 */
import { noOperationInProgress, workingTreeDirty } from '../../../domain/commands/error.js';
import { type TsgitError, unsupportedOperation } from '../../../domain/error.js';
import type { GitIndex } from '../../../domain/git-index/index.js';
import { viewOfEscaped } from '../../../domain/git-index/index-path-key.js';
import type { ConflictType, MergeConflict, MergeLabels } from '../../../domain/merge/index.js';
import type { CommitData } from '../../../domain/objects/commit.js';
import { subjectLine } from '../../../domain/objects/commit-message.js';
import type { AuthorIdentity, FilePath, ObjectId, RefName } from '../../../domain/objects/index.js';
import type { TodoCommand, TodoEntry } from '../../../domain/sequencer/index.js';
import type { PendingOperation } from '../../../domain/sequencer/operation-labels.js';
import type { Context } from '../../../ports/context.js';
import {
  type ApplyMergeInput,
  type ApplyMergeResult,
  applyMergeToWorktree,
} from '../../primitives/apply-merge-to-worktree.js';
import { createCommit } from '../../primitives/create-commit.js';
import { removeAutoMerge } from '../../primitives/internal/auto-merge-ref.js';
import { acquireIndexLock, type IndexLock } from '../../primitives/internal/index-lock.js';
import {
  assertNoPendingOperation,
  readHeadRaw,
  requireWorkTree,
} from '../../primitives/internal/repo-state.js';
import { assertEverySourceLoadable } from '../../primitives/object-store.js';
import { readIndex } from '../../primitives/read-index.js';
import { resolveRef } from '../../primitives/resolve-ref.js';
import { synthesizeTreeFromIndex } from '../../primitives/synthesize-tree-from-index.js';
import { updateRef } from '../../primitives/update-ref.js';
import { abortSequencerReset } from './abort-sequencer-reset.js';
import { assertCleanIndex, assertNoUnmergedEntries } from './clean-work-tree.js';
import { sanitizeMessage, stripComments } from './commit-message.js';
import { resolveCurrentIdentity } from './current-identity.js';
import {
  readCommitData,
  requireSymbolicHead,
  resolveHeadCommit,
  treeOf,
} from './history-rewrite.js';
import { clearMergeMsg, readMergeMsg } from './merge-state.js';
import { resolveSequencerRevisions, type SequencerRevisions } from './sequencer-revisions.js';
import {
  type ResolvedTodoEntry,
  readSequencerHead,
  readSequencerTodo,
  type SequencerOpts,
  writeAbortSafety,
  writeSequencerHead,
  writeSequencerOpts,
  writeSequencerTodo,
} from './sequencer-state.js';
import { rejectUnmergedIndex } from './unmerged-index.js';

/** The literal `HEAD`: a replay refuses a detached HEAD, so it always names the branch. */
export const HEAD: RefName = 'HEAD' as RefName;

/** The trees a replay merge takes from the commit it replays. */
export interface MergeSides {
  readonly baseTree: ObjectId | undefined;
  readonly theirsTree: ObjectId;
}

/** What one replay command (`cherry-pick`, `revert`) brings to the shared machinery. */
export interface ReplayCommand {
  readonly operation: PendingOperation;
  /** The verb a sequencer todo line records. */
  readonly todoCommand: TodoCommand;
  /** Refusal for a run started on a detached HEAD. */
  readonly detachedRefusal: string;
  /** The stop marker (`CHERRY_PICK_HEAD`, `REVERT_HEAD`) a conflicted replay leaves. */
  readonly readStopHead: (ctx: Context) => Promise<ObjectId | undefined>;
  readonly clearStopHead: (ctx: Context) => Promise<void>;
  /** Refusal for a merge commit, which needs a chosen mainline (`-m`). */
  readonly refuseMerge: (source: ObjectId) => TsgitError;
  readonly mergeSides: (ctx: Context, cData: CommitData) => Promise<MergeSides>;
  readonly labels: (source: ObjectId, subject: string) => MergeLabels;
}

export interface ReplayConflict {
  readonly path: FilePath;
  readonly type: ConflictType;
}

export interface ReplayedCommit {
  readonly source: ObjectId;
  readonly created: ObjectId;
}

/** The stop a replay run surfaces: a conflict to resolve or an empty change. */
export type ReplayStop =
  | {
      readonly kind: 'conflict';
      readonly commit: ObjectId;
      readonly conflicts: ReadonlyArray<ReplayConflict>;
      readonly remaining: number;
    }
  | { readonly kind: 'empty'; readonly commit: ObjectId; readonly remaining: number };

export type NoCommitResult =
  | { readonly kind: 'no-commit'; readonly sources: ReadonlyArray<ObjectId> }
  | Extract<ReplayStop, { readonly kind: 'conflict' }>;

/** A merge commit (≥2 parents) cannot be replayed without a chosen mainline (`-m`). */
const isMergeCommit = (cData: CommitData): boolean => cData.parents.length >= 2;

export const toConflictList = (
  conflicts: ReadonlyArray<MergeConflict>,
): ReadonlyArray<ReplayConflict> =>
  conflicts.map((c) => ({ path: viewOfEscaped(c.path), type: c.type }));

/**
 * A fresh run's pre-flight (after the caller's operational-tier check): a work
 * tree, no pending operation, every source loadable, an attached HEAD on a born branch
 * and a clean index (only free of unmerged entries under no-commit). Returns HEAD's commit and the resolved revisions.
 */
export const openReplayRun = async (
  ctx: Context,
  command: ReplayCommand,
  commits: ReadonlyArray<string>,
  { noCommit }: { readonly noCommit: boolean },
): Promise<{ readonly ourId: ObjectId; readonly revisions: SequencerRevisions }> => {
  requireWorkTree(ctx, command.operation);
  await assertNoPendingOperation(ctx);
  await assertEverySourceLoadable(ctx);
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic')
    throw unsupportedOperation(command.operation, command.detachedRefusal);
  const ourId = await resolveHeadCommit(ctx, head.target);
  const revisions = await resolveSequencerRevisions(ctx, commits);
  // Nothing is committed under --no-commit, so staged changes ride along; only unmerged entries refuse.
  if (noCommit) await assertNoUnmergedEntries(ctx);
  else await assertCleanIndex(ctx, await treeOf(ctx, ourId));
  return { ourId, revisions };
};

/** The commit to replay, or a merge commit, which a replay refuses. */
type ReplayCommit =
  | { readonly kind: 'merge' }
  | { readonly kind: 'replay'; readonly cData: CommitData };

const MERGE_COMMIT: ReplayCommit = { kind: 'merge' };

/** The commit to replay; a merge commit is reported, for the caller to stop at and refuse. */
export const readReplayCommit = async (ctx: Context, source: ObjectId): Promise<ReplayCommit> => {
  const cData = await readCommitData(ctx, source);
  return isMergeCommit(cData) ? MERGE_COMMIT : { kind: 'replay', cData };
};

/** The commit a replay merge applies. */
export interface Replayed {
  readonly source: ObjectId;
  readonly cData: CommitData;
}

type CleanMerge = Extract<ApplyMergeResult, { readonly kind: 'clean' }>;

type ConflictedMerge = {
  readonly kind: 'conflict';
  readonly conflicts: ReadonlyArray<MergeConflict>;
};

type ReplayMerge = CleanMerge | ConflictedMerge;

/**
 * Merge one replayed commit into the work tree: refuses to overwrite local
 * changes, and commits a conflicted merge's index under `lock`.
 */
const replayMerge = async (
  ctx: Context,
  lock: IndexLock,
  command: ReplayCommand,
  { source, cData }: Replayed,
  trees: Omit<ApplyMergeInput, 'labels'>,
): Promise<ReplayMerge> => {
  const labels = command.labels(source, subjectLine(cData.message));
  const res = await applyMergeToWorktree(ctx, { ...trees, labels });
  if (res.kind === 'would-overwrite')
    throw workingTreeDirty({ localChanges: res.localChanges, untracked: res.untracked });
  if (res.kind !== 'conflict') return res;
  await lock.commit(res.indexEntries, 'replace');
  return { kind: 'conflict', conflicts: res.conflicts };
};

/**
 * Replay `source` onto HEAD's commit `ourId` under the index lock: a conflict
 * comes back as is, a clean merge goes to `onClean` while the lock is held.
 */
export const replayOntoHead = async <Outcome>(
  ctx: Context,
  command: ReplayCommand,
  replayed: Replayed,
  ourId: ObjectId,
  onClean: (clean: CleanMerge, oursTree: ObjectId, lock: IndexLock) => Promise<Outcome>,
): Promise<Outcome | ConflictedMerge> => {
  const sides = await command.mergeSides(ctx, replayed.cData);
  const oursTree = await treeOf(ctx, ourId);
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const res = await replayMerge(ctx, lock, command, replayed, {
      ...sides,
      oursTree,
      currentIndex,
    });
    if (res.kind === 'conflict') return res;
    return await onClean(res, oursTree, lock);
  } finally {
    await lock.release();
  }
};

/** Replay `source` onto the accumulated index, its own HEAD being that index's tree. */
const replayOntoIndex = async (
  ctx: Context,
  lock: IndexLock,
  command: ReplayCommand,
  source: ObjectId,
  currentIndex: GitIndex,
): Promise<ReplayMerge> => {
  const read = await readReplayCommit(ctx, source);
  if (read.kind === 'merge') throw command.refuseMerge(source);
  const { cData } = read;
  const sides = await command.mergeSides(ctx, cData);
  const oursTree = await synthesizeTreeFromIndex(ctx, currentIndex.entries);
  return replayMerge(ctx, lock, command, { source, cData }, { ...sides, oursTree, currentIndex });
};

/**
 * `-n` / `--no-commit`: apply each replay to the index + working tree,
 * accumulating across the list, without creating any commit or persisting resume
 * state — even on conflict (verified against git). There is nothing to continue.
 */
export const runNoCommitReplay = async (
  ctx: Context,
  command: ReplayCommand,
  todo: ReadonlyArray<ObjectId>,
): Promise<NoCommitResult> => {
  const lock = await acquireIndexLock(ctx);
  try {
    const replayed = await accumulateReplays(ctx, lock, command, todo);
    if (replayed.kind === 'conflict') return replayed;
    await lock.commit(replayed.index.entries, 'replace');
    return { kind: 'no-commit', sources: todo };
  } finally {
    await lock.release();
  }
};

/**
 * The index lock commits once, so accumulate in memory across replays (the
 * working tree is written per replay by `applyMergeToWorktree`); the caller
 * commits the final accumulated index. Stops at the first conflict.
 */
const accumulateReplays = async (
  ctx: Context,
  lock: IndexLock,
  command: ReplayCommand,
  todo: ReadonlyArray<ObjectId>,
): Promise<
  Extract<NoCommitResult, { readonly kind: 'conflict' }> | { kind: 'accumulated'; index: GitIndex }
> => {
  let currentIndex = await readIndex(ctx);
  for (let i = 0; i < todo.length; i += 1) {
    const source = todo[i] as ObjectId;
    const res = await replayOntoIndex(ctx, lock, command, source, currentIndex);
    if (res.kind === 'conflict') {
      const conflicts = toConflictList(res.conflicts);
      return { kind: 'conflict', commit: source, conflicts, remaining: todo.length - (i + 1) };
    }
    currentIndex = { ...currentIndex, entries: res.result.newIndexEntries };
  }
  return { kind: 'accumulated', index: currentIndex };
};

/** Read each commit's subject to build `<verb> <oid> <subject>` todo entries. */
const buildTodoEntries = async (
  ctx: Context,
  command: TodoCommand,
  oids: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<TodoEntry>> => {
  const entries: TodoEntry[] = [];
  for (const oid of oids) {
    const cData = await readCommitData(ctx, oid);
    entries.push({ command, oid, subject: subjectLine(cData.message) });
  }
  return entries;
};

/** The sequencer dir a multi-commit run persists when it stops. */
export interface SequencerStop {
  readonly sequenceHead: ObjectId;
  /** The stopped commit first, then the ones after it. */
  readonly remaining: ReadonlyArray<ObjectId>;
  readonly currentHead: ObjectId;
  readonly opts: SequencerOpts;
}

/** Persist the git-faithful sequencer dir on a multi-commit stop. */
export const writeSequencerStop = async (
  ctx: Context,
  command: ReplayCommand,
  stop: SequencerStop,
): Promise<void> => {
  await writeSequencerHead(ctx, stop.sequenceHead);
  await writeSequencerTodo(ctx, await buildTodoEntries(ctx, command.todoCommand, stop.remaining));
  await writeAbortSafety(ctx, stop.currentHead);
  await writeSequencerOpts(ctx, stop.opts);
};

/** The state a `--continue` / `--skip` resumes: the stopped commit and the todo on disk. */
export interface ResumeState {
  readonly source: ObjectId | undefined;
  readonly todoOnDisk: ReadonlyArray<ResolvedTodoEntry> | undefined;
}

/**
 * A resume's pre-flight (after the caller's operational-tier check): a work
 * tree, a stopped replay or a non-empty todo to resume, and every source loadable.
 */
export const openReplayResume = async (
  ctx: Context,
  command: ReplayCommand,
  label: string,
): Promise<ResumeState> => {
  requireWorkTree(ctx, label);
  const source = await command.readStopHead(ctx);
  const todoOnDisk = await readSequencerTodo(ctx);
  if (source === undefined && (todoOnDisk === undefined || todoOnDisk.length === 0)) {
    throw noOperationInProgress(command.operation);
  }
  await assertEverySourceLoadable(ctx);
  return { source, todoOnDisk };
};

/** The branch an attached HEAD names; a `--continue` refuses a detached one. */
export const requireContinuableHead = async (ctx: Context, label: string): Promise<RefName> => {
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic')
    throw unsupportedOperation(label, 'cannot continue with detached HEAD');
  return head.target;
};

/** How finalising a stopped replay from the resolved index ended. */
export type Finalised = { readonly created: ObjectId } | { readonly empty: true };

/** The commit a resolved replay records: who authored it and how HEAD's reflog reads. */
export interface ResolvedCommit {
  readonly authorFor: (committer: AuthorIdentity) => AuthorIdentity;
  readonly reflogMessage: (subject: string) => string;
}

/**
 * Commit the resolved index tree onto `ourId`: single parent, the current
 * identity as committer, the `MERGE_MSG` draft (comments stripped) as message.
 */
export const commitResolvedReplay = async (
  ctx: Context,
  { ourId, tree }: { ourId: ObjectId; tree: ObjectId },
  resolved: ResolvedCommit,
): Promise<ObjectId> => {
  const committer = await resolveCurrentIdentity(ctx);
  const message = sanitizeMessage(stripComments((await readMergeMsg(ctx)) ?? ''), {
    allowEmpty: false,
  });
  const author = resolved.authorFor(committer);
  const parents = [ourId];
  const id = await createCommit(ctx, {
    tree,
    parents,
    author,
    committer,
    message,
    extraHeaders: [],
  });
  // Written through the literal `HEAD` — a `--continue` refuses on a detached
  // HEAD, so `HEAD` always names the branch being advanced here.
  const reflogMessage = resolved.reflogMessage(subjectLine(message));
  await updateRef(ctx, HEAD, id, { expected: ourId, reflogMessage });
  return id;
};

/**
 * Finalise the stopped replay from the resolved index onto `ourId`. Refuses an
 * unmerged index; a resolution that changes nothing re-stops empty (unless
 * `allowEmpty`), keeping the stop marker. A committed one clears the stop.
 */
export const finaliseResolvedReplay = async (
  ctx: Context,
  command: ReplayCommand,
  ourId: ObjectId,
  { allowEmpty, commit }: { allowEmpty: boolean; commit: (tree: ObjectId) => Promise<ObjectId> },
): Promise<Finalised> => {
  const index = await readIndex(ctx);
  rejectUnmergedIndex(index.entries);
  const indexTree = await synthesizeTreeFromIndex(ctx, index.entries);
  if (indexTree === (await treeOf(ctx, ourId)) && !allowEmpty) return { empty: true };
  const created = await commit(indexTree);
  await command.clearStopHead(ctx);
  await clearMergeMsg(ctx);
  await removeAutoMerge(ctx);
  return { created };
};

/** Where a `--continue` resumes the todo from, or the empty stop it re-surfaces. */
export type ContinueStart =
  | Extract<ReplayStop, { readonly kind: 'empty' }>
  | {
      readonly kind: 'resume';
      readonly applied: ReadonlyArray<ReplayedCommit>;
      readonly ourId: ObjectId;
      /** The todo left to replay: a finalised stop (`todo[0]`) is dropped, a markerless one kept. */
      readonly rest: ReadonlyArray<ObjectId>;
    };

/**
 * Finalise the stopped replay (when one is in progress) onto `ourId`. A
 * resolution that changes nothing re-stops empty; a committed one is the first
 * applied commit and the HEAD the remaining todo resumes from.
 */
export const finaliseStoppedReplay = async (
  { source, todoOnDisk }: ResumeState,
  ourId: ObjectId,
  finalise: (source: ObjectId, ourId: ObjectId) => Promise<Finalised>,
): Promise<ContinueStart> => {
  const todo = (todoOnDisk ?? []).map((entry) => entry.oid);
  if (source === undefined) return { kind: 'resume', applied: [], ourId, rest: todo };
  const remaining = todoOnDisk !== undefined ? todoOnDisk.length - 1 : 0;
  const done = await finalise(source, ourId);
  if ('empty' in done) return { kind: 'empty', commit: source, remaining };
  const applied = [{ source, created: done.created }];
  return { kind: 'resume', applied, ourId: done.created, rest: todo.slice(1) };
};

export interface ReplayAbortResult {
  readonly head: ObjectId;
  readonly branch: RefName;
}

/**
 * Abort the replay: hard-reset the working tree, index, and branch to the
 * pre-sequence HEAD (sequencer `head`, or the current HEAD for a lone replay),
 * and clear all state. The branch update records git's faithful
 * `reset: moving to <oid>` reflog. Refuses when nothing is in progress.
 */
export const abortReplay = async (
  ctx: Context,
  command: ReplayCommand,
  label: string,
): Promise<ReplayAbortResult> => {
  requireWorkTree(ctx, label);
  const source = await command.readStopHead(ctx);
  const seqHead = await readSequencerHead(ctx);
  if (source === undefined && seqHead === undefined) throw noOperationInProgress(command.operation);
  const branch = await requireSymbolicHead(ctx, label);
  const target = seqHead ?? (await resolveRef(ctx, branch));
  await abortSequencerReset(ctx, { target });
  return { head: target, branch };
};
