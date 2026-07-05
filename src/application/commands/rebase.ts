/**
 * `rebase` (non-interactive) — replay the commits unique to the current branch on
 * top of another base, faithful to git's merge backend. HEAD is detached at the
 * new base, each commit is replayed as a cherry-pick (3-way merge through the
 * shared `applyMergeToWorktree` primitive, preserving the source author with the
 * current committer), then the branch is updated and HEAD reattached at finish.
 * Conflicts stop under a byte-faithful `.git/rebase-merge/` state + `REBASE_HEAD`.
 */
import {
  invalidOption,
  mergeHasConflicts,
  noInitialCommit,
  noOperationInProgress,
  workingTreeDirty,
} from '../../domain/commands/error.js';
import { renderPatch, sortedRecordedPaths } from '../../domain/diff/index.js';
import { TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { type ConflictType, type MergeConflict, replayLabels } from '../../domain/merge/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { subjectLine } from '../../domain/objects/commit-message.js';
import type { FilePath, ObjectId, RefName } from '../../domain/objects/index.js';
import {
  buildCombinedMessage,
  type CombinedMessageEntry,
  type RebaseBackupHeader,
  type RebaseTodoAction,
} from '../../domain/rebase/index.js';
import {
  REBASE_FAST_FORWARD,
  rebaseAbortReturningTo,
  rebaseActionReflog,
  rebaseContinueReflog,
  rebaseEditReflog,
  rebaseFinishOnto,
  rebaseFinishReturningTo,
  rebasePickReflog,
  rebaseRewordReflog,
  rebaseStartCheckout,
} from '../../domain/reflog/reflog-messages.js';
import type { Context } from '../../ports/context.js';
import { applyMergeToWorktree } from '../primitives/apply-merge-to-worktree.js';
import { createCommit } from '../primitives/create-commit.js';
import { diffTrees } from '../primitives/diff-trees.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertOperationalRepository,
  readHeadRaw,
} from '../primitives/internal/repo-state.js';
import { materialisePatchFiles } from '../primitives/materialise-patch-files.js';
import { mergeBase } from '../primitives/merge-base.js';
import { computePatchId } from '../primitives/patch-id.js';
import { readIndex } from '../primitives/read-index.js';
import { recordRefUpdate } from '../primitives/record-ref-update.js';
import { getRefStore } from '../primitives/ref-store.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { runHook, runInformationalHook } from '../primitives/run-hook.js';
import { synthesizeTreeFromIndex } from '../primitives/synthesize-tree-from-index.js';
import { updateRef } from '../primitives/update-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { writeSymbolicRef } from '../primitives/write-symbolic-ref.js';
import { conflictMergeMsg } from './internal/cherry-pick-state.js';
import { assertCleanWorkTree } from './internal/clean-work-tree.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { sanitizeMessage, stripComments } from './internal/commit-message.js';
import { resolveCurrentIdentity } from './internal/current-identity.js';
import { readCommitData, treeOf } from './internal/history-rewrite.js';
import { acquireIndexLock } from './internal/index-update.js';
import { writeOrigHead } from './internal/merge-state.js';
import {
  clearRebaseState,
  type RebaseState,
  type RebaseStop,
  readRebaseState,
  readRewrittenList,
  serializeRewritten,
  writeRebaseStop,
} from './internal/rebase-state.js';
import { hardResetWorktreeToCommit } from './internal/reset-worktree.js';

const HEAD = 'HEAD' as RefName;
/** `post-rewrite`'s command-name argument when fired from a rebase. */
const REBASE_REWRITE_LABEL = 'rebase';

/** The interactive instruction verbs (`git rebase -i`). */
export type RebaseInteractiveAction = RebaseTodoAction;

/** One post-`$EDITOR` interactive instruction — the edited-todo line as data. */
export interface RebaseInstruction {
  readonly action: RebaseInteractiveAction;
  /** A commit-ish in the `onto..HEAD` range. */
  readonly oid: string;
  /** reword: the new message (required). squash: the combined message
   *  (optional — defaults to git's combination template). Ignored otherwise. */
  readonly message?: string;
}

export interface RebaseRunInput {
  /** The fork-point side — a commit-ish (`git rebase <upstream>`). */
  readonly upstream: string;
  /** `--onto <newbase>`: replay onto this base instead of `upstream`. */
  readonly onto?: string;
  /** Present → interactive: the post-`$EDITOR` instruction list (`git rebase -i`). */
  readonly interactive?: ReadonlyArray<RebaseInstruction>;
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
    }
  | {
      // `edit`: a conflict-free voluntary stop, resumed by `continue` after the
      // caller amends the tree (or `skip`/`abort`).
      readonly kind: 'stopped';
      readonly commit: ObjectId;
      readonly remaining: number;
    };

type ReplayOutcome =
  | { readonly kind: 'committed'; readonly id: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
  | { readonly kind: 'empty' };

/** A resolved work-list entry (full oid + subject) threaded through the replay.
 *  The non-interactive path only ever plans `pick`. */
interface PlannedPick {
  readonly action: RebaseTodoAction;
  readonly oid: ObjectId;
  readonly subject: string;
}

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
  base: ObjectId | undefined,
  head: ObjectId,
): Promise<ReadonlyArray<ObjectId>> => {
  const excluded = new Set<ObjectId>();
  // An undefined base means unrelated histories: nothing is shared, so the whole
  // `head` history is the replay set (`∅..head`).
  if (base !== undefined) {
    for await (const c of walkCommits(ctx, { from: [base] })) excluded.add(c.id);
  }
  const ids: ObjectId[] = [];
  // equivalent-mutant (`until: []`): dropping the exclusion makes this walk yield
  // `base` + its ancestors too, but `dropCherryEquivalents` feeds the SAME
  // (mutated) walk for the upstream patch-id side, so those extra commits are
  // patch-id-dropped right back out — the net replay set is unchanged.
  for await (const c of walkCommits(ctx, { from: [head], until: [...excluded] })) ids.push(c.id);
  return ids.reverse();
};

