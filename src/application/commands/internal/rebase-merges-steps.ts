/**
 * The `--rebase-merges` todo verbs as git's sequencer runs them: `label` names
 * HEAD `refs/rewritten/<label>` (deleted when the rebase ends), `reset` moves
 * HEAD and the work tree to a label, and `merge -C` recreates a merge — a
 * fast-forward when nothing under it changed, else a merge of HEAD with the
 * label committed with the original's message and author.
 */
import { unsupportedOperation } from '../../../domain/error.js';
import { type MergeConflict, type MergeLabels, mergeLabels } from '../../../domain/merge/index.js';
import type { CommitData } from '../../../domain/objects/commit.js';
import { subjectLine } from '../../../domain/objects/commit-message.js';
import { type ObjectId, RefName, zeroOid } from '../../../domain/objects/index.js';
import type { RebaseTodoLine } from '../../../domain/rebase/index.js';
import {
  REBASE_REFLOG_ACTION,
  rebaseFastForwardReflog,
  rebaseMergeReflog,
  rebaseResetReflog,
} from '../../../domain/reflog/reflog-messages.js';
import type { Context } from '../../../ports/context.js';
import { applyMergeToWorktree } from '../../primitives/apply-merge-to-worktree.js';
import { createCommit } from '../../primitives/create-commit.js';
import { acquireIndexLock, type IndexLock } from '../../primitives/internal/index-lock.js';
import { mergeBasesOf } from '../../primitives/merge-base.js';
import { readIndex } from '../../primitives/read-index.js';
import { getRefStore } from '../../primitives/ref-store.js';
import { resolveRef } from '../../primitives/resolve-ref.js';
import { resolveCommitIsh } from './commit-ish.js';
import { resolveCurrentIdentity } from './current-identity.js';
import { treeOf } from './history-rewrite.js';
import { writeMergeMode, writeMergeMsg } from './merge-state.js';
import {
  attemptProtectedResetWorktreeToCommit,
  type ResetOutcome,
  type WorktreeRefusal,
} from './reset-worktree.js';

const HEAD = 'HEAD' as RefName;
const REWRITTEN_PREFIX = 'refs/rewritten/';

const rewrittenRef = (label: string): RefName => RefName.from(`${REWRITTEN_PREFIX}${label}`);

/** git's `lookup_label`: `refs/rewritten/<label>`, else the label read as a commit-ish. */
const lookupLabel = async (
  ctx: Context,
  label: string,
): Promise<{ readonly id: ObjectId; readonly name: string }> => {
  const ref = rewrittenRef(label);
  const value = await getRefStore(ctx).resolveDirect(ref);
  if (value.kind === 'direct') return { id: value.id, name: ref };
  return { id: await resolveCommitIsh(ctx, label), name: label };
};

/** git's `do_label`. */
export const labelHead = async (ctx: Context, label: string): Promise<void> => {
  const head = await resolveRef(ctx, HEAD);
  const name = rewrittenRef(label);
  const refs = getRefStore(ctx);
  const previous = await refs.resolveDirect(name);
  const oldId = previous.kind === 'direct' ? previous.id : zeroOid(ctx.hashConfig);
  await refs.applyRefUpdates([
    {
      kind: 'set',
      name,
      id: head,
      reflog: { oldId, newId: head, message: `rebase (label) '${label}'` },
    },
  ]);
};

/** Move the detached HEAD to `target` with `message`, the index and work tree following. */
const moveHead = async (ctx: Context, target: ObjectId, message: string): Promise<ResetOutcome> => {
  const from = await resolveRef(ctx, HEAD);
  const outcome = await attemptProtectedResetWorktreeToCommit(ctx, target);
  if (outcome.kind === 'refused') return outcome;
  // git's ref transaction leaves an unchanged ref, and its reflog, alone.
  if (from !== target) {
    await getRefStore(ctx).applyRefUpdates([
      { kind: 'set', name: HEAD, id: target, reflog: { oldId: from, newId: target, message } },
    ]);
  }
  return outcome;
};

/** git's `do_reset`; a refusal leaves HEAD where it was. */
export const resetToLabel = async (
  ctx: Context,
  label: string,
  reflogAction: string,
): Promise<{ readonly kind: 'moved'; readonly head: ObjectId } | WorktreeRefusal> => {
  const { id } = await lookupLabel(ctx, label);
  const outcome = await moveHead(ctx, id, rebaseResetReflog(label, reflogAction));
  return outcome.kind === 'refused' ? outcome : { kind: 'moved', head: id };
};

export type FastForwardOutcome = { readonly kind: 'moved' } | WorktreeRefusal;

/** git's `fast_forward_to` from a rebase: HEAD moves to a kept commit, unless an occupant refuses. */
export const fastForwardHead = async (
  ctx: Context,
  target: ObjectId,
  reflogAction = REBASE_REFLOG_ACTION,
): Promise<FastForwardOutcome> => {
  const outcome = await moveHead(ctx, target, rebaseFastForwardReflog(reflogAction));
  return outcome.kind === 'refused' ? outcome : { kind: 'moved' };
};

/** Every `refs/rewritten/` label the executed lines created, deleted as the rebase ends. */
export const deleteRewrittenRefs = async (
  ctx: Context,
  lines: ReadonlyArray<RebaseTodoLine>,
): Promise<void> => {
  const refs = getRefStore(ctx);
  for (const line of lines) {
    if (line.action !== 'label') continue;
    const name = rewrittenRef(line.label);
    if ((await refs.resolveDirect(name)).kind !== 'missing') {
      await refs.applyRefUpdates([{ kind: 'delete', name }]);
    }
  }
};

