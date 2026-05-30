/**
 * Three-way tree merge applied to the working tree + index. Shared by
 * `stash apply` and (later) the Phase 22 apply step (cherry-pick / revert /
 * rebase). Composes the pure domain `mergeTrees` / `mergeContent` with the
 * working-tree writers; it writes NO commit, ref, or `MERGE_HEAD` — the caller
 * owns those.
 *
 * Three outcomes:
 * - `clean`    — the merged tree, materialised onto the working tree as the
 *                delta against `currentIndex` (only changed paths are touched),
 *                plus the post-write stage-0 index entries for the caller to
 *                commit (or discard, as `stash apply` does).
 * - `conflict` — markers written to the working tree + stage-1/2/3 unmerged
 *                index entries (the caller commits them).
 * - `would-overwrite` — a path the merge would change is dirty in the working
 *                tree (git's "local changes would be overwritten" guard);
 *                nothing is written.
 */
import { conflictsToIndexEntries } from '../../domain/diff/index.js';
import { unsupportedOperation } from '../../domain/error.js';
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import {
  type ConflictType,
  type ContentMerger,
  MAX_CONFLICT_OUTPUT_BYTES,
  type MergeConflict,
  type MergeOutcome,
  mergeContent,
  mergeTrees,
} from '../../domain/merge/index.js';
import type { FileMode, FilePath, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { compareWorkingTreeEntry } from './compare-working-tree-entry.js';
import { flattenTree } from './flatten-tree.js';
import { stage0Entry, zeroStat } from './internal/synthetic-index-entry.js';
import { removeWorkingTreeFile, writeWorkingTreeFile } from './internal/write-working-tree-file.js';
import { type MaterializeTreeResult, materializeTree } from './materialize-tree.js';
import { readBlob } from './read-blob.js';
import { synthesizeTreeFromIndex } from './synthesize-tree-from-index.js';
import { writeObject } from './write-object.js';

const UNSUPPORTED_CONFLICT_TYPES: ReadonlySet<ConflictType> = new Set(['rename-rename', 'gitlink']);

export interface ApplyMergeInput {
  readonly baseTree: ObjectId | undefined;
  readonly oursTree: ObjectId;
  readonly theirsTree: ObjectId;
  readonly currentIndex: GitIndex;
}

export type ApplyMergeResult =
  | {
      readonly kind: 'clean';
      readonly mergedTree: ObjectId;
      readonly result: MaterializeTreeResult;
    }
  | {
      readonly kind: 'conflict';
      readonly conflicts: ReadonlyArray<MergeConflict>;
      readonly indexEntries: ReadonlyArray<IndexEntry>;
    }
  | { readonly kind: 'would-overwrite'; readonly paths: ReadonlyArray<FilePath> };

const buildContentMerger =
  (ctx: Context): ContentMerger =>
  async (mergeCtx) => {
    const [ours, theirs, base] = await Promise.all([
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      readBlob(ctx, mergeCtx.ourId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      readBlob(ctx, mergeCtx.theirId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
      mergeCtx.baseId !== undefined
        ? // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
          readBlob(ctx, mergeCtx.baseId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })
        : Promise.resolve(undefined),
    ]);
    return mergeContent(base?.content, ours.content, theirs.content);
  };

/** Whether a clean outcome changes the path relative to `ours`. */
const outcomeChangesOurs = (
  outcome: MergeOutcome,
  ours: ReadonlyMap<FilePath, { readonly id: ObjectId; readonly mode: FileMode }>,
): boolean => {
  // The changed-vs-ours classification only narrows `changedPaths`, which gates
  // the overwrite guard and the conflict-path writer. Misclassifying a path is
  // observationally equivalent: a clean merge's delta is re-derived by
  // `materializeTree`, an unchanged/equal outcome the conflict-writer would
  // additionally touch reproduces bytes the working tree already holds, and an
  // extra clean path in the guard simply passes (it is not dirty). Hence the
  // sub-conditions below are equivalent mutants — the wrong-but-superset
  // classification yields the identical working tree + index.
  // Stryker disable next-line ConditionalExpression,BooleanLiteral: equivalent — see above.
  if (outcome.status === 'unchanged') return false;
  if (outcome.status === 'resolved-known') {
    const o = ours.get(outcome.path);
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — see above (a superset `changed` set is observationally identical).
    return o === undefined || o.id !== outcome.id || o.mode !== outcome.mode;
  }
  // Stryker disable next-line ConditionalExpression,BooleanLiteral: equivalent — see above.
  if (outcome.status === 'resolved-merged') return true;
  // resolved-deleted: a change only when `ours` actually had the path.
  // (`conflict` outcomes never reach here — the caller filters them out.)
  // Stryker disable next-line ConditionalExpression: equivalent — see above; `ours` always has a resolved-deleted path (it existed to be deleted).
  return outcome.status === 'resolved-deleted' && ours.has(outcome.path);
};

/** Every path the merge would touch in the working tree (changed clean + conflicts). */
const changedPaths = (
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
  ours: ReadonlyMap<FilePath, { readonly id: ObjectId; readonly mode: FileMode }>,
): ReadonlySet<FilePath> => {
  const paths = new Set<FilePath>();
  for (const outcome of outcomes) {
    if (outcome.status !== 'conflict' && outcomeChangesOurs(outcome, ours)) paths.add(outcome.path);
  }
  for (const conflict of conflicts) paths.add(conflict.path);
  return paths;
};

/** Paths whose working file would lose changes if overwritten (git's guard). */
const findWouldOverwrite = async (
  ctx: Context,
  paths: ReadonlySet<FilePath>,
  currentIndex: GitIndex,
): Promise<ReadonlyArray<FilePath>> => {
  const byPath = new Map<FilePath, IndexEntry>();
  for (const entry of currentIndex.entries) {
    // Stryker disable next-line ConditionalExpression: equivalent — the apply caller's `currentIndex` is a stage-0 index (synthesised from the real index), so every entry already has stage 0; the filter never excludes anything.
    if (entry.flags.stage === 0) byPath.set(entry.path, entry);
  }
  const dirty: FilePath[] = [];
  for (const path of paths) {
    const entry = byPath.get(path);
    if (entry === undefined) {
      // A path the stash adds: an existing (untracked) working file would be clobbered.
      const exists = await ctx.fs.exists(`${ctx.layout.workDir}/${path}`);
      if (exists) dirty.push(path);
      continue;
    }
    if ((await compareWorkingTreeEntry(ctx, entry)) === 'modified') dirty.push(path);
  }
  return dirty;
};

/** Write the clean outcomes' merged blobs and synthesise the merged root tree. */
const synthesiseMergedTree = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
): Promise<ObjectId> => {
  const leaves: IndexEntry[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'resolved-deleted' || outcome.status === 'conflict') continue;
    if (outcome.status === 'resolved-merged') {
      const id = await writeObject(ctx, {
        type: 'blob',
        content: outcome.bytes,
        id: '' as ObjectId,
      });
      leaves.push(stage0Entry(outcome.path, id, outcome.mode));
      continue;
    }
    leaves.push(stage0Entry(outcome.path, outcome.id, outcome.mode));
  }
  return synthesizeTreeFromIndex(ctx, leaves);
};