/**
 * Drop commits whose change is already present upstream — git's default
 * cherry-pick-equivalent skip. Compared by patch-id against the commits the
 * upstream introduced since the fork (`base..upstream`); a match is removed
 * before the replay loop, so it is never attempted (ADR-231).
 */
const dropCherryEquivalents = async (
  ctx: Context,
  toReplay: ReadonlyArray<ObjectId>,
  base: ObjectId | undefined,
  upstream: ObjectId,
): Promise<ReadonlyArray<ObjectId>> => {
  const upstreamCommits = await commitsToReplay(ctx, base, upstream);
  const upstreamPatchIds = new Set<string>();
  for (const oid of upstreamCommits) upstreamPatchIds.add(await computePatchId(ctx, oid));
  const kept: ObjectId[] = [];
  for (const oid of toReplay) {
    if (!upstreamPatchIds.has(await computePatchId(ctx, oid))) kept.push(oid);
  }
  return kept;
};

const buildTodoEntries = async (
  ctx: Context,
  oids: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<PlannedPick>> => {
  const entries: PlannedPick[] = [];
  for (const oid of oids) {
    entries.push({
      action: 'pick',
      oid,
      subject: subjectLine((await readCommitData(ctx, oid)).message),
    });
  }
  return entries;
};

/**
 * Detach HEAD onto `onto` — git's `rebase (start): checkout <onto>`. As a real
 * checkout it also resets the index + working tree to `onto`'s tree, so the
 * replay begins from a clean `onto` state (a dropped empty pick never commits the
 * index, so without this a later pick would replay against a stale index).
 */
const detachHead = async (
  ctx: Context,
  fromHead: ObjectId,
  onto: ObjectId,
  ontoName: string,
): Promise<void> => {
  await getRefStore(ctx).writeLoose(HEAD, onto);
  await recordRefUpdate(ctx, HEAD, fromHead, onto, rebaseStartCheckout(ontoName));
  await hardResetWorktreeToCommit(ctx, onto);
};

/**
 * Apply commit `C`'s diff onto the running detached HEAD `ourId` as a 3-way merge
 * under the index lock, WITHOUT committing — the caller decides what to commit.
 * Shared by the non-interactive replay (`replayOne`) and the interactive engine.
 * Returns the merged tree (plus `ourId`'s tree, for an empty-change check) or the
 * conflict set (the unmerged index is left written).
 */
const mergeUnderLock = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  ourId: ObjectId,
): Promise<
  | { readonly kind: 'clean'; readonly mergedTree: ObjectId; readonly oursTree: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
> => {
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
      labels: replayLabels(source, subjectLine(cData.message)),
    });
    if (res.kind === 'would-overwrite')
      throw workingTreeDirty({ localChanges: res.localChanges, untracked: res.untracked });
    if (res.kind === 'conflict') {
      await lock.commit(res.indexEntries);
      return { kind: 'conflict', conflicts: res.conflicts };
    }
    await lock.commit(res.result.newIndexEntries);
    return { kind: 'clean', mergedTree: res.mergedTree, oursTree };
  } finally {
    await lock.release();
  }
};

/** Apply one commit onto the detached HEAD `ourId`; commit it (single-parent,
 *  `rebase (pick)`) when the clean merge changed the tree, else report `empty`. */
const replayOne = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  ourId: ObjectId,
): Promise<ReplayOutcome> => {
  const outcome = await mergeUnderLock(ctx, source, cData, ourId);
  if (outcome.kind === 'conflict') return { kind: 'conflict', conflicts: outcome.conflicts };
  if (outcome.mergedTree === outcome.oursTree) return { kind: 'empty' };
  const committer = await resolveCurrentIdentity(ctx);
  const id = await createCommit(ctx, {
    tree: outcome.mergedTree,
    parents: [ourId],
    author: cData.author,
    committer,
    message: cData.message,
    extraHeaders: [],
  });
  await updateRef(ctx, HEAD, id, {
    expected: ourId,
    reflogMessage: rebasePickReflog(subjectLine(cData.message)),
  });
  return { kind: 'committed', id };
};

/** Render the failed pick's `parent..commit` diff for `.git/rebase-merge/patch`. */
const renderCommitPatch = async (ctx: Context, cData: CommitData): Promise<string> => {
  const parentId = cData.parents[0];
  const parentTree = parentId !== undefined ? await treeOf(ctx, parentId) : undefined;
  // Recurse like git: the patch file must render nested changes per-file, not
  // choke on a sub-tree the patch hydration would read as a blob.
  const diff = await diffTrees(ctx, parentTree, cData.tree, { recursive: true });
  const files = await materialisePatchFiles(ctx, diff.changes);
  // equivalent-mutant (`{}`): `renderPatch`'s defaults are exactly `contextLines:
  // 3` + `{ old: 'a/', new: 'b/' }`, so passing `{}` produces byte-identical output.
  return renderPatch(files, { contextLines: 3, pathPrefix: { old: 'a/', new: 'b/' } });
};

/** The shared context a replay loop needs to stop or finish. `branch` is
 *  `undefined` for a detached-HEAD rebase (head-name = `detached HEAD`). */
interface ReplayContext {
  readonly branch: RefName | undefined;
  readonly onto: ObjectId;
  readonly origHead: ObjectId;
  /** Instructions completed before this loop (a stop's `done` prepends these). */
  readonly doneBefore: ReadonlyArray<PlannedPick>;
  /** Instructions to replay in this loop (the live `git-rebase-todo`). */
  readonly todo: ReadonlyArray<PlannedPick>;
  /** Set on the initial (fresh-run) stop only — git writes the backup once. */
  readonly backupHeader?: RebaseBackupHeader;
}

/** Applied + rewritten state carried into a resumed replay (`continue`). */
interface ReplaySeed {
  readonly applied: ReadonlyArray<RebasedCommit>;
  readonly rewritten: ReadonlyArray<readonly [ObjectId, ObjectId]>;
}

