/**
 * `cherry-pick` — apply the change introduced by one or more commits onto the
 * current branch as new single-parent commits, preserving each source commit's
 * author and message (the committer becomes the current identity). The patch is
 * a 3-way merge (`base = parent(C)`, `ours = HEAD`, `theirs = C`) via the shared
 * `applyMergeToWorktree` primitive. Conflicts and empty picks stop with a
 * dedicated `CHERRY_PICK_HEAD` state (distinct from the merge machine).
 */
import { cherryPickMergeNoMainline } from '../../domain/commands/error.js';
import { sortedRecordedPaths } from '../../domain/diff/index.js';
import { type ConflictType, type MergeConflict, replayLabels } from '../../domain/merge/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { subjectLine } from '../../domain/objects/commit-message.js';
import type { FilePath, ObjectId, RefName } from '../../domain/objects/index.js';
import { cherryPickReflog, commitCherryPickReflog } from '../../domain/reflog/reflog-messages.js';
import {
  CHERRY_PICK,
  CHERRY_PICK_ABORT,
  CHERRY_PICK_CONTINUE,
  CHERRY_PICK_SKIP,
} from '../../domain/sequencer/operation-labels.js';
import type { Context } from '../../ports/context.js';
import { createCommit } from '../primitives/create-commit.js';
import { assertOperationalRepository } from '../primitives/internal/repo-state.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { skipSequencerReset } from './internal/abort-sequencer-reset.js';
import {
  clearCherryPickHead,
  conflictMergeMsg,
  readCherryPickHead,
  writeCherryPickHead,
} from './internal/cherry-pick-state.js';
import { sanitizeMessage } from './internal/commit-message.js';
import { resolveCurrentIdentity } from './internal/current-identity.js';
import { readCommitData, requireSymbolicHead, treeOf } from './internal/history-rewrite.js';
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
import { isSequence, type SequencerRevisions } from './internal/sequencer-revisions.js';
import {
  clearSequencer,
  readSequencerHead,
  readSequencerOpts,
} from './internal/sequencer-state.js';

export type { ConflictType } from '../../domain/merge/index.js';

export interface CherryPickRunInput {
  /** Revisions to pick, in argument order — a commit-ish or an `A..B` range each. */
  readonly commits: ReadonlyArray<string>;
  /** -x: append `(cherry picked from commit <oid>)` to each commit message. */
  readonly recordOrigin?: boolean;
  /** --allow-empty: a redundant pick creates an empty commit instead of stopping. */
  readonly allowEmpty?: boolean;
  /** -n / --no-commit: apply each pick to the index + working tree only; never
   *  commit, never persist CHERRY_PICK_HEAD / sequencer state. */
  readonly noCommit?: boolean;
}

/** Resolved run options threaded through the per-pick helpers. */
interface PickOptions {
  readonly recordOrigin: boolean;
  readonly allowEmpty: boolean;
}

export interface CherryPickedCommit {
  readonly source: ObjectId;
  readonly created: ObjectId;
}

export interface CherryPickConflict {
  readonly path: FilePath;
  readonly type: ConflictType;
}

export type CherryPickResult =
  | { readonly kind: 'picked'; readonly commits: ReadonlyArray<CherryPickedCommit> }
  | { readonly kind: 'no-commit'; readonly sources: ReadonlyArray<ObjectId> }
  | {
      readonly kind: 'conflict';
      readonly commit: ObjectId;
      readonly conflicts: ReadonlyArray<CherryPickConflict>;
      readonly remaining: number;
    }
  | { readonly kind: 'empty'; readonly commit: ObjectId; readonly remaining: number };