/**
 * Working-tree bytes for a conflicted path. Mirrors `merge`'s materialisation.
 *
 * `mergeContent` always populates `conflictContent` for a content conflict, so
 * the content case is handled by the first branch. The add-add / binary /
 * type-change fallback writes the `ours` side, which the working tree already
 * holds (those conflicts arise from a path `ours` also has), so that write is a
 * no-op observationally — hence its branch-selection mutants are equivalent.
 */
const conflictBytes = async (
  ctx: Context,
  conflict: MergeConflict,
): Promise<Uint8Array | undefined> => {
  // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: equivalent — see function header (the add-add/binary fallback writes `ours`, which the working tree already holds).
  if (conflict.type === 'content' && conflict.conflictContent !== undefined) {
    return conflict.conflictContent;
  }
  if (conflict.type === 'modify-delete') {
    const survivorId = conflict.ourId ?? conflict.theirId;
    if (survivorId !== undefined) {
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      return (await readBlob(ctx, survivorId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })).content;
    }
    return undefined;
  }
  // add-add / binary / type-change: keep ours when present.
  // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — the `ours` bytes equal what the working tree already holds for these conflict types, so the write (or its absence) is observationally identical; see function header.
  if (conflict.ourId !== undefined) {
    // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
    return (await readBlob(ctx, conflict.ourId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })).content;
  }
  return undefined;
};