/** Persist the byte-faithful stop state when a replay conflicts. */
const persistStop = async (
  ctx: Context,
  rc: ReplayContext,
  index: number,
  cData: CommitData,
  conflicts: ReadonlyArray<MergeConflict>,
  rewritten: ReadonlyArray<readonly [ObjectId, ObjectId]>,
): Promise<void> => {
  const stop: RebaseStop = {
    headName: rc.branch ?? 'detached HEAD',
    onto: rc.onto,
    origHead: rc.origHead,
    done: [...rc.doneBefore, ...rc.todo.slice(0, index + 1)],
    remaining: rc.todo.slice(index + 1),
    stoppedSha: rc.todo[index]!.oid,
    stoppedAuthor: cData.author,
    message: conflictMergeMsg(cData.message, sortedRecordedPaths(conflicts)),
    rewritten,
    patch: await renderCommitPatch(ctx, cData),
    // equivalent-mutant (`!== undefined` → `true`): on a continue/skip re-stop
    // `rc.backupHeader` is `undefined`, so the `true` branch spreads
    // `{ backupHeader: undefined }`, which `writeRebaseStop` skips exactly like
    // the `{}` branch — indistinguishable. The `false`/object-literal mutants
    // (which drop the fresh-run backup) are killed by the conflict-stop bytes.
    ...(rc.backupHeader !== undefined ? { backupHeader: rc.backupHeader } : {}),
  };
  await writeRebaseStop(ctx, stop);
};

/**
 * Finish the rebase. For a branch rebase: update the branch to the replayed tip
 * (single `rebase (finish): … onto` reflog) and reattach HEAD (`returning to
 * <branch>`). For a detached rebase: HEAD already sits at the replayed tip from
 * the last pick, so git writes nothing further — a no-op here too.
 */
const finishRebase = async (
  ctx: Context,
  branch: RefName | undefined,
  origHead: ObjectId,
  newTip: ObjectId,
  onto: ObjectId,
): Promise<void> => {
  if (branch === undefined) return;
  await updateRef(ctx, branch, newTip, {
    expected: origHead,
    reflogMessage: rebaseFinishOnto(branch, onto),
  });
  await writeSymbolicRef(ctx, HEAD, branch);
  await recordRefUpdate(ctx, HEAD, newTip, newTip, rebaseFinishReturningTo(branch));
};

/**
 * Fire the blocking `pre-rebase` hook (a non-zero exit throws `HOOK_FAILED`,
 * vetoing the rebase before any ref moves). git passes `<upstream> [<branch>]`;
 * tsgit always rebases the current HEAD, so only the upstream operand is sent.
 */
const firePreRebase = (ctx: Context, upstream: string): Promise<void> =>
  runHook(ctx, 'pre-rebase', { args: [upstream] });

/**
 * Fire the informational `post-rewrite` hook once a rebase finishes, feeding it
 * git's `<old> SP <new> LF` lines on stdin — the same bytes as the
 * `rewritten-list` state file. A no-op when nothing was rewritten (git fires it
 * only on a non-empty rewrite set).
 */
const firePostRewrite = async (
  ctx: Context,
  rewritten: ReadonlyArray<readonly [ObjectId, ObjectId]>,
): Promise<void> => {
  if (rewritten.length === 0) return;
  await runInformationalHook(ctx, 'post-rewrite', {
    args: [REBASE_REWRITE_LABEL],
    stdin: serializeRewritten(rewritten),
  });
};

/** Replay `rc.todo` from the detached HEAD `ourId`; stop on conflict, else finish. */
const replayFrom = async (
  ctx: Context,
  rc: ReplayContext,
  ourId: ObjectId,
  seed: ReplaySeed,
): Promise<RebaseResult> => {
  let cur = ourId;
  const applied: RebasedCommit[] = [...seed.applied];
  const rewritten: Array<readonly [ObjectId, ObjectId]> = [...seed.rewritten];
  for (let i = 0; i < rc.todo.length; i += 1) {
    const source = rc.todo[i]!.oid;
    const cData = await readCommitData(ctx, source);
    const outcome = await replayOne(ctx, source, cData, cur);
    if (outcome.kind === 'committed') {
      applied.push({ source, created: outcome.id });
      rewritten.push([source, outcome.id]);
      cur = outcome.id;
      continue;
    }
    if (outcome.kind === 'empty') continue;
    await persistStop(ctx, rc, i, cData, outcome.conflicts, rewritten);
    return {
      kind: 'conflict',
      commit: source,
      conflicts: outcome.conflicts.map((c) => ({ path: c.path, type: c.type })),
      remaining: rc.todo.length - (i + 1),
    };
  }
  await finishRebase(ctx, rc.branch, rc.origHead, cur, rc.onto);
  await firePostRewrite(ctx, rewritten);
  await clearRebaseState(ctx);
  return { kind: 'rebased', commits: applied };
};

export const rebaseRun = async (ctx: Context, input: RebaseRunInput): Promise<RebaseResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'rebase');
  await assertNoPendingOperation(ctx);
  const head = await readHeadRaw(ctx);
  const headCommit = head.kind === 'symbolic' ? await resolveHeadCommit(ctx, head.target) : head.id;
  const branch = head.kind === 'symbolic' ? head.target : undefined;
  const upstream = await resolveCommitIsh(ctx, input.upstream);
  const onto = input.onto !== undefined ? await resolveCommitIsh(ctx, input.onto) : upstream;
  const ontoName = input.onto ?? input.upstream;
  await assertCleanWorkTree(ctx, await treeOf(ctx, headCommit));
  // No common ancestor (unrelated histories) → `base` is undefined and the whole
  // branch replays onto `onto`, the root commit against the empty-tree base —
  // faithful to `git rebase <unrelated>`.
  const [base] = await mergeBase(ctx, [upstream, headCommit]);
  if (input.interactive !== undefined) {
    // An interactive rebase always has todo work (the caller supplies it), so it
    // is never the no-op "up to date" case — pre-rebase fires.
    await firePreRebase(ctx, input.upstream);
    return rebaseRunInteractive(ctx, {
      instructions: input.interactive,
      branch,
      headCommit,
      upstream,
      onto,
      ontoName,
      base,
    });
  }
  // git fires pre-rebase only when the rebase will do work; an up-to-date rebase
  // (nothing to replay or fast-forward) returns before the hook, matching git.
  if (onto === base) return { kind: 'up-to-date' };
  await firePreRebase(ctx, input.upstream);
  const toReplay = await commitsToReplay(ctx, base, headCommit);
  const kept = await dropCherryEquivalents(ctx, toReplay, base, upstream);
  const todo = await buildTodoEntries(ctx, kept);
  await writeOrigHead(ctx, headCommit);
  await detachHead(ctx, headCommit, onto, ontoName);
  const rc: ReplayContext = {
    branch,
    onto,
    origHead: headCommit,
    doneBefore: [],
    todo,
    backupHeader: {
      shortUpstream: shortOid(upstream),
      shortOrigHead: shortOid(headCommit),
      shortOnto: shortOid(onto),
    },
  };
  return replayFrom(ctx, rc, onto, { applied: [], rewritten: [] });
};