type PickOutcome =
  | { readonly kind: 'committed'; readonly id: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
  | { readonly kind: 'empty' };

/** A pick replays `C` as the 3-way merge `base = parent(C)`, `theirs = C`. */
const CHERRY_PICK_COMMAND: ReplayCommand = {
  operation: CHERRY_PICK,
  todoCommand: 'pick',
  detachedRefusal: 'cannot cherry-pick with detached HEAD',
  readStopHead: readCherryPickHead,
  clearStopHead: clearCherryPickHead,
  refuseMerge: cherryPickMergeNoMainline,
  mergeSides: async (ctx, cData) => {
    const parentId = cData.parents[0];
    const baseTree = parentId !== undefined ? await treeOf(ctx, parentId) : undefined;
    return { baseTree, theirsTree: cData.tree };
  },
  labels: replayLabels,
};

/**
 * git's `prepare_revs` for a pick: a walked range is replayed oldest first,
 * listed commits in argument order.
 */
const pickOrder = (revisions: SequencerRevisions): ReadonlyArray<ObjectId> =>
  revisions.kind === 'walked' ? [...revisions.commits].reverse() : revisions.commits;

interface SequenceState {
  readonly multiPick: boolean;
  readonly sequenceHead: ObjectId;
}

/** Persist the git-faithful sequencer dir when a multi-pick sequence stops. */
const stopSequence = async (
  ctx: Context,
  seq: SequenceState,
  remaining: ReadonlyArray<ObjectId>,
  currentHead: ObjectId,
  opts: PickOptions,
): Promise<void> => {
  if (!seq.multiPick) return;
  await writeSequencerStop(ctx, CHERRY_PICK_COMMAND, {
    sequenceHead: seq.sequenceHead,
    remaining,
    currentHead,
    opts: { recordOrigin: opts.recordOrigin, allowEmpty: opts.allowEmpty, noCommit: false },
  });
};

/**
 * Drive the pick work-list from `startOurId`, committing each clean pick and
 * advancing HEAD. On a conflict/empty stop it persists `CHERRY_PICK_HEAD` +
 * `MERGE_MSG` and, for a multi-pick sequence, the sequencer dir (current pick at
 * `todo[0]`, remaining after). On full consumption it clears any sequencer state.
 */
const runSequence = async (
  ctx: Context,
  todo: ReadonlyArray<ObjectId>,
  startOurId: ObjectId,
  opts: PickOptions,
  seq: SequenceState,
): Promise<CherryPickResult> => {
  let ourId = startOurId;
  const applied: CherryPickedCommit[] = [];
  for (let i = 0; i < todo.length; i += 1) {
    const source = todo[i] as ObjectId;
    const read = await readReplayCommit(ctx, source);
    if (read.kind === 'merge') {
      // Partial-apply: earlier picks are already committed. A merge stops AT it —
      // the sequencer keeps it as todo[0] (no CHERRY_PICK_HEAD, since it never
      // started). The user resolves with `skip` or `abort`.
      await stopSequence(ctx, seq, todo.slice(i), ourId, opts);
      throw CHERRY_PICK_COMMAND.refuseMerge(source);
    }
    const { cData } = read;
    const outcome = await applyOnePick(ctx, source, cData, ourId, opts);
    if (outcome.kind === 'committed') {
      applied.push({ source, created: outcome.id });
      ourId = outcome.id;
      continue;
    }
    await persistStop(
      ctx,
      source,
      cData,
      outcome.kind === 'conflict' ? outcome.conflicts : undefined,
      opts,
    );
    await stopSequence(ctx, seq, todo.slice(i), ourId, opts);
    const remaining = todo.length - (i + 1);
    return outcome.kind === 'conflict'
      ? {
          kind: 'conflict',
          commit: source,
          conflicts: toConflictList(outcome.conflicts),
          remaining,
        }
      : { kind: 'empty', commit: source, remaining };
  }
  await clearSequencer(ctx);
  return { kind: 'picked', commits: applied };
};

/** git's `-x` footer: a blank line then `(cherry picked from commit <full-oid>)`. */
const appendCherryPickOrigin = (message: string, source: ObjectId): string =>
  // equivalent-mutant (`/\s$/`): sanitizeMessage re-runs stripspace on this draft, so the greedy
  // `\s+$` and single-char `\s$` trailing-whitespace strips collapse to identical bytes.
  // The same-line sibling `/\S+$/` (strip the last word) is NOT equivalent — picking -x a
  // source message that lacks a trailing newline drops its final word — so the line stays
  // unsuppressed (a Regex directive would also mask the killable `/\S+$/`).
  `${message.replace(/\s+$/, '')}\n\n(cherry picked from commit ${source})`;

/** The message a pick will commit: the source message, optionally `-x`-stamped. */
const messageDraft = (message: string, source: ObjectId, recordOrigin: boolean): string =>
  recordOrigin ? appendCherryPickOrigin(message, source) : message;

/** Build the new commit: preserved author + message, current committer, single parent. */
const createPickCommit = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  parentId: ObjectId,
  tree: ObjectId,
  opts: PickOptions,
): Promise<ObjectId> => {
  const committer = await resolveCurrentIdentity(ctx);
  return createCommit(ctx, {
    tree,
    parents: [parentId],
    author: cData.author,
    committer,
    message: sanitizeMessage(messageDraft(cData.message, source, opts.recordOrigin), {
      allowEmpty: false,
    }),
    extraHeaders: [],
  });
};