export interface MergeTreesInput {
  readonly baseTree: ObjectId | undefined;
  readonly ours: ObjectId;
  readonly theirsTree: ObjectId;
  readonly labels: MergeLabels;
}

export type MergeTreesOutcome =
  | { readonly kind: 'clean'; readonly mergedTree: ObjectId; readonly oursTree: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
  | WorktreeRefusal;

/** A three-way merge into the index and work tree under the index lock; nothing is committed. */
export const mergeTreesUnderLock = async (
  ctx: Context,
  input: MergeTreesInput,
): Promise<MergeTreesOutcome> => {
  const oursTree = await treeOf(ctx, input.ours);
  const lock = await acquireIndexLock(ctx);
  try {
    return await mergeIntoLockedIndex(ctx, lock, input, oursTree);
  } finally {
    await lock.release();
  }
};

/** Merge into the work tree and commit the result to the locked index. */
const mergeIntoLockedIndex = async (
  ctx: Context,
  lock: IndexLock,
  input: MergeTreesInput,
  oursTree: ObjectId,
): Promise<MergeTreesOutcome> => {
  const res = await applyMergeToWorktree(ctx, {
    baseTree: input.baseTree,
    oursTree,
    theirsTree: input.theirsTree,
    currentIndex: await readIndex(ctx),
    labels: input.labels,
  });
  if (res.kind === 'would-overwrite') {
    return { kind: 'refused', localChanges: res.localChanges, untracked: res.untracked };
  }
  if (res.kind === 'conflict') {
    await lock.commit(res.indexEntries, 'replace');
    return { kind: 'conflict', conflicts: res.conflicts };
  }
  await lock.commit(res.result.newIndexEntries, 'replace');
  // git commits the index, which keeps what it staged on paths the merge left alone.
  return { kind: 'clean', mergedTree: res.indexTree, oursTree };
};

export interface MergeStep {
  readonly source: ObjectId;
  readonly original: CommitData;
  readonly labels: ReadonlyArray<string>;
  readonly head: ObjectId;
  readonly reflogAction: string;
}

export type MergeStepOutcome =
  | { readonly kind: 'committed'; readonly id: ObjectId }
  | { readonly kind: 'kept' }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
  | WorktreeRefusal;

/** git's `can_fast_forward` for `merge -C`: HEAD and every merged label are the original's parents. */
const keepsOriginalParents = (step: MergeStep, merged: ReadonlyArray<ObjectId>): boolean => {
  const parents = [step.head, ...merged];
  const original = step.original.parents;
  return original.length === parents.length && original.every((p, i) => p === parents[i]);
};

/** git's `do_merge` for one merged label. */
export const recreateMerge = async (ctx: Context, step: MergeStep): Promise<MergeStepOutcome> => {
  const [label, ...octopus] = step.labels;
  if (octopus.length > 0) {
    throw unsupportedOperation('rebase --rebase-merges', 'an octopus merge is not recreated');
  }
  const theirs = await lookupLabel(ctx, label!);
  if (keepsOriginalParents(step, [theirs.id])) {
    const moved = await fastForwardHead(ctx, step.source, step.reflogAction);
    return moved.kind === 'refused' ? moved : { kind: 'committed', id: step.source };
  }
  const [base] = await mergeBasesOf(ctx, [step.head, theirs.id]);
  if (base === theirs.id) return { kind: 'kept' };
  const merged = await mergeLabelInto(ctx, step.head, theirs, base);
  if (merged.kind === 'refused') return merged;
  if (merged.kind === 'conflict') {
    await persistMergeStop(ctx, theirs.id, step.original.message);
    return merged;
  }
  return { kind: 'committed', id: await commitMerge(ctx, step, merged.mergedTree, theirs.id) };
};

/** Merge the labelled commit `theirs` into `head` over their merge base. */
const mergeLabelInto = async (
  ctx: Context,
  head: ObjectId,
  theirs: { readonly id: ObjectId; readonly name: string },
  base: ObjectId | undefined,
): Promise<MergeTreesOutcome> =>
  mergeTreesUnderLock(ctx, {
    baseTree: base !== undefined ? await treeOf(ctx, base) : undefined,
    ours: head,
    theirsTree: await treeOf(ctx, theirs.id),
    labels: mergeLabels(theirs.name, base),
  });

/** git's `do_merge` writes MERGE_HEAD without a line feed, and MERGE_MSG verbatim. */
const persistMergeStop = async (ctx: Context, theirs: ObjectId, message: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, theirs);
  await writeMergeMode(ctx, 'never');
  await writeMergeMsg(ctx, message);
};

const commitMerge = async (
  ctx: Context,
  step: MergeStep,
  tree: ObjectId,
  theirs: ObjectId,
): Promise<ObjectId> => {
  const id = await createCommit(ctx, {
    tree,
    parents: [step.head, theirs],
    author: step.original.author,
    committer: await resolveCurrentIdentity(ctx),
    message: step.original.message,
    extraHeaders: [],
  });
  await advanceHeadToMerge(ctx, step, id);
  return id;
};

/** Move HEAD from the step's head to the recreated merge, `rebase (merge)`. */
const advanceHeadToMerge = async (ctx: Context, step: MergeStep, id: ObjectId): Promise<void> => {
  const message = rebaseMergeReflog(subjectLine(step.original.message), step.reflogAction);
  await getRefStore(ctx).applyRefUpdates([
    {
      kind: 'set',
      name: HEAD,
      id,
      expected: step.head,
      reflog: { oldId: step.head, newId: id, message },
    },
  ]);
};