export interface RebaseAbortResult {
  readonly head: ObjectId;
  readonly headName: string;
}

/** The branch a stop's `head-name` names, or `undefined` for a detached rebase. */
const branchOf = (headName: string): RefName | undefined =>
  headName === 'detached HEAD' ? undefined : (headName as RefName);

const rejectUnmergedIndex = (entries: ReadonlyArray<IndexEntry>): void => {
  const unmerged = new Set<FilePath>();
  for (const entry of entries) {
    if (entry.flags.stage !== 0) unmerged.add(entry.path);
  }
  if (unmerged.size > 0) throw mergeHasConflicts(unmerged.size, [...unmerged]);
};

/**
 * Resume the rebase after the conflicted commit was resolved: commit the resolved
 * index as the stopped commit (preserved author from `author-script`, current
 * committer, `rebase (continue)` reflog), then replay the remaining todo.
 */
export const rebaseContinue = async (ctx: Context): Promise<RebaseResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'rebase --continue');
  const state = await readRebaseState(ctx);
  if (state === undefined) throw noOperationInProgress('rebase');
  if (isInteractiveState(state)) return rebaseContinueInteractive(ctx, state);
  const index = await readIndex(ctx);
  rejectUnmergedIndex(index.entries);
  const stopped = state.done[state.done.length - 1]!;
  const currentHead = await resolveRef(ctx, HEAD);
  const tree = await synthesizeTreeFromIndex(ctx, index.entries);
  const committer = await resolveCurrentIdentity(ctx);
  // equivalent-mutant (`allowEmpty: false` → `true`): the rebase `message` file
  // carries the replayed commit's subject, so the stripped/sanitised message is
  // always non-empty here — the empty-message guard is never exercised.
  const message = sanitizeMessage(stripComments(state.message), { allowEmpty: false });
  const resolutionId = await createCommit(ctx, {
    tree,
    parents: [currentHead],
    author: state.author,
    committer,
    message,
    extraHeaders: [],
  });
  await updateRef(ctx, HEAD, resolutionId, {
    expected: currentHead,
    reflogMessage: rebaseContinueReflog(subjectLine(message)),
  });
  const rewritten = [...(await readRewrittenList(ctx)), [stopped.oid, resolutionId] as const];
  const rc: ReplayContext = {
    branch: branchOf(state.headName),
    onto: state.onto,
    origHead: state.origHead,
    doneBefore: state.done,
    todo: state.remaining,
  };
  return replayFrom(ctx, rc, resolutionId, {
    applied: [{ source: stopped.oid, created: resolutionId }],
    rewritten,
  });
};

/** Drop the conflicted commit (hard-reset to the last good pick) and replay the rest. */
export const rebaseSkip = async (ctx: Context): Promise<RebaseResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'rebase --skip');
  const state = await readRebaseState(ctx);
  if (state === undefined) throw noOperationInProgress('rebase');
  if (isInteractiveState(state)) return rebaseSkipInteractive(ctx, state);
  const currentHead = await resolveRef(ctx, HEAD);
  await hardResetWorktreeToCommit(ctx, currentHead);
  const rc: ReplayContext = {
    branch: branchOf(state.headName),
    onto: state.onto,
    origHead: state.origHead,
    doneBefore: state.done,
    todo: state.remaining,
  };
  return replayFrom(ctx, rc, currentHead, {
    applied: [],
    rewritten: await readRewrittenList(ctx),
  });
};

/**
 * Abort the rebase: hard-reset the working tree + index to the pre-rebase tip,
 * reattach `head-name`, record git's `rebase (abort): returning to <name>` reflog
 * (the branch never moved during the replay, so it gets no entry), clear state.
 */
export const rebaseAbort = async (ctx: Context): Promise<RebaseAbortResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'rebase --abort');
  const state = await readRebaseState(ctx);
  if (state === undefined) throw noOperationInProgress('rebase');
  const branch = branchOf(state.headName);
  const currentHead = await resolveRef(ctx, HEAD);
  await hardResetWorktreeToCommit(ctx, state.origHead);
  // A branch rebase reattaches HEAD to the ref (`returning to <branch>`); a
  // detached rebase moves HEAD back to the original oid (`returning to <oid>`).
  if (branch !== undefined) {
    await writeSymbolicRef(ctx, HEAD, branch);
    await recordRefUpdate(ctx, HEAD, currentHead, state.origHead, rebaseAbortReturningTo(branch));
  } else {
    await getRefStore(ctx).writeLoose(HEAD, state.origHead);
    await recordRefUpdate(
      ctx,
      HEAD,
      currentHead,
      state.origHead,
      rebaseAbortReturningTo(state.origHead),
    );
  }
  await clearRebaseState(ctx);
  return { head: state.origHead, headName: state.headName };
};

// ── interactive (`rebase -i`) ───────────────────────────────────────────────

/** A resolved interactive instruction threaded through the replay. */
interface PlannedInstruction {
  readonly action: RebaseTodoAction;
  readonly oid: ObjectId;
  readonly subject: string;
  /** reword/squash message override. */
  readonly message?: string;
}

interface InteractivePlan {
  readonly instructions: ReadonlyArray<RebaseInstruction>;
  readonly branch: RefName | undefined;
  readonly headCommit: ObjectId;
  readonly upstream: ObjectId;
  readonly onto: ObjectId;
  readonly ontoName: string;
  readonly base: ObjectId | undefined;
}