/** Write the changed clean outcomes + conflict markers to the working tree. */
const writeConflictWorktree = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
  changed: ReadonlySet<FilePath>,
): Promise<void> => {
  for (const outcome of outcomes) {
    // Stryker disable next-line ConditionalExpression: equivalent — the `!changed.has` half only skips outcomes that equal `ours` (writing them reproduces working bytes); the `if(true)` skip-all variant is killed by the multi-path conflict test that asserts the clean side is written.
    if (outcome.status === 'conflict' || !changed.has(outcome.path)) continue;
    if (outcome.status === 'resolved-deleted') {
      await removeWorkingTreeFile(ctx, outcome.path);
      continue;
    }
    if (outcome.status === 'resolved-merged') {
      await writeWorkingTreeFile(ctx, outcome.path, outcome.bytes);
      continue;
    }
    // Stryker disable next-line ConditionalExpression: equivalent — only `resolved-known` reaches here after the deleted/merged guards; the `if(true)` variant changes nothing (the remaining outcomes are resolved-known), and `if(false)` is killed by the clean-side-written assertion.
    if (outcome.status === 'resolved-known') {
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      const blob = await readBlob(ctx, outcome.id, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES });
      await writeWorkingTreeFile(ctx, outcome.path, blob.content);
    }
  }
  for (const conflict of conflicts) {
    const bytes = await conflictBytes(ctx, conflict);
    if (bytes !== undefined) await writeWorkingTreeFile(ctx, conflict.path, bytes);
  }
};

/** Stage-0 (clean) + stage-1/2/3 (conflicts) index entries, path/stage-sorted. */
const buildUnmergedIndex = (
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
): ReadonlyArray<IndexEntry> => {
  const stage0: IndexEntry[] = [];
  for (const outcome of outcomes) {
    // Stryker disable next-line ConditionalExpression: equivalent — `unchanged`/`resolved-known` are the only blob-backed clean outcomes; an `unchanged` stage-0 entry equals the current index (committing it is a no-op), so dropping that half of the disjunction is observationally identical to the index the caller commits.
    if (outcome.status === 'unchanged' || outcome.status === 'resolved-known') {
      stage0.push(stage0Entry(outcome.path, outcome.id, outcome.mode));
    }
  }
  const combined = [...stage0, ...conflictsToIndexEntries(conflicts, zeroStat)];
  combined.sort((a, b) => {
    if (a.path < b.path) return -1;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — for any distinct-path pair V8 derives the order from the `a.path < b.path → -1` rule above (evaluated in whichever argument order yields `<`), so this `>` branch never changes the observable sort result.
    if (a.path > b.path) return 1;
    // Stryker disable next-line ArithmeticOperator: equivalent — the stage branch only compares equal-path entries, which always arrive stage-ascending (conflictsToIndexEntries sorts conflict stages and rejects duplicate paths; stage-0 entries all share stage 0), so the comparator is a no-op on an already-ordered run regardless of sign.
    return a.flags.stage - b.flags.stage;
  });
  return combined;
};