/** Apply one commit's change onto `ourId`, committing it when the merge is clean. */
const applyOnePick = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  ourId: ObjectId,
  opts: PickOptions,
): Promise<PickOutcome> =>
  replayOntoHead(
    ctx,
    CHERRY_PICK_COMMAND,
    { source, cData },
    ourId,
    async (res, oursTree, lock) => {
      if (res.mergedTree === oursTree && !opts.allowEmpty) return { kind: 'empty' };
      await lock.commit(res.result.newIndexEntries, 'replace');
      const id = await createPickCommit(ctx, source, cData, ourId, res.mergedTree, opts);
      // Written through the literal `HEAD` — cherry-pick refuses on a
      // detached HEAD, so `HEAD` always names the branch being advanced here.
      await updateRef(ctx, HEAD, id, {
        expected: ourId,
        reflogMessage: cherryPickReflog(subjectLine(cData.message)),
      });
      return { kind: 'committed', id };
    },
  );

/** Persist single-pick stop state (`CHERRY_PICK_HEAD` + `MERGE_MSG`). */
const persistStop = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  conflicts: ReadonlyArray<MergeConflict> | undefined,
  opts: PickOptions,
): Promise<void> => {
  await writeCherryPickHead(ctx, source);
  const draft = messageDraft(cData.message, source, opts.recordOrigin);
  // An unclean pick with nothing unmerged (a directory rename split) still gets git's empty block.
  const message =
    conflicts !== undefined ? conflictMergeMsg(draft, sortedRecordedPaths(conflicts)) : draft;
  await writeMergeMsg(ctx, message);
};

export const cherryPickRun = async (
  ctx: Context,
  input: CherryPickRunInput,
): Promise<CherryPickResult> => {
  await assertOperationalRepository(ctx);
  const { ourId, revisions } = await openReplayRun(ctx, CHERRY_PICK_COMMAND, input.commits, {
    noCommit: input.noCommit === true,
  });
  const todo = pickOrder(revisions);
  if (input.noCommit === true) return runNoCommitReplay(ctx, CHERRY_PICK_COMMAND, todo);
  const opts: PickOptions = {
    recordOrigin: input.recordOrigin ?? false,
    allowEmpty: input.allowEmpty ?? false,
  };
  const seq: SequenceState = {
    multiPick: isSequence(input.commits, revisions),
    sequenceHead: ourId,
  };
  return runSequence(ctx, todo, ourId, opts, seq);
};

export interface CherryPickContinueInput {
  /** --allow-empty: finalise a resolution that yields no change as an empty commit. */
  readonly allowEmpty?: boolean;
}

/** Commit the resolved pick: single parent, preserved author, MERGE_MSG (comments stripped). */
const commitResolvedPick = async (
  ctx: Context,
  source: ObjectId,
  ourId: ObjectId,
  tree: ObjectId,
): Promise<ObjectId> => {
  const cData = await readCommitData(ctx, source);
  return commitResolvedReplay(
    ctx,
    { ourId, tree },
    { authorFor: () => cData.author, reflogMessage: commitCherryPickReflog },
  );
};

/** Resume options: a multi-pick sequence's persisted opts win; else the input. */
const resolveResumeOpts = async (
  ctx: Context,
  input: CherryPickContinueInput,
): Promise<PickOptions> => {
  if ((await readSequencerHead(ctx)) !== undefined) {
    const onDisk = await readSequencerOpts(ctx);
    return { recordOrigin: onDisk.recordOrigin, allowEmpty: onDisk.allowEmpty };
  }
  // equivalent-mutant (`recordOrigin`): this is the lone-pick resume (no sequencer), where
  // the remaining-pick runSequence is unreachable (rest is empty) and commitResolvedPick
  // ignores recordOrigin — its value is never observed. The line stays unsuppressed (a
  // BooleanLiteral directive would also mask the killable `allowEmpty` default).
  return { recordOrigin: false, allowEmpty: input.allowEmpty ?? false };
};