/**
 * Resolve + validate the supplied todo against the `base..head` candidate set,
 * surfacing git's refusals before any state change: nothing-to-do (empty or
 * all-drop), a leading squash/fixup, a reword without a message, and an oid
 * outside the replayed range.
 */
const planInteractive = async (
  ctx: Context,
  instructions: ReadonlyArray<RebaseInstruction>,
  base: ObjectId | undefined,
  head: ObjectId,
): Promise<ReadonlyArray<PlannedInstruction>> => {
  if (instructions.every((i) => i.action === 'drop')) {
    throw invalidOption('interactive', 'nothing to do (every instruction drops a commit)');
  }
  const firstApplied = instructions.find((i) => i.action !== 'drop');
  if (firstApplied?.action === 'squash' || firstApplied?.action === 'fixup') {
    throw invalidOption('interactive', `cannot '${firstApplied.action}' without a previous commit`);
  }
  const candidates = new Set(await commitsToReplay(ctx, base, head));
  const planned: PlannedInstruction[] = [];
  for (const inst of instructions) {
    if (inst.action === 'reword' && inst.message === undefined) {
      throw invalidOption('interactive', 'reword requires a message (no editor in a library)');
    }
    if (
      (inst.action === 'reword' || inst.action === 'squash') &&
      inst.message !== undefined &&
      sanitizeMessage(inst.message, { allowEmpty: true }) === ''
    ) {
      throw invalidOption('interactive', `${inst.action} message must not be empty`);
    }
    const oid = await resolveCommitIsh(ctx, inst.oid);
    if (!candidates.has(oid)) {
      throw invalidOption(
        'interactive',
        `commit ${oid} is not in the list of commits to be rebased`,
      );
    }
    const subject = subjectLine((await readCommitData(ctx, oid)).message);
    planned.push({
      action: inst.action,
      oid,
      subject,
      // equivalent-mutant (`!== undefined` → `true`): the `true` branch spreads
      // `{ message: undefined }`, and every downstream reader (`inst.message ??
      // …`, `inst.message !== undefined`) treats an explicit `undefined` exactly
      // like an absent key — indistinguishable from the `{}` branch.
      ...(inst.message !== undefined ? { message: inst.message } : {}),
    });
  }
  return planned;
};

/** Count the leading run of `pick` instructions that linearly continue from
 *  `onto` — git's `skip_unnecessary_picks` fold into the `rebase (start)` entry. */
const leadingFold = async (
  ctx: Context,
  todo: ReadonlyArray<PlannedInstruction>,
  onto: ObjectId,
): Promise<number> => {
  let head = onto;
  let count = 0;
  while (count < todo.length && todo[count]!.action === 'pick') {
    const cData = await readCommitData(ctx, todo[count]!.oid);
    if (cData.parents[0] !== head) break;
    head = todo[count]!.oid;
    count += 1;
  }
  return count;
};

/** Detach HEAD at the folded position and record a single `rebase (start)`. */
const detachInteractive = async (
  ctx: Context,
  fromHead: ObjectId,
  ontoName: string,
  foldedHead: ObjectId,
): Promise<void> => {
  await getRefStore(ctx).writeLoose(HEAD, foldedHead);
  await recordRefUpdate(ctx, HEAD, fromHead, foldedHead, rebaseStartCheckout(ontoName));
  await hardResetWorktreeToCommit(ctx, foldedHead);
};

/** Fast-forward the detached HEAD onto `target` (kept verbatim — its first parent
 *  is the current HEAD), recording git's `rebase: fast-forward`. */
const fastForwardOnto = async (ctx: Context, target: ObjectId): Promise<void> => {
  const from = await resolveRef(ctx, HEAD);
  await getRefStore(ctx).writeLoose(HEAD, target);
  await recordRefUpdate(ctx, HEAD, from, target, REBASE_FAST_FORWARD);
  await hardResetWorktreeToCommit(ctx, target);
};

/** Create a replayed commit and advance the detached HEAD to it. `parent` is the
 *  new commit's first parent; `expected` is the current HEAD (which `parent` and
 *  `expected` differ for a reword amend, where the produced commit sits between). */
const commitAndAdvance = async (
  ctx: Context,
  spec: {
    readonly tree: ObjectId;
    readonly parent: ObjectId;
    readonly expected: ObjectId;
    readonly author: CommitData['author'];
    readonly message: string;
    readonly reflog: string;
  },
): Promise<ObjectId> => {
  const committer = await resolveCurrentIdentity(ctx);
  const created = await createCommit(ctx, {
    tree: spec.tree,
    parents: [spec.parent],
    author: spec.author,
    committer,
    message: spec.message,
    extraHeaders: [],
  });
  await updateRef(ctx, HEAD, created, { expected: spec.expected, reflogMessage: spec.reflog });
  return created;
};

/** One processed instruction's outcome. `created` is the final replayed oid;
 *  `edit-stop` means the commit was produced and the rebase pauses for amending. */
type Step =
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
  | { readonly kind: 'advanced'; readonly created: ObjectId }
  | { readonly kind: 'edit-stop'; readonly created: ObjectId };

type Produced =
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
  | { readonly kind: 'committed'; readonly created: ObjectId };

/** Produce a commit onto HEAD: fast-forward when its parent is HEAD (oid kept,
 *  `rebase: fast-forward`), else a 3-way cherry-pick committed with `reflog`. */
const produceOnto = async (
  ctx: Context,
  inst: PlannedInstruction,
  cData: CommitData,
  head: ObjectId,
  reflog: string,
): Promise<Produced> => {
  if (cData.parents[0] === head) {
    await fastForwardOnto(ctx, inst.oid);
    return { kind: 'committed', created: inst.oid };
  }
  const outcome = await mergeUnderLock(ctx, inst.oid, cData, head);
  if (outcome.kind === 'conflict') return { kind: 'conflict', conflicts: outcome.conflicts };
  const created = await commitAndAdvance(ctx, {
    tree: outcome.mergedTree,
    parent: head,
    expected: head,
    author: cData.author,
    message: cData.message,
    reflog,
  });
  return { kind: 'committed', created };
};

