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
import { renderPatch } from '../../domain/diff/index.js';
import { TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { unsupportedOperation } from '../../domain/index.js';
import type { ConflictType, MergeConflict } from '../../domain/merge/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { FilePath, ObjectId, RefName } from '../../domain/objects/index.js';
import type { RebaseBackupHeader, RebaseTodoAction } from '../../domain/rebase/index.js';
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
import { computePatchId } from '../primitives/patch-id.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { recordRefUpdate } from '../primitives/record-ref-update.js';
import { getRefStore } from '../primitives/ref-store.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { synthesizeTreeFromIndex } from '../primitives/synthesize-tree-from-index.js';
import { updateRef } from '../primitives/update-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { writeSymbolicRef } from '../primitives/write-symbolic-ref.js';
import { conflictMergeMsg } from './internal/cherry-pick-state.js';
import { assertCleanWorkTree } from './internal/clean-work-tree.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { sanitizeMessage, stripComments } from './internal/commit-message.js';
import { resolveCurrentIdentity } from './internal/current-identity.js';
import { acquireIndexLock } from './internal/index-update.js';
import { writeOrigHead } from './internal/merge-state.js';
import {
  clearRebaseState,
  type RebaseStop,
  readRebaseState,
  readRewrittenList,
  writeRebaseStop,
} from './internal/rebase-state.js';
import { hardResetWorktreeToCommit } from './internal/reset-worktree.js';

const HEAD = 'HEAD' as RefName;

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
  base: ObjectId,
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
      subject: subjectOf((await readCommitData(ctx, oid)).message),
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
  await recordRefUpdate(ctx, HEAD, fromHead, onto, `rebase (start): checkout ${ontoName}`);
  await hardResetWorktreeToCommit(ctx, onto);
};

/** Apply one commit onto the detached HEAD `ourId`; commit it when the merge is clean. */
const replayOne = async (
  ctx: Context,
  cData: CommitData,
  ourId: ObjectId,
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
      reflogMessage: `rebase (pick): ${subjectOf(cData.message)}`,
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
    message: conflictMergeMsg(
      cData.message,
      conflicts.map((c) => c.path),
    ),
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
    reflogMessage: `rebase (finish): ${branch} onto ${onto}`,
  });
  await writeSymbolicRef(ctx, HEAD, branch);
  await recordRefUpdate(ctx, HEAD, newTip, newTip, `rebase (finish): returning to ${branch}`);
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
    const outcome = await replayOne(ctx, cData, cur);
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
  await clearRebaseState(ctx);
  return { kind: 'rebased', commits: applied };
};

export const rebaseRun = async (ctx: Context, input: RebaseRunInput): Promise<RebaseResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'rebase');
  await assertNoPendingOperation(ctx);
  const head = await readHeadRaw(ctx);
  const headCommit = head.kind === 'symbolic' ? await resolveHeadCommit(ctx, head.target) : head.id;
  const branch = head.kind === 'symbolic' ? head.target : undefined;
  const upstream = await resolveCommitIsh(ctx, input.upstream);
  const onto = input.onto !== undefined ? await resolveCommitIsh(ctx, input.onto) : upstream;
  const ontoName = input.onto ?? input.upstream;
  await assertCleanWorkTree(ctx, await treeOf(ctx, headCommit));
  const [base] = await mergeBase(ctx, [upstream, headCommit]);
  if (base === undefined) {
    throw unsupportedOperation('rebase', 'no common ancestor between HEAD and upstream');
  }
  if (input.interactive !== undefined) {
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
  if (onto === base) return { kind: 'up-to-date' };
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
  await assertRepository(ctx);
  await assertNotBare(ctx, 'rebase --continue');
  const state = await readRebaseState(ctx);
  if (state === undefined) throw noOperationInProgress('rebase');
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
    reflogMessage: `rebase (continue): ${subjectOf(message)}`,
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
  await assertRepository(ctx);
  await assertNotBare(ctx, 'rebase --skip');
  const state = await readRebaseState(ctx);
  if (state === undefined) throw noOperationInProgress('rebase');
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
  await assertRepository(ctx);
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
    await recordRefUpdate(
      ctx,
      HEAD,
      currentHead,
      state.origHead,
      `rebase (abort): returning to ${branch}`,
    );
  } else {
    await getRefStore(ctx).writeLoose(HEAD, state.origHead);
    await recordRefUpdate(
      ctx,
      HEAD,
      currentHead,
      state.origHead,
      `rebase (abort): returning to ${state.origHead}`,
    );
  }
  await clearRebaseState(ctx);
  return { head: state.origHead, headName: state.headName };
};

// ── interactive (`rebase -i`) ───────────────────────────────────────────────

