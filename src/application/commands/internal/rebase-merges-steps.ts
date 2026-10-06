/**
 * The `--rebase-merges` todo verbs as git's sequencer runs them: `label` names
 * HEAD `refs/rewritten/<label>` (deleted when the rebase ends), `reset` moves
 * HEAD and the work tree to a label, and `merge -C` recreates a merge — a
 * fast-forward when nothing under it changed, else a merge of HEAD with the
 * label committed with the original's message and author.
 */
import { workingTreeDirty } from '../../../domain/commands/error.js';
import { unsupportedOperation } from '../../../domain/error.js';
import { type MergeConflict, type MergeLabels, mergeLabels } from '../../../domain/merge/index.js';
import type { CommitData } from '../../../domain/objects/commit.js';
import { subjectLine } from '../../../domain/objects/commit-message.js';
import { type ObjectId, RefName } from '../../../domain/objects/index.js';
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
import { mergeBasesOf } from '../../primitives/merge-base.js';
import { readIndex } from '../../primitives/read-index.js';
import { getRefStore } from '../../primitives/ref-store.js';
import { resolveRef } from '../../primitives/resolve-ref.js';
import { resolveCommitIsh } from './commit-ish.js';
import { resolveCurrentIdentity } from './current-identity.js';
import { treeOf } from './history-rewrite.js';
import { acquireIndexLock } from './index-update.js';
import { writeMergeMode, writeMergeMsg } from './merge-state.js';
import { hardResetWorktreeToCommit } from './reset-worktree.js';

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
  await getRefStore(ctx).applyRefUpdates([
    {
      kind: 'set',
      name: rewrittenRef(label),
      id: head,
      reflog: { oldId: head, newId: head, message: `rebase (label) '${label}'` },
    },
  ]);
};

/** Move the detached HEAD to `target` with `message`, the index and work tree following. */
const moveHead = async (ctx: Context, target: ObjectId, message: string): Promise<void> => {
  const from = await resolveRef(ctx, HEAD);
  await hardResetWorktreeToCommit(ctx, target);
  // git's ref transaction leaves an unchanged ref, and its reflog, alone.
  if (from === target) return;
  await getRefStore(ctx).applyRefUpdates([
    { kind: 'set', name: HEAD, id: target, reflog: { oldId: from, newId: target, message } },
  ]);
};

/** git's `do_reset`. */
export const resetToLabel = async (
  ctx: Context,
  label: string,
  reflogAction: string,
): Promise<ObjectId> => {
  const { id } = await lookupLabel(ctx, label);
  await moveHead(ctx, id, rebaseResetReflog(label, reflogAction));
  return id;
};

/** git's `fast_forward_to` from a rebase: HEAD moves to a kept commit. */
export const fastForwardHead = (
  ctx: Context,
  target: ObjectId,
  reflogAction = REBASE_REFLOG_ACTION,
): Promise<void> => moveHead(ctx, target, rebaseFastForwardReflog(reflogAction));

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
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> };

/** A three-way merge into the index and work tree under the index lock; nothing is committed. */
export const mergeTreesUnderLock = async (
  ctx: Context,
  input: MergeTreesInput,
): Promise<MergeTreesOutcome> => {
  const oursTree = await treeOf(ctx, input.ours);
  const lock = await acquireIndexLock(ctx);
  try {
    const res = await applyMergeToWorktree(ctx, {
      baseTree: input.baseTree,
      oursTree,
      theirsTree: input.theirsTree,
      currentIndex: await readIndex(ctx),
      labels: input.labels,
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
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> };

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
    await fastForwardHead(ctx, step.source, step.reflogAction);
    return { kind: 'committed', id: step.source };
  }
  const [base] = await mergeBasesOf(ctx, [step.head, theirs.id]);
  if (base === theirs.id) return { kind: 'kept' };
  const merged = await mergeTreesUnderLock(ctx, {
    baseTree: base !== undefined ? await treeOf(ctx, base) : undefined,
    ours: step.head,
    theirsTree: await treeOf(ctx, theirs.id),
    labels: mergeLabels(theirs.name, base),
  });
  if (merged.kind === 'conflict') {
    // git's `do_merge` writes MERGE_HEAD without a line feed, and MERGE_MSG verbatim.
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, theirs.id);
    await writeMergeMode(ctx, 'never');
    await writeMergeMsg(ctx, step.original.message);
    return merged;
  }
  return { kind: 'committed', id: await commitMerge(ctx, step, merged.mergedTree, theirs.id) };
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
  await getRefStore(ctx).applyRefUpdates([
    {
      kind: 'set',
      name: HEAD,
      id,
      expected: step.head,
      reflog: {
        oldId: step.head,
        newId: id,
        message: rebaseMergeReflog(subjectLine(step.original.message), step.reflogAction),
      },
    },
  ]);
  return id;
};