/** `pick`: produce the commit verbatim (fast-forward or `rebase (pick)`). */
const stepPick = async (
  ctx: Context,
  inst: PlannedInstruction,
  cData: CommitData,
  head: ObjectId,
): Promise<Step> => {
  const produced = await produceOnto(
    ctx,
    inst,
    cData,
    head,
    rebasePickReflog(subjectLine(cData.message)),
  );
  if (produced.kind === 'conflict') return { kind: 'conflict', conflicts: produced.conflicts };
  return { kind: 'advanced', created: produced.created };
};

/** `edit`: produce the commit, then pause for amending (`amend` marker written). */
const stepEdit = async (
  ctx: Context,
  inst: PlannedInstruction,
  cData: CommitData,
  head: ObjectId,
): Promise<Step> => {
  const produced = await produceOnto(
    ctx,
    inst,
    cData,
    head,
    rebaseEditReflog(subjectLine(cData.message)),
  );
  if (produced.kind === 'conflict') return { kind: 'conflict', conflicts: produced.conflicts };
  return { kind: 'edit-stop', created: produced.created };
};

/**
 * `reword`: produce the commit (fast-forward or a 3-way cherry-pick labelled
 * `rebase (reword): <orig>`), then amend its message to the supplied one
 * (`rebase (reword): <new>`) — git's two-step reword. A `reword` reached on a
 * resume carries no message (not persisted across a stop), so it keeps the
 * original — see the design's cross-stop-message note.
 */
const stepReword = async (
  ctx: Context,
  inst: PlannedInstruction,
  cData: CommitData,
  head: ObjectId,
): Promise<Step> => {
  // equivalent-mutant (`allowEmpty: false` → `true`): `planInteractive` rejects an
  // empty reword message upfront, and a reword reached on a resume carries no
  // message (not persisted across a stop), falling back to the commit's own
  // non-empty message — so the cleaned message is never empty here.
  const message = sanitizeMessage(inst.message ?? cData.message, { allowEmpty: false });
  const produced = await produceOnto(
    ctx,
    inst,
    cData,
    head,
    rebaseRewordReflog(subjectLine(cData.message)),
  );
  if (produced.kind === 'conflict') return { kind: 'conflict', conflicts: produced.conflicts };
  const producedData = await readCommitData(ctx, produced.created);
  const created = await commitAndAdvance(ctx, {
    tree: producedData.tree,
    parent: producedData.parents[0] as ObjectId,
    expected: produced.created,
    author: producedData.author,
    message,
    reflog: rebaseRewordReflog(subjectLine(message)),
  });
  return { kind: 'advanced', created };
};

const stepInstruction = (
  ctx: Context,
  inst: PlannedInstruction,
  cData: CommitData,
  head: ObjectId,
): Promise<Step> => {
  if (inst.action === 'reword') return stepReword(ctx, inst, cData, head);
  if (inst.action === 'edit') return stepEdit(ctx, inst, cData, head);
  return stepPick(ctx, inst, cData, head);
};

/** The replay context. `doneBefore` are the instructions completed before this
 *  loop (the folded prefix on a fresh run, the resolved prefix on a resume); a
 *  re-stop's `done` prepends them. `backupHeader` is set on the fresh run only. */
interface InteractiveContext {
  readonly branch: RefName | undefined;
  readonly onto: ObjectId;
  readonly origHead: ObjectId;
  readonly doneBefore: ReadonlyArray<PlannedInstruction>;
  readonly todo: ReadonlyArray<PlannedInstruction>;
  readonly backupHeader?: RebaseBackupHeader;
}

interface StopFields {
  readonly stoppedSha: ObjectId;
  readonly author: CommitData['author'];
  readonly message: string;
  readonly patch: string;
  readonly rewritten: ReadonlyArray<readonly [ObjectId, ObjectId]>;
  readonly amend?: ObjectId;
  readonly currentFixups?: ReadonlyArray<{
    readonly action: 'squash' | 'fixup';
    readonly oid: ObjectId;
  }>;
  readonly rewrittenPending?: ReadonlyArray<ObjectId>;
  readonly messageSquash?: string;
}

/** Persist a byte-faithful interactive stop. `done` is `doneBefore` + the
 *  instructions up to and including the stopped one; `remaining` is the rest. */
const persistInteractiveStop = async (
  ctx: Context,
  ic: InteractiveContext,
  stopIndex: number,
  fields: StopFields,
): Promise<void> => {
  await writeRebaseStop(ctx, {
    headName: ic.branch ?? 'detached HEAD',
    onto: ic.onto,
    origHead: ic.origHead,
    done: [...ic.doneBefore, ...ic.todo.slice(0, stopIndex + 1)],
    remaining: ic.todo.slice(stopIndex + 1),
    stoppedSha: fields.stoppedSha,
    stoppedAuthor: fields.author,
    message: fields.message,
    rewritten: fields.rewritten,
    patch: fields.patch,
    // equivalent-mutant (each `!== undefined` → `true`): when a field is
    // `undefined` the `true` branch spreads `{ field: undefined }`, which
    // `writeRebaseStop`'s `if (field !== undefined)` skips exactly like the `{}`
    // branch — byte-identical on-disk state. The drop-the-field mutants
    // (`→ false` / object-literal `→ {}`) ARE killed by the conflict-stop bytes
    // (backup file, current-fixups, rewritten-pending, message-squash assertions).
    ...(ic.backupHeader !== undefined ? { backupHeader: ic.backupHeader } : {}),
    ...(fields.amend !== undefined ? { amend: fields.amend } : {}),
    ...(fields.currentFixups !== undefined ? { currentFixups: fields.currentFixups } : {}),
    ...(fields.rewrittenPending !== undefined ? { rewrittenPending: fields.rewrittenPending } : {}),
    ...(fields.messageSquash !== undefined ? { messageSquash: fields.messageSquash } : {}),
  });
};

/** Whether the instruction at `index + 1` continues a squash/fixup group. */
const meldContinues = (todo: ReadonlyArray<PlannedInstruction>, index: number): boolean => {
  const next = todo[index + 1];
  return next !== undefined && (next.action === 'squash' || next.action === 'fixup');
};