/** Verbs the interactive engine currently implements. */
const INTERACTIVE_SUPPORTED: ReadonlySet<RebaseTodoAction> = new Set<RebaseTodoAction>([
  'pick',
  'reword',
  'drop',
]);

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
  readonly base: ObjectId;
}

/**
 * Resolve + validate the supplied todo against the `base..head` candidate set,
 * surfacing git's refusals before any state change: nothing-to-do (empty or
 * all-drop), an unsupported verb, and an oid outside the replayed range.
 */
const planInteractive = async (
  ctx: Context,
  instructions: ReadonlyArray<RebaseInstruction>,
  base: ObjectId,
  head: ObjectId,
): Promise<ReadonlyArray<PlannedInstruction>> => {
  if (instructions.every((i) => i.action === 'drop')) {
    throw invalidOption('interactive', 'nothing to do (every instruction drops a commit)');
  }
  const candidates = new Set(await commitsToReplay(ctx, base, head));
  const planned: PlannedInstruction[] = [];
  for (const inst of instructions) {
    if (!INTERACTIVE_SUPPORTED.has(inst.action)) {
      throw invalidOption('interactive', `'${inst.action}' is not yet supported`);
    }
    if (inst.action === 'reword' && inst.message === undefined) {
      throw invalidOption('interactive', 'reword requires a message (no editor in a library)');
    }
    const oid = await resolveCommitIsh(ctx, inst.oid);
    if (!candidates.has(oid)) {
      throw invalidOption(
        'interactive',
        `commit ${oid} is not in the list of commits to be rebased`,
      );
    }
    const subject = subjectOf((await readCommitData(ctx, oid)).message);
    planned.push({
      action: inst.action,
      oid,
      subject,
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
  await recordRefUpdate(ctx, HEAD, fromHead, foldedHead, `rebase (start): checkout ${ontoName}`);
  await hardResetWorktreeToCommit(ctx, foldedHead);
};

/** Apply commit `C`'s diff onto the detached HEAD `ourId` as a 3-way merge,
 *  WITHOUT committing — the verb decides what to commit. */
const applyOnto = async (
  ctx: Context,
  cData: CommitData,
  ourId: ObjectId,
): Promise<
  | { readonly kind: 'clean'; readonly mergedTree: ObjectId }
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
    });
    if (res.kind === 'would-overwrite') throw workingTreeDirty(res.paths);
    if (res.kind === 'conflict') {
      await lock.commit(res.indexEntries);
      return { kind: 'conflict', conflicts: res.conflicts };
    }
    await lock.commit(res.result.newIndexEntries);
    return { kind: 'clean', mergedTree: res.mergedTree };
  } finally {
    await lock.release();
  }
};

/** Fast-forward the detached HEAD onto `target` (kept verbatim — its first parent
 *  is the current HEAD), recording git's `rebase: fast-forward`. */
