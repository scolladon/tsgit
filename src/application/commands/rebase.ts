/**
 * `rebase` (non-interactive) — replay the commits unique to the current branch on
 * top of another base, faithful to git's merge backend. HEAD is detached at the
 * new base, each commit is replayed as a cherry-pick (3-way merge through the
 * shared `applyMergeToWorktree` primitive, preserving the source author with the
 * current committer), then the branch is updated and HEAD reattached at finish.
 * Conflicts stop under a byte-faithful `.git/rebase-merge/` state + `REBASE_HEAD`.
 */
import {
  checkoutOverwriteDirty,
  invalidOption,
  noOperationInProgress,
  workingTreeDirty,
} from '../../domain/commands/error.js';
import { renderPatch, sortedRecordedPaths } from '../../domain/diff/index.js';
import type { TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { type ConflictType, type MergeConflict, replayLabels } from '../../domain/merge/index.js';
import { amendedExtraHeaders } from '../../domain/objects/amend-headers.js';
import type { CommitData, ExtraHeader } from '../../domain/objects/commit.js';
import { subjectLine } from '../../domain/objects/commit-message.js';
import type { FileMode, FilePath, ObjectId, RefName } from '../../domain/objects/index.js';
import {
  buildCombinedMessage,
  type CombinedMessageEntry,
  type RebaseBackupHeader,
  type RebaseLabelLine,
  type RebaseResetLine,
  type RebaseTodoAction,
} from '../../domain/rebase/index.js';
import {
  REBASE_FAST_FORWARD,
  REBASE_REFLOG_ACTION,
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
import { abbreviateObjectId } from '../primitives/abbreviate-object-id.js';
import { createCommit, createCommitWithStoredHeaders } from '../primitives/create-commit.js';
import { diffTrees } from '../primitives/diff-trees.js';
import { flattenEscapedTree } from '../primitives/flatten-tree.js';
import { removeAutoMerge } from '../primitives/internal/auto-merge-ref.js';
import { acquireIndexLock } from '../primitives/internal/index-lock.js';
import {
  assertNoPendingOperation,
  assertOperationalRepositorySettingsFirst,
  branchRefFromHead,
  readHeadRaw,
  requireWorkTree,
} from '../primitives/internal/repo-state.js';
import { materialisePatchFiles } from '../primitives/materialise-patch-files.js';
import { mergeBasesOf } from '../primitives/merge-base.js';
import { assertEverySourceLoadable } from '../primitives/object-store.js';
import { readIndex } from '../primitives/read-index.js';
import { getRefStore } from '../primitives/ref-store.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { runHook, runInformationalHook } from '../primitives/run-hook.js';
import { updateRef } from '../primitives/update-ref.js';
import { walkCommits, walkCommitsStoppingAt } from '../primitives/walk-commits.js';
import { configuredAutostash } from './internal/autostash-config.js';
import { removeBranchState, removeCommittedState } from './internal/branch-state.js';
import { conflictMergeMsg } from './internal/cherry-pick-state.js';
import {
  cleanWorkTreePreflight,
  type SubmoduleIgnoreModes,
  stagedChangePaths,
  unstagedChangePaths,
  type WorkTreePreflight,
} from './internal/clean-work-tree.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { sanitizeMessage, stripComments } from './internal/commit-message.js';
import { resolveCurrentIdentity } from './internal/current-identity.js';
import { readCommitData, resolveHeadCommit, treeOf } from './internal/history-rewrite.js';
import { clearMergeMsg, readMergeHead, writeOrigHead } from './internal/merge-state.js';
import { isOriginallyEmpty } from './internal/original-empty.js';
import { previousCheckoutArg } from './internal/prior-checkout.js';
import { canFastForward } from './internal/rebase-fast-forward.js';
import {
  deleteRewrittenRefs,
  fastForwardHead,
  labelHead,
  mergeTreesUnderLock,
  recreateMerge,
  resetToLabel,
} from './internal/rebase-merges-steps.js';
import { rebaseMergesTodo } from './internal/rebase-merges-todo.js';
import { resolveRebaseReplay } from './internal/rebase-replay.js';
import { resolveRebaseSides } from './internal/rebase-revisions.js';
import {
  clearRebaseState,
  dropFixupGroup,
  type RebaseProgress,
  type RebaseState,
  type RebaseStop,
  readAutostash,
  readRebaseProgress,
  readRebaseState,
  readRewrittenList,
  serializeRewritten,
  writeAutostash,
  writeRebaseStop,
  writeRescheduledPick,
} from './internal/rebase-state.js';
import { toConflictList } from './internal/replay-sequence.js';
import {
  hardResetWorktreeToCommit,
  protectedResetWorktreeToCommit,
} from './internal/reset-worktree.js';
import { writeContinuedIndex } from './internal/write-index-cache-tree.js';
import { applyAutostash, createAutostash } from './stash.js';

export type { ConflictType } from '../../domain/merge/index.js';

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

/** What `pull` threads into the rebase it runs — not part of the public surface. */
export interface RebaseInternalOptions {
  /** git's `GIT_REFLOG_ACTION`: the action prefix of every reflog entry this run writes. */
  readonly reflogAction: string;
}

export interface RebaseRunInput {
  /** The fork-point side — any revision that peels to a commit (`git rebase <upstream>`). */
  readonly upstream: string;
  /** `--onto <newbase>`: replay onto this base instead of `upstream`; `A...B` is their sole merge base. */
  readonly onto?: string;
  /** Present → interactive: the post-`$EDITOR` instruction list (`git rebase -i`). */
  readonly interactive?: ReadonlyArray<RebaseInstruction>;
  /**
   * `--rebase-merges[=<mode>]`: recreate the branch's merges instead of
   * flattening them. `true` is git's default `no-rebase-cousins` (a side branch
   * rooted outside the range keeps its base); `'rebase-cousins'` rebases it onto
   * the new base too.
   */
  readonly rebaseMerges?: boolean | 'rebase-cousins' | 'no-rebase-cousins';
  /**
   * `--autostash` / `--no-autostash`; unset reads `rebase.autostash`. A dirty
   * tree is stashed (`On <branch>: autostash`) and re-applied when the rebase
   * ends or aborts; a conflicting re-apply keeps the conflict and stores the
   * stash in `refs/stash`.
   */
  readonly autostash?: boolean;
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

/** A resolved `merge -C` line. */
interface PlannedMerge {
  readonly action: 'merge';
  readonly oid: ObjectId;
  readonly labels: ReadonlyArray<string>;
  readonly subject: string;
}

/** Any resolved line of a non-interactive todo, `--rebase-merges` verbs included. */
type PlannedLine = PlannedPick | PlannedMerge | RebaseLabelLine | RebaseResetLine;

const shortOid = (oid: ObjectId): string => oid.slice(0, 7);

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
  for await (const c of walkCommitsStoppingAt(ctx, { from: [head], until: excluded }))
    ids.push(c.id);
  return ids.reverse();
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

/** A staged gitlink change git's two-way checkout keeps; `entry` is `undefined` for a staged removal. */
interface CarriedGitlink {
  readonly path: FilePath;
  readonly entry: IndexEntry | undefined;
}

const sameTreeEntry = (
  a: { readonly id: ObjectId; readonly mode: FileMode } | undefined,
  b: { readonly id: ObjectId; readonly mode: FileMode } | undefined,
): boolean => a?.id === b?.id && a?.mode === b?.mode;

/**
 * git's two-way checkout keeps a staged path HEAD and `onto` agree on, and one the index
 * already holds as `onto` does; it rejects a staged version that matches neither.
 */
const assertOntoAgrees = async (
  ctx: Context,
  trees: { readonly head: ObjectId; readonly onto: ObjectId },
  carried: ReadonlyArray<CarriedGitlink>,
): Promise<void> => {
  const head = (await flattenEscapedTree(ctx, trees.head)).entries;
  const onto = (await flattenEscapedTree(ctx, trees.onto)).entries;
  const differing = carried
    .filter(
      ({ path, entry }) =>
        !sameTreeEntry(head.get(path), onto.get(path)) && !sameTreeEntry(entry, onto.get(path)),
    )
    .map(({ path }) => path);
  if (differing.length === 0) return;
  throw checkoutOverwriteDirty({ localChanges: differing, untracked: [] });
};

/** The staged gitlink changes the onto checkout must keep, or its refusal when `onto` disagrees. */
const gitlinksToCarry = async (
  ctx: Context,
  headCommit: ObjectId,
  onto: ObjectId,
  paths: ReadonlyArray<FilePath>,
): Promise<ReadonlyArray<CarriedGitlink>> => {
  // Stryker disable next-line ConditionalExpression: equivalent — an empty `paths` makes `carried` empty, so `assertOntoAgrees` has nothing to compare and the result is the same `[]`; the guard only skips the index and tree reads.
  if (paths.length === 0) return [];
  const { entries } = await readIndex(ctx);
  const carried = paths.map((path) => ({
    path,
    entry: entries.find((entry) => entry.path === path),
  }));
  const trees = { head: await treeOf(ctx, headCommit), onto: await treeOf(ctx, onto) };
  await assertOntoAgrees(ctx, trees, carried);
  return carried;
};

/** Put the carried gitlink changes back over the freshly checked-out `onto` index. */
const restageCarried = async (
  ctx: Context,
  carried: ReadonlyArray<CarriedGitlink>,
): Promise<void> => {
  // Stryker disable next-line ConditionalExpression: equivalent — with nothing carried the lock rewrites the same entries it just read, so no state differs; the guard only skips that write.
  if (carried.length === 0) return;
  const lock = await acquireIndexLock(ctx);
  try {
    const carriedPaths = new Set(carried.map(({ path }) => path));
    const kept = (await readIndex(ctx)).entries.filter((entry) => !carriedPaths.has(entry.path));
    const restaged = carried.flatMap(({ entry }) => (entry === undefined ? [] : [entry]));
    await lock.commit([...kept, ...restaged], 'update');
  } finally {
    await lock.release();
  }
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
  reflogAction: string,
  carried: ReadonlyArray<CarriedGitlink>,
): Promise<void> => {
  await getRefStore(ctx).applyRefUpdates([
    {
      kind: 'set',
      name: HEAD,
      id: onto,
      reflog: {
        oldId: fromHead,
        newId: onto,
        message: rebaseStartCheckout(ontoName, reflogAction),
      },
    },
  ]);
  await hardResetWorktreeToCommit(ctx, onto);
  await restageCarried(ctx, carried);
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
) => {
  const parentId = cData.parents[0];
  return mergeTreesUnderLock(ctx, {
    baseTree: parentId !== undefined ? await treeOf(ctx, parentId) : undefined,
    ours: ourId,
    theirsTree: cData.tree,
    labels: replayLabels(source, subjectLine(cData.message)),
  });
};

/** Apply one commit onto the detached HEAD `ourId`; commit it (single-parent,
 *  `rebase (pick)`) when the clean merge changed the tree, else report `empty`. */
const replayOne = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  ourId: ObjectId,
  reflogAction: string,
): Promise<ReplayOutcome> => {
  if (cData.parents[0] === ourId) {
    await fastForwardHead(ctx, source, reflogAction);
    return { kind: 'committed', id: source };
  }
  const outcome = await mergeUnderLock(ctx, source, cData, ourId);
  if (outcome.kind === 'conflict') return { kind: 'conflict', conflicts: outcome.conflicts };
  // git keeps a commit that started empty and drops only one the replay made empty.
  if (outcome.mergedTree === outcome.oursTree && !(await isOriginallyEmpty(ctx, cData))) {
    return { kind: 'empty' };
  }
  return {
    kind: 'committed',
    id: await commitPick(ctx, outcome.mergedTree, cData, ourId, reflogAction),
  };
};

/** Commit a clean pick's tree onto `ourId` and advance HEAD with `rebase (pick)`. */
const commitPick = async (
  ctx: Context,
  tree: ObjectId,
  cData: CommitData,
  ourId: ObjectId,
  reflogAction: string,
): Promise<ObjectId> => {
  const committer = await resolveCurrentIdentity(ctx);
  const id = await createCommit(ctx, {
    tree,
    parents: [ourId],
    author: cData.author,
    committer,
    message: cData.message,
    extraHeaders: [],
  });
  await updateRef(ctx, HEAD, id, {
    expected: ourId,
    reflogMessage: rebasePickReflog(subjectLine(cData.message), reflogAction),
  });
  return id;
};

/** Render the failed pick's `parent..commit` diff for `.git/rebase-merge/patch`. */
const renderCommitPatch = async (ctx: Context, cData: CommitData): Promise<string> => {
  const parentId = cData.parents[0];
  const parentTree = parentId !== undefined ? await treeOf(ctx, parentId) : undefined;
  // Recurse like git: the patch file must render nested changes per-file, not
  // choke on a sub-tree the patch hydration would read as a blob.
  const diff = await diffTrees(ctx, parentTree, cData.tree, { recursive: true });
  const files = await materialisePatchFiles(ctx, diff.changes);
  // Stryker disable next-line ObjectLiteral: equivalent — `renderPatch`'s defaults are exactly `contextLines: 3` + `{ old: 'a/', new: 'b/' }`, so passing `{}` produces byte-identical output.
  return renderPatch(files, { contextLines: 3, pathPrefix: { old: 'a/', new: 'b/' } });
};

/** What finishing a rebase moves: the branch (none when detached) from its original tip. */
interface FinishSides {
  readonly branch: RefName | undefined;
  readonly onto: ObjectId;
  readonly origHead: ObjectId;
  readonly reflogAction: string;
}

/** The shared context a replay loop needs to stop or finish. `branch` is
 *  `undefined` for a detached-HEAD rebase (head-name = `detached HEAD`). */
interface ReplayContext extends FinishSides {
  /** Instructions completed before this loop (a stop's `done` prepends these). */
  readonly doneBefore: ReadonlyArray<PlannedLine>;
  /** Instructions to replay in this loop (the live `git-rebase-todo`). */
  readonly todo: ReadonlyArray<PlannedLine>;
  /** Set on the initial (fresh-run) stop only — git writes the backup once. */
  readonly backupHeader?: RebaseBackupHeader;
  /** The submodule ignore modes the pre-flight read; a resumed run reads them afresh, as git's new process does. */
  readonly submoduleIgnores?: SubmoduleIgnoreModes;
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
  stopped: { readonly source: ObjectId; readonly cData: CommitData; readonly message: string },
  rewritten: ReadonlyArray<readonly [ObjectId, ObjectId]>,
): Promise<void> => {
  const { source, cData, message } = stopped;
  const stop: RebaseStop = {
    headName: rc.branch ?? 'detached HEAD',
    onto: rc.onto,
    origHead: rc.origHead,
    done: [...rc.doneBefore, ...rc.todo.slice(0, index + 1)],
    remaining: rc.todo.slice(index + 1),
    stoppedSha: source,
    stoppedAuthor: cData.author,
    message,
    rewritten,
    // git's patch of a merge commit shows no diff.
    patch: cData.parents.length > 1 ? '' : await renderCommitPatch(ctx, cData),
    // Stryker disable next-line ConditionalExpression: equivalent — on a continue/skip re-stop `rc.backupHeader` is `undefined`, so forcing this to `true` spreads `{ backupHeader: undefined }`, which `writeRebaseStop` skips exactly like the `{}` branch.
    ...(rc.backupHeader !== undefined ? { backupHeader: rc.backupHeader } : {}),
    ...(cData.parents.length > 1 ? {} : { mergeMsg: message }),
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
  { branch, origHead, onto, reflogAction }: FinishSides,
  newTip: ObjectId,
): Promise<void> => {
  if (branch === undefined) return;
  await updateRef(ctx, branch, newTip, {
    expected: origHead,
    reflogMessage: rebaseFinishOnto(branch, onto, reflogAction),
  });
  await getRefStore(ctx).applyRefUpdates([
    {
      kind: 'setSymbolic',
      name: HEAD,
      target: branch,
      reflog: {
        oldId: newTip,
        newId: newTip,
        message: rebaseFinishReturningTo(branch, reflogAction),
      },
    },
  ]);
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

type LineOutcome =
  | ReplayOutcome
  | { readonly kind: 'moved'; readonly head: ObjectId }
  | { readonly kind: 'kept' };

/** Run one todo line on the detached HEAD `cur`. */
const replayLine = async (
  ctx: Context,
  rc: ReplayContext,
  line: PlannedLine,
  cur: ObjectId,
): Promise<LineOutcome> => {
  if (line.action === 'label') {
    await labelHead(ctx, line.label);
    return { kind: 'moved', head: cur };
  }
  if (line.action === 'reset') {
    return { kind: 'moved', head: await resetToLabel(ctx, line.label, rc.reflogAction) };
  }
  const cData = await readCommitData(ctx, line.oid);
  if (line.action !== 'merge') return replayOne(ctx, line.oid, cData, cur, rc.reflogAction);
  const step = { source: line.oid, original: cData, labels: line.labels, head: cur };
  return recreateMerge(ctx, { ...step, reflogAction: rc.reflogAction });
};

/** Stop on a conflicted line; a merge records its rewrite to HEAD first, as git's does. */
const stopOnConflict = async (
  ctx: Context,
  rc: ReplayContext,
  at: { readonly index: number; readonly cur: ObjectId },
  conflicts: ReadonlyArray<MergeConflict>,
  rewritten: ReadonlyArray<readonly [ObjectId, ObjectId]>,
): Promise<RebaseResult> => {
  const line = rc.todo[at.index] as PlannedPick | PlannedMerge;
  const cData = await readCommitData(ctx, line.oid);
  const isMerge = line.action === 'merge';
  const recorded = isMerge ? [...rewritten, [line.oid, at.cur] as const] : rewritten;
  // git's merge stop keeps the original message; a pick's lists its conflicts.
  const message = isMerge
    ? cData.message
    : conflictMergeMsg(cData.message, sortedRecordedPaths(conflicts));
  const stopped = { source: line.oid, cData, message };
  await persistStop(ctx, rc, at.index, stopped, recorded);
  return {
    kind: 'conflict',
    commit: line.oid,
    conflicts: toConflictList(conflicts),
    remaining: rc.todo.length - (at.index + 1),
  };
};

/**
 * git's `do_pick_commit` refuses a pick while the index differs from HEAD, gitlinks
 * counted, and leaves the pick rescheduled so `--continue` retries it and `--abort` restores.
 * Every pick leaves the index equal to HEAD, so only a todo opening with a pick can meet a
 * dirty one: a `--rebase-merges` script opens with a `reset` that discards the staged change.
 */
const refuseDirtyIndexBeforeFirstPick = async (
  ctx: Context,
  rc: ReplayContext,
  cur: ObjectId,
): Promise<void> => {
  const first = rc.todo[0];
  if (first?.action !== 'pick') return;
  const staged = await stagedChangePaths(ctx, await treeOf(ctx, cur), rc.submoduleIgnores);
  if (staged.length === 0) return;
  await writeRescheduledPick(ctx, {
    headName: rc.branch ?? 'detached HEAD',
    onto: rc.onto,
    origHead: rc.origHead,
    done: [...rc.doneBefore, first],
    remaining: rc.todo,
    pickSha: first.oid,
    backupHeader: rc.backupHeader,
  });
  throw workingTreeDirty({ localChanges: staged, untracked: [] });
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
  await refuseDirtyIndexBeforeFirstPick(ctx, rc, ourId);
  for (let i = 0; i < rc.todo.length; i += 1) {
    const line = rc.todo[i]!;
    await removeAutoMerge(ctx);
    const outcome = await replayLine(ctx, rc, line, cur);
    if (outcome.kind === 'moved') cur = outcome.head;
    // git's dropped empty pick takes its AUTO_MERGE with it.
    else if (outcome.kind === 'empty') await removeAutoMerge(ctx);
    else if (outcome.kind === 'conflict') {
      return stopOnConflict(ctx, rc, { index: i, cur }, outcome.conflicts, rewritten);
    } else if ('oid' in line) {
      const created = outcome.kind === 'committed' ? outcome.id : cur;
      if (outcome.kind === 'committed') applied.push({ source: line.oid, created });
      rewritten.push([line.oid, created]);
      cur = created;
    }
  }
  await finishRebase(ctx, rc, cur);
  await firePostRewrite(ctx, rewritten);
  await deleteRewrittenRefs(ctx, [...rc.doneBefore, ...rc.todo]);
  await endRebaseState(ctx);
  return { kind: 'rebased', commits: applied };
};

/**
 * An interactive rebase always has todo work (the caller supplies it), so it is
 * never the no-op "up to date" case — pre-rebase fires. No common ancestor
 * (unrelated histories) leaves `base` undefined and the whole branch replays
 * onto `onto` — faithful to `git rebase <unrelated>`.
 */
const startInteractive = async (
  ctx: Context,
  upstreamName: string,
  instructions: ReadonlyArray<RebaseInstruction>,
  sides: Omit<InteractivePlan, 'instructions' | 'base'>,
): Promise<RebaseResult> => {
  const [base] = await mergeBasesOf(ctx, [sides.upstream, sides.headCommit]);
  await assertEverySourceLoadable(ctx);
  await firePreRebase(ctx, upstreamName);
  return rebaseRunInteractive(ctx, { ...sides, instructions, base });
};

/** git's `--autostash` / `rebase.autostash`: stash a dirty tree before the rebase. */
const autostashIfWanted = async (
  ctx: Context,
  given: boolean | undefined,
): Promise<ObjectId | undefined> => {
  if (!(given ?? (await configuredAutostash(ctx, 'rebase')) ?? false)) return undefined;
  const stash = await createAutostash(ctx);
  if (stash !== undefined) {
    ctx.logger?.info?.(`Created autostash: ${await abbreviateObjectId(ctx, stash)}`);
  }
  return stash;
};

/** End the rebase's state, then re-apply its autostash, as git's `apply_autostash` does. */
const endRebaseState = async (ctx: Context): Promise<void> => {
  const stash = await readAutostash(ctx);
  await clearRebaseState(ctx);
  if (stash !== undefined) await applyAutostash(ctx, stash);
};

const rebasingMerges = (mode: RebaseRunInput['rebaseMerges']): boolean =>
  mode !== undefined && mode !== false;

/** The todo: git's flattened picks, or its `--rebase-merges` script. */
const planTodo = async (
  ctx: Context,
  mode: RebaseRunInput['rebaseMerges'],
  range: { readonly upstream: ObjectId; readonly head: ObjectId },
): Promise<ReadonlyArray<PlannedLine>> => {
  if (!rebasingMerges(mode)) return buildTodoEntries(ctx, await resolveRebaseReplay(ctx, range));
  const rebaseCousins = mode === 'rebase-cousins';
  return (await rebaseMergesTodo(ctx, { ...range, rebaseCousins })) as ReadonlyArray<PlannedLine>;
};

export const rebaseRun = async (
  ctx: Context,
  input: RebaseRunInput,
  { reflogAction }: RebaseInternalOptions = { reflogAction: REBASE_REFLOG_ACTION },
): Promise<RebaseResult> => {
  await assertOperationalRepositorySettingsFirst(ctx);
  requireWorkTree(ctx, 'rebase');
  await assertNoPendingOperation(ctx);
  const sides = await resolveRunSides(ctx, input);
  if (input.interactive !== undefined && rebasingMerges(input.rebaseMerges)) {
    throw invalidOption('rebaseMerges', 'interactive instructions cannot carry merges');
  }
  const stash = await autostashIfWanted(ctx, input.autostash);
  const preflight = await cleanWorkTreePreflight(ctx, await treeOf(ctx, sides.headCommit));
  if (input.interactive !== undefined) {
    if (stash !== undefined) await writeAutostash(ctx, stash);
    const { branch, headCommit, upstream, onto, ontoName } = sides;
    const interactiveSides = { branch, headCommit, upstream, onto, ontoName };
    return startInteractive(ctx, sides.upstreamName, input.interactive, interactiveSides);
  }
  return replayUnlessUpToDate(ctx, input.rebaseMerges, sides, { stash, reflogAction, preflight });
};

interface RunOptions {
  readonly stash: ObjectId | undefined;
  readonly reflogAction: string;
  /** What the pre-flight read: the ignore modes kept for the run as git's process keeps them, and the staged gitlinks to carry. */
  readonly preflight: WorkTreePreflight;
}

/** git fires pre-rebase only when the rebase will do work; an up-to-date rebase
 *  (nothing to replay or fast-forward) returns before the hook, matching git. */
const replayUnlessUpToDate = async (
  ctx: Context,
  mode: RebaseRunInput['rebaseMerges'],
  sides: RunSides,
  run: RunOptions,
): Promise<RebaseResult> => {
  const { onto, upstream, branchBase } = sides;
  if (await canFastForward(ctx, { onto, upstream, head: sides.headCommit, branchBase })) {
    return finishUpToDate(ctx, run.stash);
  }
  if (run.stash !== undefined) await writeAutostash(ctx, run.stash);
  return startReplay(ctx, mode, sides, run);
};

/** Both sides of a non-interactive run, named and resolved. */
interface RunSides {
  readonly branch: RefName | undefined;
  readonly headCommit: ObjectId;
  readonly upstreamName: string;
  readonly ontoName: string;
  readonly upstream: ObjectId;
  readonly onto: ObjectId;
  readonly branchBase: ObjectId | undefined;
}

const resolveRunSides = async (ctx: Context, input: RebaseRunInput): Promise<RunSides> => {
  const head = await readHeadRaw(ctx);
  const headCommit = head.kind === 'symbolic' ? await resolveHeadCommit(ctx, head.target) : head.id;
  const branch = branchRefFromHead(head);
  const upstreamName = previousCheckoutArg(input.upstream);
  const ontoName = input.onto ?? upstreamName;
  const sideNames = { upstreamName, ontoName, head: headCommit };
  const { upstream, onto, branchBase } = await resolveRebaseSides(ctx, sideNames);
  return { branch, headCommit, upstreamName, ontoName, upstream, onto, branchBase };
};

/** git's `finish_rebase`, which the merge backend's own pick loop never reaches. */
const finishUpToDate = async (ctx: Context, stash: ObjectId | undefined): Promise<RebaseResult> => {
  await removeAutoMerge(ctx);
  if (stash !== undefined) await applyAutostash(ctx, stash);
  return { kind: 'up-to-date' };
};

/** Fire pre-rebase, plan the todo, detach onto `onto` and replay it. */
const startReplay = async (
  ctx: Context,
  mode: RebaseRunInput['rebaseMerges'],
  sides: RunSides,
  { reflogAction, preflight }: Pick<RunOptions, 'reflogAction' | 'preflight'>,
): Promise<RebaseResult> => {
  const { headCommit, upstream, onto } = sides;
  await assertEverySourceLoadable(ctx);
  await firePreRebase(ctx, sides.upstreamName);
  const todo = await planTodo(ctx, mode, { upstream, head: headCommit });
  const carried = await gitlinksToCarry(ctx, headCommit, onto, preflight.carried);
  await writeOrigHead(ctx, headCommit);
  await detachHead(ctx, headCommit, onto, sides.ontoName, reflogAction, carried);
  const rc: ReplayContext = {
    branch: sides.branch,
    onto,
    reflogAction,
    origHead: headCommit,
    doneBefore: [],
    todo,
    backupHeader: backupHeaderOf(upstream, headCommit, onto),
    submoduleIgnores: preflight.modes,
  };
  return replayFrom(ctx, rc, onto, { applied: [], rewritten: [] });
};

const backupHeaderOf = (upstream: ObjectId, origHead: ObjectId, onto: ObjectId) => ({
  shortUpstream: shortOid(upstream),
  shortOrigHead: shortOid(origHead),
  shortOnto: shortOid(onto),
});

export interface RebaseAbortResult {
  readonly head: ObjectId;
  readonly headName: string;
}

/** The branch a stop's `head-name` names, or `undefined` for a detached rebase. */
const branchOf = (headName: string): RefName | undefined =>
  headName === 'detached HEAD' ? undefined : (headName as RefName);

/**
 * Resume the rebase after the conflicted commit was resolved: commit the resolved
 * index as the stopped commit (preserved author from `author-script`, current
 * committer, `rebase (continue)` reflog), then replay the remaining todo. An
 * index matching HEAD (resolution committed by hand, or resolved to HEAD) makes
 * no commit — HEAD stands in for the stopped commit, as in git.
 */
export const rebaseContinue = async (ctx: Context): Promise<RebaseResult> => {
  await assertOperationalRepositorySettingsFirst(ctx);
  requireWorkTree(ctx, 'rebase --continue');
  const progress = await readRebaseProgress(ctx);
  if (progress === undefined) throw noOperationInProgress('rebase');
  await assertNothingUnstaged(ctx);
  await assertEverySourceLoadable(ctx);
  if (progress.rescheduled) return continueRescheduled(ctx, progress);
  const state = (await readRebaseState(ctx)) as RebaseState;
  if (isInteractiveState(state)) return rebaseContinueInteractive(ctx, state);
  return continueStop(ctx, state);
};

/**
 * Retry a pick git refused for a dirty index: `--continue` re-counts the todo (the pick
 * sits in `done` and in the live list), refuses while the index still differs from HEAD,
 * else replays the rescheduled pick and the rest.
 */
const continueRescheduled = async (
  ctx: Context,
  progress: RebaseProgress,
): Promise<RebaseResult> => {
  const total = progress.done.length + progress.remaining.length;
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/rebase-merge/end`, `${total}\n`);
  const head = await resolveRef(ctx, HEAD);
  const staged = await stagedChangePaths(ctx, await treeOf(ctx, head));
  if (staged.length > 0) throw workingTreeDirty({ localChanges: staged, untracked: [] });
  return retryRescheduledPick(ctx, progress, head);
};

/** The rescheduled pick sits in `done` and in the live todo; the retry replays it from the todo, which lists it in `done` once more as git does. */
const retryRescheduledPick = (
  ctx: Context,
  progress: RebaseProgress,
  head: ObjectId,
): Promise<RebaseResult> => {
  const rc = { ...replayContextOf(progress), doneBefore: progress.done };
  return replayFrom(ctx, rc, head, { applied: [], rewritten: [] });
};

/** git's `--skip` hard-resets to HEAD (dropping the staged change) and retries the rescheduled pick. */
const skipRescheduled = async (ctx: Context, progress: RebaseProgress): Promise<RebaseResult> => {
  const head = await resolveRef(ctx, HEAD);
  await protectedResetWorktreeToCommit(ctx, head);
  return retryRescheduledPick(ctx, progress, head);
};

/** Commit the resolved stop (unless it matches HEAD) and replay the rest of the todo. */
const continueStop = async (ctx: Context, state: RebaseState): Promise<RebaseResult> => {
  const tree = await writeContinuedIndex(ctx);
  const stopped = stoppedCommit(state);
  const currentHead = await resolveRef(ctx, HEAD);
  const rc = replayContextOf(state);
  const rewrittenBefore = await readRewrittenList(ctx);
  const mergeHead = await readMergeHead(ctx);
  const created = await commitResolution(ctx, state, tree, { head: currentHead, mergeHead });
  const resumeAt = created ?? currentHead;
  return replayFrom(ctx, rc, resumeAt, {
    applied: created === undefined ? [] : [{ source: stopped, created }],
    rewritten: [...rewrittenBefore, [stopped, resumeAt] as const],
  });
};

/** The resolution commit, or `undefined` when the index matches HEAD, a pending
 *  merge included — HEAD then stands in for the stopped commit. */
const commitResolution = async (
  ctx: Context,
  state: RebaseState,
  tree: ObjectId,
  parents: { readonly head: ObjectId; readonly mergeHead: ObjectId | undefined },
): Promise<ObjectId | undefined> => {
  if (await treeMatchesCommit(ctx, tree, parents.head)) {
    if (parents.mergeHead !== undefined) await dropPendingMerge(ctx);
    return undefined;
  }
  const resolutionId = await commitStoppedResolution(ctx, state, tree, parents);
  await concludeStopCommit(ctx);
  return resolutionId;
};

/** A merge resolved to HEAD's own tree commits nothing; its MERGE_HEAD and MERGE_MSG go, MERGE_MODE stays, as in git. */
const dropPendingMerge = async (ctx: Context): Promise<void> => {
  await ctx.fs.rm(`${ctx.layout.gitDir}/MERGE_HEAD`);
  await clearMergeMsg(ctx);
};

/** git's `has_unstaged_changes` gate: a tracked file changed but not staged stops `--continue`. */
const assertNothingUnstaged = async (ctx: Context): Promise<void> => {
  const unstaged = await unstagedChangePaths(ctx);
  if (unstaged.length > 0) throw workingTreeDirty({ localChanges: unstaged, untracked: [] });
};

const replayContextOf = (
  state: Pick<RebaseProgress, 'headName' | 'onto' | 'origHead' | 'done' | 'remaining'>,
): ReplayContext => ({
  reflogAction: REBASE_REFLOG_ACTION,
  branch: branchOf(state.headName),
  onto: state.onto,
  origHead: state.origHead,
  doneBefore: state.done,
  todo: state.remaining,
});

/** Commit the staged resolution as the stopped commit (its author, the current
 *  committer, its comment-stripped message) on top of HEAD. */
const commitStoppedResolution = async (
  ctx: Context,
  state: RebaseState,
  tree: ObjectId,
  { head, mergeHead }: { readonly head: ObjectId; readonly mergeHead: ObjectId | undefined },
): Promise<ObjectId> => {
  // Stryker disable next-line BooleanLiteral: equivalent — the rebase `message` file carries the replayed commit's subject, so the stripped/sanitised message is always non-empty here and the empty-message guard never fires.
  const message = sanitizeMessage(stripComments(state.message), { allowEmpty: false });
  const created = await commitAndAdvance(ctx, {
    tree,
    parent: head,
    ...(mergeHead !== undefined ? { mergeParent: mergeHead } : {}),
    expected: head,
    author: state.author,
    message,
    reflog: rebaseContinueReflog(subjectLine(message)),
  });
  // A stopped `merge -C` commits as `git commit` does, which ends the merge.
  if (mergeHead !== undefined) await removeCommittedState(ctx);
  return created;
};

/** git's `is_clean`: a staged index equal to HEAD's tree leaves nothing to
 *  commit — the caller committed the resolution, or resolved to HEAD. */
const treeMatchesCommit = async (
  ctx: Context,
  tree: ObjectId,
  commitId: ObjectId,
): Promise<boolean> => (await readCommitData(ctx, commitId)).tree === tree;

/** Drop the conflicted commit (hard-reset to the last good pick) and replay the rest. */
export const rebaseSkip = async (ctx: Context): Promise<RebaseResult> => {
  await assertOperationalRepositorySettingsFirst(ctx);
  requireWorkTree(ctx, 'rebase --skip');
  const progress = await readRebaseProgress(ctx);
  if (progress === undefined) throw noOperationInProgress('rebase');
  await assertEverySourceLoadable(ctx);
  if (progress.rescheduled) return skipRescheduled(ctx, progress);
  const state = (await readRebaseState(ctx)) as RebaseState;
  if (isInteractiveState(state)) return rebaseSkipInteractive(ctx, state);
  const currentHead = await resolveRef(ctx, HEAD);
  await protectedResetWorktreeToCommit(ctx, currentHead);
  await removeBranchState(ctx, 'silent');
  // git's continue records the skipped commit as rewritten to HEAD.
  const skipped = [stoppedCommit(state), currentHead] as const;
  return replayFrom(ctx, replayContextOf(state), currentHead, {
    applied: [],
    rewritten: [...(await readRewrittenList(ctx)), skipped],
  });
};

/**
 * Abort the rebase: hard-reset the working tree + index to the pre-rebase tip,
 * reattach `head-name`, record git's `rebase (abort): returning to <name>` reflog
 * (the branch never moved during the replay, so it gets no entry), clear state.
 */
export const rebaseAbort = async (ctx: Context): Promise<RebaseAbortResult> => {
  await assertOperationalRepositorySettingsFirst(ctx);
  requireWorkTree(ctx, 'rebase --abort');
  const state = await readRebaseProgress(ctx);
  if (state === undefined) throw noOperationInProgress('rebase');
  const branch = branchOf(state.headName);
  const currentHead = await resolveRef(ctx, HEAD);
  await protectedResetWorktreeToCommit(ctx, state.origHead);
  await returnHeadFromRebase(ctx, { branch, origHead: state.origHead, currentHead });
  await removeBranchState(ctx, 'silent');
  await deleteRewrittenRefs(ctx, state.done);
  await endRebaseState(ctx);
  return { head: state.origHead, headName: state.headName };
};

/** A branch rebase reattaches HEAD to the ref (`returning to <branch>`); a
 *  detached rebase moves HEAD back to the original oid (`returning to <oid>`). */
const returnHeadFromRebase = async (
  ctx: Context,
  heads: {
    readonly branch: RefName | undefined;
    readonly origHead: ObjectId;
    readonly currentHead: ObjectId;
  },
): Promise<void> => {
  const { branch, origHead } = heads;
  const reflog = {
    oldId: heads.currentHead,
    newId: origHead,
    message:
      branch !== undefined ? rebaseAbortReturningTo(branch) : rebaseAbortReturningTo(origHead),
  };
  await getRefStore(ctx).applyRefUpdates([
    branch !== undefined
      ? { kind: 'setSymbolic', name: HEAD, target: branch, reflog }
      : { kind: 'set', name: HEAD, id: origHead, reflog },
  ]);
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
      // Stryker disable next-line ConditionalExpression: equivalent — forcing this to `true` spreads `{ message: undefined }`, and every downstream reader (`inst.message ?? …`, `inst.message !== undefined`) treats an explicit `undefined` exactly like an absent key.
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
  await getRefStore(ctx).applyRefUpdates([
    {
      kind: 'set',
      name: HEAD,
      id: foldedHead,
      reflog: { oldId: fromHead, newId: foldedHead, message: rebaseStartCheckout(ontoName) },
    },
  ]);
  await hardResetWorktreeToCommit(ctx, foldedHead);
};

/** Fast-forward the detached HEAD onto `target` (kept verbatim — its first parent
 *  is the current HEAD), recording git's `rebase: fast-forward`. */
const fastForwardOnto = async (ctx: Context, target: ObjectId): Promise<void> => {
  const from = await resolveRef(ctx, HEAD);
  await getRefStore(ctx).applyRefUpdates([
    {
      kind: 'set',
      name: HEAD,
      id: target,
      reflog: { oldId: from, newId: target, message: REBASE_FAST_FORWARD },
    },
  ]);
  await hardResetWorktreeToCommit(ctx, target);
};

/** Create a replayed commit and advance the detached HEAD to it. `parent` is the
 *  new commit's first parent — `undefined` when the commit being replaced has a
 *  masked/empty parent list (a shallow boundary behaves as a root commit, so its
 *  replacement is a root commit too); `expected` is the current HEAD (which
 *  `parent` and `expected` differ for a reword amend, where the produced commit
 *  sits between). */
const commitAndAdvance = async (
  ctx: Context,
  spec: {
    readonly tree: ObjectId;
    readonly parent: ObjectId | undefined;
    /** The merged head of a recreated merge, its second parent. */
    readonly mergeParent?: ObjectId;
    readonly expected: ObjectId;
    readonly author: CommitData['author'];
    readonly message: string;
    readonly reflog: string;
    /** An amend's headers carried from the commit it replaces. */
    readonly carried?: ReadonlyArray<ExtraHeader>;
  },
): Promise<ObjectId> => {
  const committer = await resolveCurrentIdentity(ctx);
  const commit = {
    tree: spec.tree,
    parents: [spec.parent, spec.mergeParent].filter((p) => p !== undefined),
    author: spec.author,
    committer,
    message: spec.message,
  };
  const created = await createCommitWithStoredHeaders(ctx, commit, spec.carried ?? []);
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
  // Stryker disable next-line BooleanLiteral: equivalent — `planInteractive` rejects an empty reword message upfront, and a reword reached on a resume falls back to the commit's own non-empty message, so the cleaned message is never empty here.
  const message = sanitizeMessage(inst.message ?? cData.message, { allowEmpty: false });
  const produced = await produceOnto(
    ctx,
    inst,
    cData,
    head,
    rebaseRewordReflog(subjectLine(cData.message)),
  );
  if (produced.kind === 'conflict') return { kind: 'conflict', conflicts: produced.conflicts };
  return { kind: 'advanced', created: await amendMessage(ctx, produced.created, message) };
};

/** git's second reword step: amend `produced` to carry `message` (`rebase (reword): <new>`). */
const amendMessage = async (
  ctx: Context,
  produced: ObjectId,
  message: string,
): Promise<ObjectId> => {
  const producedData = await readCommitData(ctx, produced);
  return commitAndAdvance(ctx, {
    tree: producedData.tree,
    parent: producedData.parents[0],
    expected: produced,
    author: producedData.author,
    message,
    reflog: rebaseRewordReflog(subjectLine(message)),
    carried: amendedExtraHeaders(producedData.extraHeaders),
  });
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
  readonly messageFixup?: string;
  readonly mergeMsg?: string;
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
    // Stryker disable next-line ConditionalExpression: equivalent — when the field is `undefined`, forcing this to `true` spreads `{ backupHeader: undefined }`, which `writeRebaseStop`'s `if (field !== undefined)` skips exactly like the `{}` branch (byte-identical on-disk state).
    ...(ic.backupHeader !== undefined ? { backupHeader: ic.backupHeader } : {}),
    ...optionalStopFields(fields),
  });
};

/** The stop fields only some stops carry, each present only when set. */
const optionalStopFields = (fields: StopFields) => ({
  // Stryker disable next-line ConditionalExpression: equivalent — when the field is `undefined`, forcing this to `true` spreads `{ amend: undefined }`, which `writeRebaseStop` skips exactly like the `{}` branch.
  ...(fields.amend !== undefined ? { amend: fields.amend } : {}),
  // Stryker disable next-line ConditionalExpression: equivalent — when the field is `undefined`, forcing this to `true` spreads `{ currentFixups: undefined }`, which `writeRebaseStop` skips exactly like the `{}` branch.
  ...(fields.currentFixups !== undefined ? { currentFixups: fields.currentFixups } : {}),
  // Stryker disable next-line ConditionalExpression: equivalent — when the field is `undefined`, forcing this to `true` spreads `{ rewrittenPending: undefined }`, which `writeRebaseStop` skips exactly like the `{}` branch.
  ...(fields.rewrittenPending !== undefined ? { rewrittenPending: fields.rewrittenPending } : {}),
  // Stryker disable next-line ConditionalExpression: equivalent — when the field is `undefined`, forcing this to `true` spreads `{ messageSquash: undefined }`, which `writeRebaseStop` skips exactly like the `{}` branch.
  ...(fields.messageSquash !== undefined ? { messageSquash: fields.messageSquash } : {}),
  ...(fields.messageFixup !== undefined ? { messageFixup: fields.messageFixup } : {}),
  ...(fields.mergeMsg !== undefined ? { mergeMsg: fields.mergeMsg } : {}),
});

/** git keeps the group base's message in `message-fixup` until a squash joins the group. */
const fixupOnlyMessage = (
  members: ReadonlyArray<{ readonly action: 'squash' | 'fixup' }>,
  baseMessage: string,
): { readonly messageFixup?: string } =>
  members.every((member) => member.action === 'fixup') ? { messageFixup: baseMessage } : {};

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
  conflicts: toConflictList(conflicts),
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
  const message = joinMeldGroup(group, inst, cData, isLast);
  const created = await commitAndAdvance(ctx, {
    tree: outcome.mergedTree,
    parent: headData.parents[0],
    expected: head,
    author: headData.author,
    message,
    reflog: rebaseActionReflog(inst.action, subjectLine(message)),
    carried: amendedExtraHeaders(headData.extraHeaders),
  });
  return { kind: 'committed', created, message };
};

/** Add `inst` to the group and return the melded message: the template, or
 *  — on the group's last member — the cleaned final message. */
const joinMeldGroup = (
  group: MeldGroup,
  inst: PlannedInstruction,
  cData: CommitData,
  isLast: boolean,
): string => {
  group.members.push({ message: cData.message, skip: inst.action === 'fixup' });
  group.fixups.push({ action: inst.action as 'squash' | 'fixup', oid: inst.oid });
  group.pending.push(inst.oid);
  // Stryker disable next-line ConditionalExpression: equivalent — forcing the `inst.message !== undefined` guard true makes a squash with no message assign `group.inline = undefined`, leaving the already-`undefined` field unchanged. (The whole-condition `→ true` and `&&` → `||` mutants are killed by the fixup-carrying-an-inline-message test.)
  if (inst.action === 'squash' && inst.message !== undefined) group.inline = inst.message;
  const template = buildCombinedMessage([{ message: group.baseMessage }, ...group.members]);
  return isLast
    ? // Stryker disable next-line BooleanLiteral: equivalent — an empty squash inline message is rejected upfront by `planInteractive`; otherwise the template fallback retains the base commit's non-empty message, so it is never empty here.
      sanitizeMessage(group.inline ?? stripComments(template), { allowEmpty: false })
    : template;
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
  let replay: InteractiveReplay = {
    head: startHead,
    applied: [...seed.applied],
    rewritten: [...seed.rewritten],
    group: await meldGroupFrom(ctx, startHead),
  };
  for (let i = 0; i < ic.todo.length; i += 1) {
    const outcome = await replayInstruction(ctx, ic, i, replay);
    if ('stop' in outcome) return outcome.stop;
    replay = outcome.next;
  }
  await finishRebase(ctx, { ...ic, reflogAction: REBASE_REFLOG_ACTION }, replay.head);
  await firePostRewrite(ctx, replay.rewritten);
  await endRebaseState(ctx);
  return { kind: 'rebased', commits: replay.applied };
};

/** Where an interactive replay stands: HEAD, what it applied and rewrote, the open meld group. */
interface InteractiveReplay {
  readonly head: ObjectId;
  readonly applied: ReadonlyArray<RebasedCommit>;
  readonly rewritten: ReadonlyArray<readonly [ObjectId, ObjectId]>;
  readonly group: MeldGroup;
}

/** A replayed todo line either stops the rebase or hands on where the replay stands next. */
type InteractiveLineOutcome =
  | { readonly stop: RebaseResult }
  | { readonly next: InteractiveReplay };

/** One todo line under replay, with the commit it names and its rendered patch. */
interface ReplayedLine {
  readonly ic: InteractiveContext;
  readonly index: number;
  readonly inst: PlannedInstruction;
  readonly cData: CommitData;
  readonly patch: string;
}

/** A meld group opened on `base`, its message the group's `# 1st commit message`. */
const meldGroupFrom = async (ctx: Context, base: ObjectId): Promise<MeldGroup> => ({
  baseMessage: (await readCommitData(ctx, base)).message,
  members: [],
  fixups: [],
  pending: [base],
  inline: undefined,
});

/** Replay todo line `index`: the stop's result when it stops, else the replay's next state. */
const replayInstruction = async (
  ctx: Context,
  ic: InteractiveContext,
  index: number,
  replay: InteractiveReplay,
): Promise<InteractiveLineOutcome> => {
  const inst = ic.todo[index]!;
  await removeAutoMerge(ctx);
  if (inst.action === 'drop') return { next: replay };
  const cData = await readCommitData(ctx, inst.oid);
  const line: ReplayedLine = { ic, index, inst, cData, patch: await renderCommitPatch(ctx, cData) };
  if (inst.action === 'squash' || inst.action === 'fixup') return replayMeld(ctx, line, replay);
  return replayStep(ctx, line, replay);
};

const remainingAfter = (line: ReplayedLine): number => line.ic.todo.length - (line.index + 1);

/** The replay once `created` is recorded as the rewrite of `source`, HEAD advanced to it. */
const recordCreated = (
  replay: InteractiveReplay,
  source: ObjectId,
  created: ObjectId,
): InteractiveReplay => ({
  ...replay,
  head: created,
  applied: [...replay.applied, { source, created }],
  rewritten: [...replay.rewritten, [source, created]],
});

/** A squash/fixup line: meld it into the open group, or stop on its conflict. */
const replayMeld = async (
  ctx: Context,
  line: ReplayedLine,
  replay: InteractiveReplay,
): Promise<InteractiveLineOutcome> => {
  const { ic, index, inst, cData } = line;
  const isLast = !meldContinues(ic.todo, index);
  const meld = await meldGroupMember(ctx, inst, cData, replay.head, replay.group, isLast);
  if (meld.kind === 'conflict') {
    await persistInteractiveStop(ctx, ic, index, meldStopFields(line, replay));
    return { stop: conflictResult(inst.oid, meld.conflicts, remainingAfter(line)) };
  }
  return { next: recordCreated(replay, inst.oid, meld.created) };
};

/** The fields every interactive stop records: the stopped commit, its author, a message, the patch. */
const stoppedLineFields = (line: ReplayedLine, message: string) => ({
  stoppedSha: line.inst.oid,
  author: line.cData.author,
  message,
  patch: line.patch,
});

/** The stop a conflicted meld persists: the group's template so far, with the member. */
const meldStopFields = (line: ReplayedLine, replay: InteractiveReplay): StopFields => {
  const { inst, cData } = line;
  const { group } = replay;
  const template = buildCombinedMessage([
    { message: group.baseMessage },
    ...group.members,
    { message: cData.message, skip: inst.action === 'fixup' },
  ]);
  const currentFixups = [
    ...group.fixups,
    { action: inst.action as 'squash' | 'fixup', oid: inst.oid },
  ];
  return {
    ...stoppedLineFields(line, template),
    rewritten: replay.rewritten,
    amend: replay.head,
    currentFixups,
    rewrittenPending: [...group.pending],
    messageSquash: template,
    ...fixupOnlyMessage(currentFixups, group.baseMessage),
    mergeMsg: template,
  };
};

/** Any other line: step it, stopping on a conflict or an `edit`; a commit it
 *  produces opens a new meld group. */
const replayStep = async (
  ctx: Context,
  line: ReplayedLine,
  replay: InteractiveReplay,
): Promise<InteractiveLineOutcome> => {
  const { inst, cData } = line;
  const step = await stepInstruction(ctx, inst, cData, replay.head);
  if (step.kind === 'conflict') {
    return { stop: await stopOnStepConflict(ctx, line, replay, step.conflicts) };
  }
  if (step.kind === 'edit-stop')
    return { stop: await stopForEdit(ctx, line, replay, step.created) };
  const next = recordCreated(replay, inst.oid, step.created);
  await reopenMeldGroup(ctx, next.group, step.created);
  return { next };
};

const stopOnStepConflict = async (
  ctx: Context,
  line: ReplayedLine,
  replay: InteractiveReplay,
  conflicts: ReadonlyArray<MergeConflict>,
): Promise<RebaseResult> => {
  const message = conflictMergeMsg(line.cData.message, sortedRecordedPaths(conflicts));
  await persistInteractiveStop(ctx, line.ic, line.index, {
    ...stoppedLineFields(line, message),
    rewritten: replay.rewritten,
    mergeMsg: message,
  });
  return conflictResult(line.inst.oid, conflicts, remainingAfter(line));
};

const stopForEdit = async (
  ctx: Context,
  line: ReplayedLine,
  replay: InteractiveReplay,
  created: ObjectId,
): Promise<RebaseResult> => {
  await persistInteractiveStop(ctx, line.ic, line.index, {
    ...stoppedLineFields(line, line.cData.message),
    rewritten: replay.rewritten,
    amend: created,
  });
  return { kind: 'stopped', commit: line.inst.oid, remaining: remainingAfter(line) };
};

/** Reset `group` in place onto `base`: the next squash/fixup melds into it. */
const reopenMeldGroup = async (ctx: Context, group: MeldGroup, base: ObjectId): Promise<void> => {
  group.baseMessage = (await readCommitData(ctx, base)).message;
  group.members = [];
  group.fixups = [];
  group.pending = [base];
  group.inline = undefined;
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

/** The stopped line's commit: a rebase stops only on a commit-carrying line. */
const stoppedCommit = (state: RebaseState): ObjectId =>
  (state.done[state.done.length - 1] as { readonly oid: ObjectId }).oid;

/** An interactive todo's lines: tsgit's interactive instructions carry commit verbs only. */
const commitEntries = (lines: RebaseState['done']): ReadonlyArray<PlannedInstruction> =>
  lines.filter((line): line is PlannedInstruction => COMMIT_ACTIONS.has(line.action));

const COMMIT_ACTIONS: ReadonlySet<string> = new Set([
  'pick',
  'reword',
  'edit',
  'squash',
  'fixup',
  'drop',
]);

/** A rebase is interactive when any instruction carries a non-`pick` verb — a
 *  pure-pick stop resumes through the (identical) non-interactive path. An
 *  `amend` stop always carries a non-`pick` verb (`edit`/`squash`/`fixup`) in
 *  its todo, so the verb check subsumes an explicit `amend` test. */
const isInteractiveState = (state: RebaseState): boolean =>
  [...state.done, ...state.remaining].some((e) => INTERACTIVE_VERBS.has(e.action));

const INTERACTIVE_VERBS: ReadonlySet<string> = new Set([
  'reword',
  'edit',
  'squash',
  'fixup',
  'drop',
]);

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
    doneBefore: commitEntries(state.done),
    todo: commitEntries(state.remaining),
  };
  const rewritten = [...(await readRewrittenList(ctx))];
  const tree = await writeContinuedIndex(ctx);
  const currentHead = await resolveRef(ctx, HEAD);
  const resumeHead = await resumeInteractiveStop(ctx, state, tree, currentHead);
  // git's `commit_staged_changes` drops AUTO_MERGE once it commits the stop.
  if (resumeHead !== currentHead) await concludeStopCommit(ctx);
  rewritten.push([stoppedCommit(state), resumeHead]);
  return replayInteractive(ctx, ic, resumeHead, { applied: [], rewritten });
};

/** The commit that concludes a stop takes its `AUTO_MERGE` and `MERGE_MSG` with it. */
const concludeStopCommit = async (ctx: Context): Promise<void> => {
  await removeAutoMerge(ctx);
  await clearMergeMsg(ctx);
};

/** git's `commit_staged_changes`: nothing staged against HEAD → keep HEAD (the
 *  caller committed, or left the edit as is); an edit stop amends only while
 *  HEAD is still the edit'd commit; a conflict stop commits the resolution. */
const resumeInteractiveStop = async (
  ctx: Context,
  state: RebaseState,
  tree: ObjectId,
  currentHead: ObjectId,
): Promise<ObjectId> => {
  const clean = await treeMatchesCommit(ctx, tree, currentHead);
  if (state.currentFixups !== undefined && !clean) {
    return commitFixupResolution(ctx, state, tree, currentHead);
  }
  if (state.currentFixups !== undefined) await dropFixupGroup(ctx);
  if (clean) return currentHead;
  if (state.amend === undefined) {
    return commitStoppedResolution(ctx, state, tree, { head: currentHead, mergeHead: undefined });
  }
  if (state.amend !== currentHead) throw await uncommittedOnTopOfEdit(ctx, currentHead);
  return amendEditStop(ctx, state, tree, currentHead);
};

/** An edit stop still at the edit'd commit: the staged changes amend it in place. */
const amendEditStop = async (
  ctx: Context,
  state: RebaseState,
  tree: ObjectId,
  editedHead: ObjectId,
): Promise<ObjectId> => {
  const amendCommit = await readCommitData(ctx, editedHead);
  return commitAndAdvance(ctx, {
    tree,
    parent: amendCommit.parents[0],
    expected: editedHead,
    author: state.author,
    message: amendCommit.message,
    reflog: rebaseContinueReflog(subjectLine(amendCommit.message)),
    carried: amendedExtraHeaders(amendCommit.extraHeaders),
  });
};

/** Changes staged on top of a commit the caller made at an edit stop: git
 *  refuses to fold them into either commit. */
const uncommittedOnTopOfEdit = async (ctx: Context, head: ObjectId): Promise<TsgitError> => {
  const headTree = (await readCommitData(ctx, head)).tree;
  return workingTreeDirty({ localChanges: await stagedChangePaths(ctx, headTree), untracked: [] });
};

/** A squash/fixup meld conflicted: commit the resolution as the group commit
 *  (replacing the base — its parent), with the cleaned combined message. */
const commitFixupResolution = async (
  ctx: Context,
  state: RebaseState,
  tree: ObjectId,
  currentHead: ObjectId,
): Promise<ObjectId> => {
  const baseData = await readCommitData(ctx, currentHead);
  // Stryker disable next-line BooleanLiteral: equivalent — `state.message` is the stopped commit's (non-empty) message persisted at the stop, so the cleaned result is never empty here and the empty-message guard never fires.
  const message = sanitizeMessage(stripComments(state.message), { allowEmpty: false });
  return commitAndAdvance(ctx, {
    tree,
    parent: baseData.parents[0],
    expected: currentHead,
    author: baseData.author,
    message,
    reflog: rebaseContinueReflog(subjectLine(message)),
    carried: amendedExtraHeaders(baseData.extraHeaders),
  });
};

/** A squash/fixup conflict stop also carries `amend` (the group commit), but
 *  only an `edit` stop committed the stopped commit itself. */
const isEditStop = (state: RebaseState): state is RebaseState & { readonly amend: ObjectId } =>
  state.amend !== undefined && state.currentFixups === undefined;

/** git's skip is `reset --hard HEAD` then continue: an edit stop's commit is
 *  already made, so it stays and the remaining todo replays on top of it; a
 *  conflict stop never committed, so HEAD already sits at the last good pick. */
const rebaseSkipInteractive = async (ctx: Context, state: RebaseState): Promise<RebaseResult> => {
  const target = await resolveRef(ctx, HEAD);
  await protectedResetWorktreeToCommit(ctx, target);
  if (isEditStop(state)) return rebaseContinueInteractive(ctx, state);
  const ic: InteractiveContext = {
    branch: branchOf(state.headName),
    onto: state.onto,
    origHead: state.origHead,
    doneBefore: commitEntries(state.done),
    todo: commitEntries(state.remaining),
  };
  return replayInteractive(ctx, ic, target, {
    applied: [],
    rewritten: await readRewrittenList(ctx),
  });
};