/** The mutable squash/fixup group accumulator threaded through the replay. */
interface MeldGroup {
  /** The group's base commit's original message (the `# 1st commit message`). */
  baseMessage: string;
  /** Each melded member, kept (squash) or skipped (fixup), for the template. */
  members: CombinedMessageEntry[];
  /** The melded members' verbs + oids, for `current-fixups`. */
  fixups: Array<{ readonly action: 'squash' | 'fixup'; readonly oid: ObjectId }>;
  /** The oids folded so far (base + members), for `rewritten-pending`. */
  pending: ObjectId[];
  /** The latest squash member's explicit combined message, if any. */
  inline: string | undefined;
}

const conflictResult = (
  source: ObjectId,
  conflicts: ReadonlyArray<MergeConflict>,
  remaining: number,
): RebaseResult => ({
  kind: 'conflict',
  commit: source,
  conflicts: conflicts.map((c) => ({ path: c.path, type: c.type })),
  remaining,
});

interface ReplaySeed {
  readonly applied: ReadonlyArray<RebasedCommit>;
  readonly rewritten: ReadonlyArray<readonly [ObjectId, ObjectId]>;
}

/** Meld a squash/fixup member into the group commit at HEAD: recommit HEAD's
 *  parent with HEAD's tree + the member's changes, under the running (or, at the
 *  group end, the cleaned) combined message. Returns the new group commit. */
const meldGroupMember = async (
  ctx: Context,
  inst: PlannedInstruction,
  cData: CommitData,
  head: ObjectId,
  group: MeldGroup,
  isLast: boolean,
): Promise<
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
  | {
      readonly kind: 'committed';
      readonly created: ObjectId;
      readonly message: string;
    }
> => {
  const headData = await readCommitData(ctx, head);
  const outcome = await mergeUnderLock(ctx, inst.oid, cData, head);
  if (outcome.kind === 'conflict') return { kind: 'conflict', conflicts: outcome.conflicts };
  group.members.push({ message: cData.message, skip: inst.action === 'fixup' });
  group.fixups.push({ action: inst.action as 'squash' | 'fixup', oid: inst.oid });
  group.pending.push(inst.oid);
  // equivalent-mutant (`inst.message !== undefined` → `true`): for a squash with
  // no message this assigns `group.inline = undefined`, leaving the already-
  // `undefined` field unchanged. (The `&&` → `||` and outer `→ true` mutants are
  // killed by the fixup-carrying-an-inline-message test.)
  if (inst.action === 'squash' && inst.message !== undefined) group.inline = inst.message;
  const template = buildCombinedMessage([{ message: group.baseMessage }, ...group.members]);
  // equivalent-mutant (`allowEmpty: false` → `true`): an empty squash inline
  // message is rejected upfront by `planInteractive`; otherwise the template
  // fallback retains the base commit's non-empty message — never empty here.
  const message = isLast
    ? sanitizeMessage(group.inline ?? stripComments(template), { allowEmpty: false })
    : template;
  const created = await commitAndAdvance(ctx, {
    tree: outcome.mergedTree,
    parent: headData.parents[0] as ObjectId,
    expected: head,
    author: headData.author,
    message,
    reflog: rebaseActionReflog(inst.action, subjectLine(message)),
  });
  return { kind: 'committed', created, message };
};

/** Replay `ic.todo` from `startHead`. Stops on the first conflict or `edit`;
 *  otherwise finishes (updates the branch + reattaches HEAD). A run of
 *  squash/fixup melds into the preceding commit, threading `group`. */
const replayInteractive = async (
  ctx: Context,
  ic: InteractiveContext,
  startHead: ObjectId,
  seed: ReplaySeed,
): Promise<RebaseResult> => {
  let head = startHead;
  const applied: RebasedCommit[] = [...seed.applied];
  const rewritten: Array<readonly [ObjectId, ObjectId]> = [...seed.rewritten];
  const group: MeldGroup = {
    baseMessage: (await readCommitData(ctx, startHead)).message,
    members: [],
    fixups: [],
    pending: [startHead],
    inline: undefined,
  };
  for (let i = 0; i < ic.todo.length; i += 1) {
    const inst = ic.todo[i]!;
    if (inst.action === 'drop') continue;
    const cData = await readCommitData(ctx, inst.oid);
    const patch = await renderCommitPatch(ctx, cData);
    if (inst.action === 'squash' || inst.action === 'fixup') {
      const meld = await meldGroupMember(ctx, inst, cData, head, group, !meldContinues(ic.todo, i));
      if (meld.kind === 'conflict') {
        const template = buildCombinedMessage([
          { message: group.baseMessage },
          ...group.members,
          { message: cData.message, skip: inst.action === 'fixup' },
        ]);
        await persistInteractiveStop(ctx, ic, i, {
          stoppedSha: inst.oid,
          author: cData.author,
          message: conflictMergeMsg(template, sortedRecordedPaths(meld.conflicts)),
          patch,
          rewritten,
          currentFixups: [...group.fixups, { action: inst.action, oid: inst.oid }],
          rewrittenPending: [...group.pending],
          messageSquash: template,
        });
        return conflictResult(inst.oid, meld.conflicts, ic.todo.length - (i + 1));
      }
      applied.push({ source: inst.oid, created: meld.created });
      rewritten.push([inst.oid, meld.created]);
      head = meld.created;
      continue;
    }
    const step = await stepInstruction(ctx, inst, cData, head);
    if (step.kind === 'conflict') {
      await persistInteractiveStop(ctx, ic, i, {
        stoppedSha: inst.oid,
        author: cData.author,
        message: conflictMergeMsg(cData.message, sortedRecordedPaths(step.conflicts)),
        patch,
        rewritten,
      });
      return conflictResult(inst.oid, step.conflicts, ic.todo.length - (i + 1));
    }
    if (step.kind === 'edit-stop') {
      await persistInteractiveStop(ctx, ic, i, {
        stoppedSha: step.created,
        author: cData.author,
        message: cData.message,
        patch,
        rewritten,
        amend: step.created,
      });
      return { kind: 'stopped', commit: inst.oid, remaining: ic.todo.length - (i + 1) };
    }
    applied.push({ source: inst.oid, created: step.created });
    rewritten.push([inst.oid, step.created]);
    head = step.created;
    group.baseMessage = (await readCommitData(ctx, step.created)).message;
    group.members = [];
    group.fixups = [];
    group.pending = [step.created];
    group.inline = undefined;
  }
  await finishRebase(ctx, ic.branch, ic.origHead, head, ic.onto);
  await firePostRewrite(ctx, rewritten);
  await clearRebaseState(ctx);
  return { kind: 'rebased', commits: applied };
};

