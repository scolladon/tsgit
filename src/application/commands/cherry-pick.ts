/**
 * `cherry-pick` — apply the change introduced by one or more commits onto the
 * current branch as new single-parent commits, preserving each source commit's
 * author and message (the committer becomes the current identity). The patch is
 * a 3-way merge (`base = parent(C)`, `ours = HEAD`, `theirs = C`) via the shared
 * `applyMergeToWorktree` primitive. Conflicts and empty picks stop with a
 * dedicated `CHERRY_PICK_HEAD` state (distinct from the merge machine).
 */
import {
  cherryPickMergeNoMainline,
  invalidOption,
  mergeHasConflicts,
  noInitialCommit,
  noOperationInProgress,
  workingTreeDirty,
} from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { unsupportedOperation } from '../../domain/index.js';
import type { ConflictType, MergeConflict } from '../../domain/merge/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { AuthorIdentity, FilePath, ObjectId, RefName } from '../../domain/objects/index.js';
import type { TodoEntry } from '../../domain/sequencer/index.js';
import type { Context } from '../../ports/context.js';
import { applyMergeToWorktree } from '../primitives/apply-merge-to-worktree.js';
import { readConfig } from '../primitives/config-read.js';
import { createCommit } from '../primitives/create-commit.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  readHeadRaw,
} from '../primitives/internal/repo-state.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { synthesizeTreeFromIndex } from '../primitives/synthesize-tree-from-index.js';
import { updateRef } from '../primitives/update-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import {
  clearCherryPickHead,
  conflictMergeMsg,
  readCherryPickHead,
  writeCherryPickHead,
} from './internal/cherry-pick-state.js';
import { assertCleanWorkTree } from './internal/clean-work-tree.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { resolveCommitter, sanitizeMessage, stripComments } from './internal/commit-message.js';
import { acquireIndexLock } from './internal/index-update.js';
import { clearMergeMsg, readMergeMsg, writeMergeMsg } from './internal/merge-state.js';
import { hardResetWorktreeToCommit } from './internal/reset-worktree.js';
import {
  clearSequencer,
  readSequencerHead,
  readSequencerOpts,
  readSequencerTodo,
  writeAbortSafety,
  writeSequencerHead,
  writeSequencerOpts,
  writeSequencerTodo,
} from './internal/sequencer-state.js';
import { revParse } from './rev-parse.js';

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

const readCommitData = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, id);
  return obj.data;
};

const treeOf = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> =>
  (await readCommitData(ctx, commitId)).tree;

const subjectOf = (message: string): string => message.split('\n')[0] as string;

/** A merge commit (≥2 parents) cannot be picked without a chosen mainline (`-m`). */
const isMergeCommit = (cData: CommitData): boolean => cData.parents.length >= 2;

const toConflictList = (
  conflicts: ReadonlyArray<MergeConflict>,
): ReadonlyArray<CherryPickConflict> => conflicts.map((c) => ({ path: c.path, type: c.type }));

const RANGE = /^(.+)\.\.(.+)$/;

