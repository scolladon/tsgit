/**
 * `revert` — record new commits that undo the changes introduced by existing
 * commits. The inverse of `cherry-pick`: each revert is a new single-parent
 * commit authored by the **current identity** (not the reverted commit's author)
 * whose patch is the **reverse** 3-way merge (`base = C`, `ours = HEAD`,
 * `theirs = parent(C)`) applied through the shared `applyMergeToWorktree`
 * primitive. Conflicts stop with a dedicated `REVERT_HEAD` state; an empty
 * revert (no net change) stops markerless (git has no `--allow-empty`).
 */
import { revertMergeNoMainline } from '../../domain/commands/error.js';
import { sortedRecordedPaths } from '../../domain/diff/index.js';
import { type ConflictType, type MergeConflict, revertLabels } from '../../domain/merge/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { subjectLine } from '../../domain/objects/commit-message.js';
import type { FilePath, ObjectId, RefName } from '../../domain/objects/index.js';
import { commitReflog, revertReflog } from '../../domain/reflog/reflog-messages.js';
import {
  REVERT,
  REVERT_ABORT,
  REVERT_CONTINUE,
  REVERT_SKIP,
} from '../../domain/sequencer/operation-labels.js';
import type { Context } from '../../ports/context.js';
import { createCommit } from '../primitives/create-commit.js';
import { assertOperationalRepository } from '../primitives/internal/repo-state.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { writeTree } from '../primitives/write-tree.js';
import { skipSequencerReset } from './internal/abort-sequencer-reset.js';
import { conflictMergeMsg } from './internal/cherry-pick-state.js';
import { sanitizeMessage } from './internal/commit-message.js';
import { resolveCurrentIdentity } from './internal/current-identity.js';
import { requireSymbolicHead, treeOf } from './internal/history-rewrite.js';
import { writeMergeMsg } from './internal/merge-state.js';
import {
  abortReplay,
  commitResolvedReplay,
  type Finalised,
  finaliseResolvedReplay,
  finaliseStoppedReplay,
  HEAD,
  openReplayResume,
  openReplayRun,
  type ReplayCommand,
  readReplayCommit,
  replayOntoHead,
  requireContinuableHead,
  runNoCommitReplay,
  toConflictList,
  writeSequencerStop,
} from './internal/replay-sequence.js';
import {
  clearRevertHead,
  readRevertHead,
  revertMessage,
  writeRevertHead,
} from './internal/revert-state.js';
import { isSequence } from './internal/sequencer-revisions.js';
import { clearSequencer, readSequencerHead } from './internal/sequencer-state.js';

export type { ConflictType } from '../../domain/merge/index.js';

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

/** The empty tree (`theirs` of a root-commit revert): materialised so it can be read. */
const emptyTree = (ctx: Context): Promise<ObjectId> => writeTree(ctx, []);

/** A revert replays `C` as the reverse 3-way merge `base = C`, `theirs = parent(C)`. */
const REVERT_COMMAND: ReplayCommand = {
  operation: REVERT,
  todoCommand: 'revert',
  detachedRefusal: 'cannot revert with detached HEAD',
  readStopHead: readRevertHead,
  clearStopHead: clearRevertHead,
  refuseMerge: revertMergeNoMainline,
  mergeSides: async (ctx, cData) => {
    const parentId = cData.parents[0];
    const theirsTree = parentId !== undefined ? await treeOf(ctx, parentId) : await emptyTree(ctx);
    return { baseTree: cData.tree, theirsTree };
  },
  labels: revertLabels,
};