const fastForwardOnto = async (ctx: Context, target: ObjectId): Promise<void> => {
  const from = await resolveRef(ctx, HEAD);
  await getRefStore(ctx).writeLoose(HEAD, target);
  await recordRefUpdate(ctx, HEAD, from, target, 'rebase: fast-forward');
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

/** One processed instruction's outcome. `created` is the final replayed oid. */
type Step =
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
  | { readonly kind: 'advanced'; readonly created: ObjectId };

/**
 * `reword`: produce the commit (fast-forward when its parent is HEAD, else a
 * 3-way cherry-pick labelled `rebase (reword): <orig>`), then amend its message
 * to the supplied one (`rebase (reword): <new>`) — git's two-step reword.
 */
const stepReword = async (
  ctx: Context,
  inst: PlannedInstruction,
  cData: CommitData,
  head: ObjectId,
): Promise<Step> => {
  const message = sanitizeMessage(inst.message as string, { allowEmpty: false });
  const rewordReflog = `rebase (reword): ${subjectOf(message)}`;
  if (cData.parents[0] === head) {
    await fastForwardOnto(ctx, inst.oid);
    const created = await commitAndAdvance(ctx, {
      tree: cData.tree,
      parent: head,
      expected: inst.oid,
      author: cData.author,
      message,
      reflog: rewordReflog,
    });
    return { kind: 'advanced', created };
  }
  const outcome = await applyOnto(ctx, cData, head);
  if (outcome.kind === 'conflict') return { kind: 'conflict', conflicts: outcome.conflicts };
  const produced = await commitAndAdvance(ctx, {
    tree: outcome.mergedTree,
    parent: head,
    expected: head,
    author: cData.author,
    message: cData.message,
    reflog: `rebase (reword): ${subjectOf(cData.message)}`,
  });
  const created = await commitAndAdvance(ctx, {
    tree: outcome.mergedTree,
    parent: head,
    expected: produced,
    author: cData.author,
    message,
    reflog: rewordReflog,
  });
  return { kind: 'advanced', created };
};

/** `pick`: a 3-way cherry-pick onto HEAD (in the loop a pick never fast-forwards
 *  — the maximal leading fold already absorbed any pick that could). */
const stepPick = async (ctx: Context, cData: CommitData, head: ObjectId): Promise<Step> => {
  const outcome = await applyOnto(ctx, cData, head);
  if (outcome.kind === 'conflict') return { kind: 'conflict', conflicts: outcome.conflicts };
  const created = await commitAndAdvance(ctx, {
    tree: outcome.mergedTree,
    parent: head,
    expected: head,
    author: cData.author,
    message: cData.message,
    reflog: `rebase (pick): ${subjectOf(cData.message)}`,
  });
  return { kind: 'advanced', created };
};

interface InteractiveContext {
  readonly branch: RefName | undefined;
  readonly onto: ObjectId;
  readonly origHead: ObjectId;
  readonly todo: ReadonlyArray<PlannedInstruction>;
  readonly backupHeader: RebaseBackupHeader;
}

/** Persist a byte-faithful interactive conflict stop. `done` is everything up to
 *  and including the stopped instruction; `remaining` is the rest. */
const persistInteractiveStop = async (
  ctx: Context,
  ic: InteractiveContext,
  stopIndex: number,
  cData: CommitData,
  conflicts: ReadonlyArray<MergeConflict>,
  rewritten: ReadonlyArray<readonly [ObjectId, ObjectId]>,
): Promise<void> => {
  const stop: RebaseStop = {
    headName: ic.branch ?? 'detached HEAD',
    onto: ic.onto,
    origHead: ic.origHead,
    done: ic.todo.slice(0, stopIndex + 1),
    remaining: ic.todo.slice(stopIndex + 1),
    stoppedSha: ic.todo[stopIndex]!.oid,
    stoppedAuthor: cData.author,
    message: conflictMergeMsg(
      cData.message,
      conflicts.map((c) => c.path),
    ),
    rewritten,
    patch: await renderCommitPatch(ctx, cData),
    backupHeader: ic.backupHeader,
  };
  await writeRebaseStop(ctx, stop);
};

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

/** Replay the interactive todo from `startHead` (the folded position), threading
 *  the detached HEAD. Stops on the first conflict; otherwise finishes. */
const replayInteractive = async (
  ctx: Context,
  ic: InteractiveContext,
  startHead: ObjectId,
  foldCount: number,
): Promise<RebaseResult> => {
  let head = startHead;
  const applied: RebasedCommit[] = ic.todo
    .slice(0, foldCount)
    .map((t) => ({ source: t.oid, created: t.oid }));
  const rewritten: Array<readonly [ObjectId, ObjectId]> = [];
  for (let i = foldCount; i < ic.todo.length; i += 1) {
    const inst = ic.todo[i]!;
    if (inst.action === 'drop') continue;
    const cData = await readCommitData(ctx, inst.oid);
    const step =
      inst.action === 'reword'
        ? await stepReword(ctx, inst, cData, head)
        : await stepPick(ctx, cData, head);
    if (step.kind === 'conflict') {
      await persistInteractiveStop(ctx, ic, i, cData, step.conflicts, rewritten);
      return conflictResult(inst.oid, step.conflicts, ic.todo.length - (i + 1));
    }
    applied.push({ source: inst.oid, created: step.created });
    rewritten.push([inst.oid, step.created]);
    head = step.created;
  }
  await finishRebase(ctx, ic.branch, ic.origHead, head, ic.onto);
  await clearRebaseState(ctx);
  return { kind: 'rebased', commits: applied };
};

const rebaseRunInteractive = async (ctx: Context, plan: InteractivePlan): Promise<RebaseResult> => {
  const todo = await planInteractive(ctx, plan.instructions, plan.base, plan.headCommit);
  const foldCount = await leadingFold(ctx, todo, plan.onto);
  const foldedHead = foldCount > 0 ? todo[foldCount - 1]!.oid : plan.onto;
  await writeOrigHead(ctx, plan.headCommit);
  await detachInteractive(ctx, plan.headCommit, plan.ontoName, foldedHead);
  const ic: InteractiveContext = {
    branch: plan.branch,
    onto: plan.onto,
    origHead: plan.headCommit,
    todo,
    backupHeader: {
      shortUpstream: shortOid(plan.upstream),
      shortOrigHead: shortOid(plan.headCommit),
      shortOnto: shortOid(plan.onto),
    },
  };
  return replayInteractive(ctx, ic, foldedHead, foldCount);
};