/**
 * Commits in `from..to`, oldest-first (git's range order) — the set reachable
 * from `to` minus everything reachable from `from`. `from`'s whole ancestor set
 * is excluded (not just `from` itself): otherwise a shared root reached down a
 * divergent branch leaks in, since `until` is membership-only.
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
  return ids.reverse();
};

/**
 * Expand each argument to ordered commit oids — a single commit-ish (ref / oid /
 * abbrev / peeled tag) or an `A..B` range (oldest-first). `A...B` / `^`-exclusion
 * forms are rejected (deferred), never mis-expanded.
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

/** Read each commit's subject to build `pick <oid> <subject>` todo entries. */
const buildTodoEntries = async (
  ctx: Context,
  oids: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<TodoEntry>> => {
  const entries: TodoEntry[] = [];
  for (const oid of oids) {
    const cData = await readCommitData(ctx, oid);
    entries.push({ command: 'pick', oid, subject: subjectOf(cData.message) });
  }
  return entries;
};

interface SequenceState {
  readonly multiPick: boolean;
  readonly sequenceHead: ObjectId;
}

/** Persist the git-faithful sequencer dir on a multi-pick stop. */
const writeSequencerStop = async (
  ctx: Context,
  seq: SequenceState,
  remaining: ReadonlyArray<ObjectId>,
  currentHead: ObjectId,
  opts: PickOptions,
): Promise<void> => {
  await writeSequencerHead(ctx, seq.sequenceHead);
  await writeSequencerTodo(ctx, await buildTodoEntries(ctx, remaining));
  await writeAbortSafety(ctx, currentHead);
  await writeSequencerOpts(ctx, {
    recordOrigin: opts.recordOrigin,
    allowEmpty: opts.allowEmpty,
    noCommit: false,
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
  branch: RefName,
  startOurId: ObjectId,
  opts: PickOptions,
  seq: SequenceState,
): Promise<CherryPickResult> => {
  let ourId = startOurId;
  const applied: CherryPickedCommit[] = [];
  for (let i = 0; i < todo.length; i += 1) {
    const source = todo[i] as ObjectId;
    const cData = await readCommitData(ctx, source);
    if (isMergeCommit(cData)) {
      // Partial-apply: earlier picks are already committed. Stop AT the merge —
      // the sequencer keeps it as todo[0] (no CHERRY_PICK_HEAD, since it never
      // started). The user resolves with `skip` or `abort`.
      if (seq.multiPick) await writeSequencerStop(ctx, seq, todo.slice(i), ourId, opts);
      throw cherryPickMergeNoMainline(source);
    }
    const outcome = await applyOnePick(ctx, source, cData, branch, ourId, opts);
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
    if (seq.multiPick) await writeSequencerStop(ctx, seq, todo.slice(i), ourId, opts);
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
  `${message.replace(/\s+$/, '')}\n\n(cherry picked from commit ${source})`;

/** The message a pick will commit: the source message, optionally `-x`-stamped. */
const messageDraft = (message: string, source: ObjectId, recordOrigin: boolean): string =>
  recordOrigin ? appendCherryPickOrigin(message, source) : message;

/** Resolve the (always symbolic — detached is refused upstream) HEAD branch to
 *  its commit oid, or refuse on an unborn branch. */
const resolveHeadCommit = async (ctx: Context, branch: RefName): Promise<ObjectId> => {
  try {
    return await resolveRef(ctx, branch);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_NOT_FOUND') throw noInitialCommit();
    throw err;
  }
};

/** The committer is the current identity (config `user.*`, now) — not the picked author. */
const resolvePickCommitter = async (ctx: Context): Promise<AuthorIdentity> => {
  const config = await readConfig(ctx);
  const user = config.user;
  const configUser =
    user !== undefined
      ? {
          name: user.name,
          email: user.email,
          timestamp: Math.floor(Date.now() / 1000),
          timezoneOffset: '+0000',
        }
      : undefined;
  return resolveCommitter(configUser !== undefined ? { configUser } : {});
};

/** Build the new commit: preserved author + message, current committer, single parent. */
const createPickCommit = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  parentId: ObjectId,
  tree: ObjectId,
  opts: PickOptions,
): Promise<ObjectId> => {
  const committer = await resolvePickCommitter(ctx);
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
  branch: RefName,
  ourId: ObjectId,
  opts: PickOptions,
): Promise<PickOutcome> => {
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
    if (res.mergedTree === oursTree && !opts.allowEmpty) return { kind: 'empty' };
    await lock.commit(res.result.newIndexEntries);
    const id = await createPickCommit(ctx, source, cData, ourId, res.mergedTree, opts);
    await updateRef(ctx, branch, id, {
      expected: ourId,
      reflogMessage: `cherry-pick: ${subjectOf(cData.message)}`,
    });
    return { kind: 'committed', id };
  } finally {
    await lock.release();
  }
};

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
  const message =
    conflicts !== undefined && conflicts.length > 0
      ? conflictMergeMsg(
          draft,
          conflicts.map((c) => c.path),
        )
      : draft;
  await writeMergeMsg(ctx, message);
};

/**
 * `-n` / `--no-commit`: apply each pick to the index + working tree, accumulating
 * across the list, without creating any commit or persisting resume state — even
 * on conflict (verified against git). There is nothing to `continue`.
 */
const runNoCommit = async (
  ctx: Context,
  todo: ReadonlyArray<ObjectId>,
): Promise<CherryPickResult> => {
  const lock = await acquireIndexLock(ctx);
  try {
    // The index lock commits once, so accumulate in memory across picks (the
    // working tree is written per pick by `applyMergeToWorktree`) and commit the
    // final accumulated index at the end.
    let currentIndex = await readIndex(ctx);
    for (let i = 0; i < todo.length; i += 1) {
      const source = todo[i] as ObjectId;
      const cData = await readCommitData(ctx, source);
      if (isMergeCommit(cData)) throw cherryPickMergeNoMainline(source);
      const parentId = cData.parents[0];
      const baseTree = parentId !== undefined ? await treeOf(ctx, parentId) : undefined;
      const oursTree = await synthesizeTreeFromIndex(ctx, currentIndex.entries);
      const res = await applyMergeToWorktree(ctx, {
        baseTree,
        oursTree,
        theirsTree: cData.tree,
        currentIndex,
      });
      if (res.kind === 'would-overwrite') throw workingTreeDirty(res.paths);
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

export const cherryPickRun = async (
  ctx: Context,
  input: CherryPickRunInput,
): Promise<CherryPickResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'cherry-pick');
  await assertNoPendingOperation(ctx);
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('cherry-pick', 'cannot cherry-pick with detached HEAD');
  }
  const ourId = await resolveHeadCommit(ctx, head.target);
  const todo = await expandRevisions(ctx, input.commits);
  await assertCleanWorkTree(ctx, await treeOf(ctx, ourId));
  if (input.noCommit === true) return runNoCommit(ctx, todo);
  const opts: PickOptions = {
    recordOrigin: input.recordOrigin ?? false,
    allowEmpty: input.allowEmpty ?? false,
  };
  const seq: SequenceState = { multiPick: todo.length > 1, sequenceHead: ourId };
  return runSequence(ctx, todo, head.target, ourId, opts, seq);
};

export interface CherryPickContinueInput {
  /** --allow-empty: finalise a resolution that yields no change as an empty commit. */
  readonly allowEmpty?: boolean;
}

const rejectUnmergedIndex = (entries: ReadonlyArray<IndexEntry>): void => {
  const unmerged = new Set<FilePath>();
  for (const entry of entries) {
    if (entry.flags.stage !== 0) unmerged.add(entry.path);
  }
  if (unmerged.size > 0) throw mergeHasConflicts(unmerged.size, [...unmerged]);
};

/** Commit the resolved pick: single parent, preserved author, MERGE_MSG (comments stripped). */
const commitResolvedPick = async (
  ctx: Context,
  source: ObjectId,
  ourId: ObjectId,
  branch: RefName,
  tree: ObjectId,
): Promise<ObjectId> => {
  const cData = await readCommitData(ctx, source);
  const committer = await resolvePickCommitter(ctx);
  const message = sanitizeMessage(stripComments((await readMergeMsg(ctx)) ?? ''), {
    allowEmpty: false,
  });
  const id = await createCommit(ctx, {
    tree,
    parents: [ourId],
    author: cData.author,
    committer,
    message,
    extraHeaders: [],
  });
  await updateRef(ctx, branch, id, {
    expected: ourId,
    reflogMessage: `commit (cherry-pick): ${subjectOf(message)}`,
  });
  return id;
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
  return { recordOrigin: false, allowEmpty: input.allowEmpty ?? false };
};

/** Finalise the in-progress conflicted pick (if any) and resume the sequencer todo. */
const finaliseInProgressPick = async (
  ctx: Context,
  source: ObjectId,
  branch: RefName,
  ourId: ObjectId,
  opts: PickOptions,
): Promise<{ readonly created: ObjectId } | { readonly empty: true }> => {
  const index = await readIndex(ctx);
  rejectUnmergedIndex(index.entries);
  const indexTree = await synthesizeTreeFromIndex(ctx, index.entries);
  if (indexTree === (await treeOf(ctx, ourId)) && !opts.allowEmpty) {
    return { empty: true };
  }
  const created = await commitResolvedPick(ctx, source, ourId, branch, indexTree);
  await clearCherryPickHead(ctx);
  await clearMergeMsg(ctx);
  return { created };
};

/**
 * Finalise the in-progress conflicted pick as a single-parent commit from the
 * resolved index, then resume any remaining sequencer picks. Refuses when nothing
 * is in progress or the index is unmerged. A no-change resolution re-stops empty.
 */
export const cherryPickContinue = async (
  ctx: Context,
  input: CherryPickContinueInput = {},
): Promise<CherryPickResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'cherry-pick --continue');
  const source = await readCherryPickHead(ctx);
  const todoOnDisk = await readSequencerTodo(ctx);
  if (source === undefined && (todoOnDisk === undefined || todoOnDisk.length === 0)) {
    throw noOperationInProgress('cherry-pick');
  }
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('cherry-pick --continue', 'cannot continue with detached HEAD');
  }
  const opts = await resolveResumeOpts(ctx, input);
  let ourId = await resolveRef(ctx, head.target);
  const applied: CherryPickedCommit[] = [];
  if (source !== undefined) {
    const remainingAfter = todoOnDisk !== undefined ? todoOnDisk.length - 1 : 0;
    const done = await finaliseInProgressPick(ctx, source, head.target, ourId, opts);
    if ('empty' in done) return { kind: 'empty', commit: source, remaining: remainingAfter };
    applied.push({ source, created: done.created });
    ourId = done.created;
  }
  // A finalised current pick is `todo[0]` — drop it; a merge-stop leaves it.
  const rest = (todoOnDisk ?? []).slice(source !== undefined ? 1 : 0).map((e) => e.oid);
  if (rest.length === 0) {
    await clearSequencer(ctx);
    return { kind: 'picked', commits: applied };
  }
  const sequenceHead = (await readSequencerHead(ctx)) ?? ourId;
  const result = await runSequence(ctx, rest, head.target, ourId, opts, {
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

/** Read the symbolic HEAD branch, refusing a detached HEAD for `verb`. */
const requireSymbolicHead = async (ctx: Context, verb: string): Promise<RefName> => {
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation(verb, 'cannot run with detached HEAD');
  }
  return head.target;
};

/**
 * Drop the in-progress pick: hard-reset to HEAD (discarding its half-applied
 * state), then resume the remaining sequencer picks (if any).
 */
export const cherryPickSkip = async (
  ctx: Context,
  input: CherryPickContinueInput = {},
): Promise<CherryPickResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'cherry-pick --skip');
  const source = await readCherryPickHead(ctx);
  const todoOnDisk = await readSequencerTodo(ctx);
  if (source === undefined && (todoOnDisk === undefined || todoOnDisk.length === 0)) {
    throw noOperationInProgress('cherry-pick');
  }
  const branch = await requireSymbolicHead(ctx, 'cherry-pick --skip');
  const ourId = await resolveRef(ctx, branch);
  const opts = await resolveResumeOpts(ctx, input);
  await hardResetWorktreeToCommit(ctx, ourId);
  await clearCherryPickHead(ctx);
  await clearMergeMsg(ctx);
  // Skip always drops the current instruction (todo[0]) — whether it stopped as a
  // conflict (CHERRY_PICK_HEAD set) or a merge (no head). Resume the rest.
  const rest = (todoOnDisk ?? []).slice(1).map((e) => e.oid);
  if (rest.length === 0) {
    await clearSequencer(ctx);
    return { kind: 'picked', commits: [] };
  }
  const sequenceHead = (await readSequencerHead(ctx)) ?? ourId;
  return runSequence(ctx, rest, branch, ourId, opts, { multiPick: true, sequenceHead });
};

/**
 * Abort the cherry-pick: hard-reset the working tree, index, and branch to the
 * pre-sequence HEAD (sequencer `head`, or the current HEAD for a lone pick), and
 * clear all state. Refuses when nothing is in progress.
 */
export const cherryPickAbort = async (ctx: Context): Promise<CherryPickAbortResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'cherry-pick --abort');
  const source = await readCherryPickHead(ctx);
  const seqHead = await readSequencerHead(ctx);
  if (source === undefined && seqHead === undefined) {
    throw noOperationInProgress('cherry-pick');
  }
  const branch = await requireSymbolicHead(ctx, 'cherry-pick --abort');
  const target = seqHead ?? (await resolveRef(ctx, branch));
  await hardResetWorktreeToCommit(ctx, target);
  await updateRef(ctx, branch, target, { reflogMessage: 'cherry-pick: aborted' });
  await clearCherryPickHead(ctx);
  await clearMergeMsg(ctx);
  await clearSequencer(ctx);
  return { head: target, branch };
};