/** Build the new single-parent revert commit; returns its id and message subject (reflog). */
const buildRevertCommit = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  parentId: ObjectId,
  tree: ObjectId,
): Promise<{ readonly id: ObjectId; readonly subject: string }> => {
  const identity = await resolveCurrentIdentity(ctx);
  // Stryker disable next-line BooleanLiteral: equivalent — revertMessage always yields a non-empty `Revert "<subject>"\n\nThis reverts commit <oid>.\n` body, so the empty-message guard never fires; allowEmpty false vs true is indistinguishable.
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
const applyOneRevert = (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  ourId: ObjectId,
): Promise<RevertOutcome> =>
  replayOntoHead(ctx, REVERT_COMMAND, { source, cData }, ourId, async (res, oursTree, lock) => {
    if (res.mergedTree === oursTree) return { kind: 'empty' };
    await lock.commit(res.result.newIndexEntries, 'replace');
    const { id, subject } = await buildRevertCommit(ctx, source, cData, ourId, res.mergedTree);
    // Written through the literal `HEAD` — revert refuses on a detached
    // HEAD, so `HEAD` always names the branch being advanced here.
    await updateRef(ctx, HEAD, id, { expected: ourId, reflogMessage: revertReflog(subject) });
    return { kind: 'committed', id };
  });

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

/** Persist the git-faithful sequencer dir when a multi-revert sequence stops. */
const stopSequence = async (
  ctx: Context,
  seq: SequenceState,
  remaining: ReadonlyArray<ObjectId>,
  currentHead: ObjectId,
): Promise<void> => {
  if (!seq.multiPick) return;
  // revert exposes no record-origin/allow-empty/no-commit resume flags, so the
  // opts file is always absent (the writer skips it when all options default).
  await writeSequencerStop(ctx, REVERT_COMMAND, {
    sequenceHead: seq.sequenceHead,
    remaining,
    currentHead,
    opts: { recordOrigin: false, allowEmpty: false, noCommit: false },
  });
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
  await stopSequence(ctx, stop.seq, stop.remaining, stop.currentHead);
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
  startOurId: ObjectId,
  seq: SequenceState,
): Promise<RevertResult> => {
  let ourId = startOurId;
  const applied: RevertedCommit[] = [];
  for (let i = 0; i < todo.length; i += 1) {
    const source = todo[i] as ObjectId;
    const read = await readReplayCommit(ctx, source);
    if (read.kind === 'merge') {
      // Partial-apply: earlier reverts are committed. A merge stops AT it, keeping
      // it as todo[0] (no REVERT_HEAD — it never started).
      await stopSequence(ctx, seq, todo.slice(i), ourId);
      throw REVERT_COMMAND.refuseMerge(source);
    }
    const { cData } = read;
    const outcome = await applyOneRevert(ctx, source, cData, ourId);
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

export const revertRun = async (ctx: Context, input: RevertRunInput): Promise<RevertResult> => {
  await assertOperationalRepository(ctx);
  const { ourId, revisions } = await openReplayRun(ctx, REVERT_COMMAND, input.commits);
  const todo = revisions.commits;
  if (input.noCommit === true) return runNoCommitReplay(ctx, REVERT_COMMAND, todo);
  const seq: SequenceState = {
    multiPick: isSequence(input.commits, revisions),
    sequenceHead: ourId,
    onEmpty: 'stop',
  };
  return runSequence(ctx, todo, ourId, seq);
};

/**
 * Finalise the in-progress conflicted revert from the resolved index: a
 * single-parent commit by the current identity with the `MERGE_MSG` draft
 * (comments stripped), reflog **`commit: <subject>`** (plain — git writes no
 * `commit (revert):` prefix, verified). A no-change resolution re-stops empty,
 * **keeping** `REVERT_HEAD` (git's "nothing to commit" — the user must `skip`
 * or `commit --allow-empty`).
 */
const finaliseInProgressRevert = (ctx: Context, ourId: ObjectId): Promise<Finalised> =>
  finaliseResolvedReplay(ctx, REVERT_COMMAND, ourId, {
    allowEmpty: false,
    commit: (tree) =>
      commitResolvedReplay(
        ctx,
        { ourId, tree },
        { authorFor: (committer) => committer, reflogMessage: commitReflog },
      ),
  });

/**
 * Finalise the in-progress conflicted revert (if any) as a single-parent commit,
 * then resume the remaining sequencer reverts. Refuses when nothing is in progress
 * or the index is unmerged; a resolution that yields no change re-stops empty.
 */
export const revertContinue = async (ctx: Context): Promise<RevertResult> => {
  await assertOperationalRepository(ctx);
  const resume = await openReplayResume(ctx, REVERT_COMMAND, REVERT_CONTINUE);
  const branch = await requireContinuableHead(ctx, REVERT_CONTINUE);
  const start = await finaliseStoppedReplay(resume, await resolveRef(ctx, branch), (_, ourId) =>
    finaliseInProgressRevert(ctx, ourId),
  );
  if (start.kind === 'empty') return start;
  const { applied, ourId, rest } = start;
  // An empty `rest` flows through `runSequence` unchanged (it clears the sequencer
  // and returns `reverted []`), so no separate early-return is needed.
  const sequenceHead = (await readSequencerHead(ctx)) ?? ourId;
  const onEmpty = resume.source === undefined ? 'drop' : 'stop';
  const result = await runSequence(ctx, rest, ourId, {
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
  const { todoOnDisk } = await openReplayResume(ctx, REVERT_COMMAND, REVERT_SKIP);
  const branch = await requireSymbolicHead(ctx, REVERT_SKIP);
  const ourId = await resolveRef(ctx, branch);
  await skipSequencerReset(ctx, ourId);
  // An empty `rest` flows through `runSequence` (clears the sequencer, returns
  // `reverted []`); no separate early-return is needed.
  const rest = (todoOnDisk ?? []).slice(1).map((e) => e.oid);
  const sequenceHead = (await readSequencerHead(ctx)) ?? ourId;
  return runSequence(ctx, rest, ourId, { multiPick: true, sequenceHead, onEmpty: 'stop' });
};

/**
 * Abort the revert: hard-reset the working tree, index, and branch to the
 * pre-sequence HEAD (sequencer `head`, or the current HEAD for a lone revert),
 * and clear all state. The branch update records git's faithful
 * `reset: moving to <oid>` reflog. Refuses when nothing is in progress.
 */
export const revertAbort = async (ctx: Context): Promise<RevertAbortResult> => {
  await assertOperationalRepository(ctx);
  return abortReplay(ctx, REVERT_COMMAND, REVERT_ABORT);
};