/** Finalise the in-progress conflicted pick (if any) and resume the sequencer todo. */
const finaliseInProgressPick = (
  ctx: Context,
  source: ObjectId,
  ourId: ObjectId,
  opts: PickOptions,
): Promise<Finalised> =>
  finaliseResolvedReplay(ctx, CHERRY_PICK_COMMAND, ourId, {
    allowEmpty: opts.allowEmpty,
    commit: (tree) => commitResolvedPick(ctx, source, ourId, tree),
  });

/**
 * Finalise the in-progress conflicted pick as a single-parent commit from the
 * resolved index, then resume any remaining sequencer picks. Refuses when nothing
 * is in progress or the index is unmerged. A no-change resolution re-stops empty.
 */
export const cherryPickContinue = async (
  ctx: Context,
  input: CherryPickContinueInput = {},
): Promise<CherryPickResult> => {
  await assertOperationalRepository(ctx);
  const resume = await openReplayResume(ctx, CHERRY_PICK_COMMAND, CHERRY_PICK_CONTINUE);
  const branch = await requireContinuableHead(ctx, CHERRY_PICK_CONTINUE);
  const opts = await resolveResumeOpts(ctx, input);
  const start = await finaliseStoppedReplay(
    resume,
    await resolveRef(ctx, branch),
    (source, ourId) => finaliseInProgressPick(ctx, source, ourId, opts),
  );
  if (start.kind === 'empty') return start;
  const { applied, ourId, rest } = start;
  // Stryker disable next-line BlockStatement: equivalent — this early return only
  // short-circuits the empty-rest case that runSequence([]) already handles identically
  // (clearSequencer then return picked), so emptying the block changes no observable state.
  if (rest.length === 0) {
    await clearSequencer(ctx);
    return { kind: 'picked', commits: applied };
  }
  const sequenceHead = (await readSequencerHead(ctx)) ?? ourId;
  const result = await runSequence(ctx, rest, ourId, opts, {
    multiPick: true,
    sequenceHead,
  });
  return result.kind === 'picked'
    ? { kind: 'picked', commits: [...applied, ...result.commits] }
    : result;
};

export interface CherryPickAbortResult {
  readonly head: ObjectId;
  readonly branch: RefName;
}

/**
 * Drop the in-progress pick: hard-reset to HEAD (discarding its half-applied
 * state), then resume the remaining sequencer picks (if any).
 */
export const cherryPickSkip = async (
  ctx: Context,
  input: CherryPickContinueInput = {},
): Promise<CherryPickResult> => {
  await assertOperationalRepository(ctx);
  const { todoOnDisk } = await openReplayResume(ctx, CHERRY_PICK_COMMAND, CHERRY_PICK_SKIP);
  const branch = await requireSymbolicHead(ctx, CHERRY_PICK_SKIP);
  const ourId = await resolveRef(ctx, branch);
  const opts = await resolveResumeOpts(ctx, input);
  await skipSequencerReset(ctx, ourId);
  // Skip always drops the current instruction (todo[0]) — whether it stopped as a
  // conflict (CHERRY_PICK_HEAD set) or a merge (no head). Resume the rest.
  const rest = (todoOnDisk ?? []).slice(1).map((e) => e.oid);
  // Stryker disable next-line BlockStatement: equivalent — this early return only
  // short-circuits the empty-rest case that runSequence([]) already handles identically
  // (clearSequencer then return picked), so emptying the block changes no observable state.
  if (rest.length === 0) {
    await clearSequencer(ctx);
    return { kind: 'picked', commits: [] };
  }
  const sequenceHead = (await readSequencerHead(ctx)) ?? ourId;
  return runSequence(ctx, rest, ourId, opts, { multiPick: true, sequenceHead });
};

/**
 * Abort the cherry-pick: hard-reset the working tree, index, and branch to the
 * pre-sequence HEAD (sequencer `head`, or the current HEAD for a lone pick), and
 * clear all state. The branch update records git's faithful
 * `reset: moving to <oid>` reflog. Refuses when nothing is in progress.
 */
export const cherryPickAbort = async (ctx: Context): Promise<CherryPickAbortResult> => {
  await assertOperationalRepository(ctx);
  return abortReplay(ctx, CHERRY_PICK_COMMAND, CHERRY_PICK_ABORT);
};