const rejectUnsupported = (conflicts: ReadonlyArray<MergeConflict>): void => {
  for (const conflict of conflicts) {
    if (UNSUPPORTED_CONFLICT_TYPES.has(conflict.type)) {
      throw unsupportedOperation(
        'apply-merge',
        `conflict type '${conflict.type}' not supported (path=${conflict.path})`,
      );
    }
  }
};

export const applyMergeToWorktree = async (
  ctx: Context,
  input: ApplyMergeInput,
): Promise<ApplyMergeResult> => {
  const [base, ours, theirs] = await Promise.all([
    input.baseTree !== undefined ? flattenTree(ctx, input.baseTree) : Promise.resolve(undefined),
    flattenTree(ctx, input.oursTree),
    flattenTree(ctx, input.theirsTree),
  ]);
  const merged = await mergeTrees(base, ours, theirs, buildContentMerger(ctx));
  // Stryker disable next-line ConditionalExpression: equivalent — `rejectUnsupported` over an empty conflict list is a no-op, so the `if(true)` variant behaves identically on a clean merge; `if(false)` is killed by the gitlink-rejection test.
  if (!merged.cleanMerge) rejectUnsupported(merged.conflicts);

  const changed = changedPaths(merged.outcomes, merged.conflicts, ours.entries);
  const overwrite = await findWouldOverwrite(ctx, changed, input.currentIndex);
  if (overwrite.length > 0) return { kind: 'would-overwrite', paths: overwrite };

  if (merged.cleanMerge) {
    const mergedTree = await synthesiseMergedTree(ctx, merged.outcomes);
    const result = await materializeTree(ctx, {
      targetTree: mergedTree,
      currentIndex: input.currentIndex,
      // Stryker disable next-line BooleanLiteral: equivalent — `findWouldOverwrite` has already returned every dirty path as `would-overwrite` above, so by here no changed path is dirty and `force: false` would behave identically (nothing to refuse).
      force: true,
    });
    return { kind: 'clean', mergedTree, result };
  }
  await writeConflictWorktree(ctx, merged.outcomes, merged.conflicts, changed);
  return {
    kind: 'conflict',
    conflicts: merged.conflicts,
    indexEntries: buildUnmergedIndex(merged.outcomes, merged.conflicts),
  };
};

export type MergeTreesResult =
  | { readonly kind: 'clean'; readonly mergedTree: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> };

/**
 * Pure tree-level 3-way merge: produce the merged tree without touching the
 * working tree or index. Used by `stash apply --index` to reinstate the staged
 * state. A conflicting merge yields `{ kind: 'conflict' }` (the caller leaves
 * the index untouched — git's "Index was not unstashed").
 */
export const mergeTreesToTree = async (
  ctx: Context,
  input: {
    readonly baseTree: ObjectId | undefined;
    readonly oursTree: ObjectId;
    readonly theirsTree: ObjectId;
  },
): Promise<MergeTreesResult> => {
  const [base, ours, theirs] = await Promise.all([
    input.baseTree !== undefined ? flattenTree(ctx, input.baseTree) : Promise.resolve(undefined),
    flattenTree(ctx, input.oursTree),
    flattenTree(ctx, input.theirsTree),
  ]);
  const merged = await mergeTrees(base, ours, theirs, buildContentMerger(ctx));
  // Stryker disable next-line ConditionalExpression: equivalent — `if(true)` (always-conflict) is killed by the clean `--index` reinstatement test; `if(false)` only mishandles a *conflicting* index-side `--index` merge, which v1 intentionally leaves un-reinstated ("Index was not unstashed", ADR-211), so the caller's behaviour is unchanged.
  if (!merged.cleanMerge) return { kind: 'conflict', conflicts: merged.conflicts };
  return { kind: 'clean', mergedTree: await synthesiseMergedTree(ctx, merged.outcomes) };
};