const rebaseRunInteractive = async (ctx: Context, plan: InteractivePlan): Promise<RebaseResult> => {
  const todo = await planInteractive(ctx, plan.instructions, plan.base, plan.headCommit);
  const foldCount = await leadingFold(ctx, todo, plan.onto);
  const foldedHead = foldCount > 0 ? todo[foldCount - 1]!.oid : plan.onto;
  await writeOrigHead(ctx, plan.headCommit);
  await detachInteractive(ctx, plan.headCommit, plan.ontoName, foldedHead);
  const folded = todo.slice(0, foldCount);
  const ic: InteractiveContext = {
    branch: plan.branch,
    onto: plan.onto,
    origHead: plan.headCommit,
    doneBefore: folded,
    todo: todo.slice(foldCount),
    backupHeader: {
      shortUpstream: shortOid(plan.upstream),
      shortOrigHead: shortOid(plan.headCommit),
      shortOnto: shortOid(plan.onto),
    },
  };
  const seed: ReplaySeed = {
    applied: folded.map((t) => ({ source: t.oid, created: t.oid })),
    rewritten: [],
  };
  return replayInteractive(ctx, ic, foldedHead, seed);
};

/** A rebase is interactive when any instruction carries a non-`pick` verb — a
 *  pure-pick stop resumes through the (identical) non-interactive path. An
 *  `amend` stop always carries a non-`pick` verb (`edit`/`squash`/`fixup`) in
 *  its todo, so the verb check subsumes an explicit `amend` test. */
const isInteractiveState = (state: RebaseState): boolean =>
  [...state.done, ...state.remaining].some((e) => e.action !== 'pick');

/** Resume an interactive stop: commit the resolution (conflict) or amend/keep
 *  the edit'd commit, then replay the remaining todo. */
const rebaseContinueInteractive = async (
  ctx: Context,
  state: RebaseState,
): Promise<RebaseResult> => {
  const ic: InteractiveContext = {
    branch: branchOf(state.headName),
    onto: state.onto,
    origHead: state.origHead,
    doneBefore: state.done,
    todo: state.remaining,
  };
  const rewritten = [...(await readRewrittenList(ctx))];
  const index = await readIndex(ctx);
  rejectUnmergedIndex(index.entries);
  const tree = await synthesizeTreeFromIndex(ctx, index.entries);
  const currentHead = await resolveRef(ctx, HEAD);
  const stoppedOid = state.done[state.done.length - 1]!.oid;
  let resumeHead: ObjectId;
  if (state.currentFixups !== undefined) {
    // A squash/fixup meld conflicted: commit the resolution as the group commit
    // (replacing the base — its parent), with the cleaned combined message.
    const baseData = await readCommitData(ctx, currentHead);
    // equivalent-mutant (`allowEmpty: false` → `true`): `state.message` is the
    // stopped commit's (non-empty) message persisted at the stop, so the cleaned
    // result is never empty here — the empty-message guard never fires.
    const message = sanitizeMessage(stripComments(state.message), { allowEmpty: false });
    resumeHead = await commitAndAdvance(ctx, {
      tree,
      parent: baseData.parents[0] as ObjectId,
      expected: currentHead,
      author: baseData.author,
      message,
      reflog: rebaseContinueReflog(subjectLine(message)),
    });
    rewritten.push([stoppedOid, resumeHead]);
  } else if (state.amend !== undefined) {
    const amendCommit = await readCommitData(ctx, state.amend);
    if (tree === amendCommit.tree) {
      resumeHead = currentHead; // edit left the tree unchanged — keep the commit
    } else {
      resumeHead = await commitAndAdvance(ctx, {
        tree,
        parent: amendCommit.parents[0] as ObjectId,
        expected: currentHead,
        author: state.author,
        message: amendCommit.message,
        reflog: rebaseContinueReflog(subjectLine(amendCommit.message)),
      });
      rewritten.push([stoppedOid, resumeHead]);
    }
  } else {
    // equivalent-mutant (`allowEmpty: false` → `true`): `state.message` is the
    // stopped commit's (non-empty) message persisted at the stop, so the cleaned
    // result is never empty here — the empty-message guard never fires.
    const message = sanitizeMessage(stripComments(state.message), { allowEmpty: false });
    resumeHead = await commitAndAdvance(ctx, {
      tree,
      parent: currentHead,
      expected: currentHead,
      author: state.author,
      message,
      reflog: rebaseContinueReflog(subjectLine(message)),
    });
    rewritten.push([stoppedOid, resumeHead]);
  }
  return replayInteractive(ctx, ic, resumeHead, { applied: [], rewritten });
};

/** Skip the stopped instruction (drop the edit'd commit, or discard the
 *  conflicted pick) and replay the remaining todo. */
const rebaseSkipInteractive = async (ctx: Context, state: RebaseState): Promise<RebaseResult> => {
  const currentHead = await resolveRef(ctx, HEAD);
  const target =
    state.amend !== undefined
      ? ((await readCommitData(ctx, state.amend)).parents[0] as ObjectId)
      : currentHead;
  // An edit stop already committed the edit'd commit, so dropping it moves the
  // detached HEAD back to its parent; a conflict stop never committed, so HEAD
  // already sits at the last good pick — writing it back to itself is a no-op.
  await getRefStore(ctx).writeLoose(HEAD, target);
  await hardResetWorktreeToCommit(ctx, target);
  const ic: InteractiveContext = {
    branch: branchOf(state.headName),
    onto: state.onto,
    origHead: state.origHead,
    doneBefore: state.done,
    todo: state.remaining,
  };
  return replayInteractive(ctx, ic, target, {
    applied: [],
    rewritten: await readRewrittenList(ctx),
  });
};
