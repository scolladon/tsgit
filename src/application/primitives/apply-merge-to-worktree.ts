/**
 * Three-way tree merge applied to the working tree + index. Shared by
 * `stash apply`, `cherry-pick`, `revert` and `rebase`. Composes the pure domain `mergeTrees` / `mergeContent` with the
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
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
import {
  type ConflictType,
  MAX_CONFLICT_OUTPUT_BYTES,
  type MergeConflict,
  type MergeLabels,
  type MergeOutcome,
  mergeTrees,
} from '../../domain/merge/index.js';
import { FILE_MODE, type FilePath, type ObjectId } from '../../domain/objects/index.js';
import { AUTO_MERGE } from '../../domain/refs/state-files.js';
import type { Context } from '../../ports/context.js';
import { buildContentMerger } from './build-content-merger.js';
import { detectMergeRenames } from './detect-merge-renames.js';
import { changedPaths, findWouldOverwrite } from './find-would-overwrite.js';
import { flattenTree } from './flatten-tree.js';
import { readUiDiffAlgorithm } from './internal/merge-rename-config.js';
import { mergedBlobEntries } from './internal/merged-blob-entries.js';
import {
  createLeadingPathScanner,
  type LeadingPathScanner,
} from './internal/symlinked-leading-path.js';
import { stage0Entry, zeroStat } from './internal/synthetic-index-entry.js';
import { validateMergeWritePaths } from './internal/validate-merge-write-paths.js';
import { writeDistinctTypesSides } from './internal/write-distinct-types-sides.js';
import {
  removeWorkingTreeFile,
  writeWorkingTreeEntry,
  writeWorkingTreeFile,
  writeWorkingTreeFileStream,
} from './internal/write-working-tree-file.js';
import { type MaterializeTreeResult, materializeTree } from './materialize-tree.js';
import { mergeCollidingRenameSources } from './merge-colliding-rename-sources.js';
import { readBlob } from './read-blob.js';
import { synthesizeResultTree, synthesizeTreeFromIndex } from './synthesize-tree-from-index.js';
import { writeObject } from './write-object.js';

const UNSUPPORTED_CONFLICT_TYPES: ReadonlySet<ConflictType> = new Set(['gitlink']);

/** Conflicts whose working-tree file is the one side that still holds the path. */
const SURVIVOR_CONFLICT_TYPES: ReadonlySet<ConflictType> = new Set([
  'modify-delete',
  'rename-delete',
  'rename-rename',
  'file-location',
]);

export interface ApplyMergeInput {
  readonly baseTree: ObjectId | undefined;
  readonly oursTree: ObjectId;
  readonly theirsTree: ObjectId;
  readonly currentIndex: GitIndex;
  /** Per-operation conflict labels for any content markers written. */
  readonly labels?: MergeLabels;
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
  | {
      readonly kind: 'would-overwrite';
      readonly localChanges: ReadonlyArray<FilePath>;
      readonly untracked: ReadonlyArray<FilePath>;
    };

/** Stage-0 entries for the clean outcomes a committed blob already backs. */
const blobBackedEntries = (outcomes: ReadonlyArray<MergeOutcome>): ReadonlyArray<IndexEntry> =>
  outcomes.flatMap((outcome) =>
    outcome.status === 'unchanged' || outcome.status === 'resolved-known'
      ? [stage0Entry(outcome.path, outcome.id, outcome.mode)]
      : [],
  );

/** Write the clean outcomes' merged blobs and synthesise the merged root tree. */
const synthesiseMergedTree = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
): Promise<ObjectId> => {
  const leaves = [...blobBackedEntries(outcomes), ...(await mergedBlobEntries(ctx, outcomes))];
  return synthesizeTreeFromIndex(ctx, leaves);
};

/**
 * Working-tree bytes for a conflicted path. Mirrors `merge`'s materialisation.
 *
 * When `conflictContent` is present (content conflicts and content-merged add-add),
 * return those bytes — they carry marker text that is observably different from
 * ours. For bare add-add (binary/symlink-symlink) and type-change, fall back to
 * ours; distinct-types conflicts are routed to `writeDistinctTypesSides` before
 * this function is reached.
 */
const conflictBytes = async (
  ctx: Context,
  conflict: MergeConflict,
): Promise<Uint8Array | undefined> => {
  // Covers markered `content` conflicts and content-merged `add-add` (both carry `conflictContent`).
  if (conflict.conflictContent !== undefined) return conflict.conflictContent;
  if (SURVIVOR_CONFLICT_TYPES.has(conflict.type)) {
    const survivorId = conflict.ourId ?? conflict.theirId;
    if (survivorId !== undefined) {
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      return (await readBlob(ctx, survivorId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })).content;
    }
    return undefined;
  }
  // Bare add-add (binary / symlink-symlink / type-change) and a bare content
  // conflict between two symlinks: keep ours when present.
  // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — for bare
  // content/add-add/binary/type-change the `ourId` is always defined (ours has a side), and the
  // write reproduces bytes the working tree already holds (ours was checked out at `path`), so
  // skipping it is observationally identical.
  if (conflict.ourId !== undefined) {
    // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
    return (await readBlob(ctx, conflict.ourId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })).content;
  }
  return undefined;
};

/**
 * Write one non-distinct-types conflict's bytes. A bare add-add writes the
 * ours side verbatim; when ours is a symlink the entry must be re-created as
 * a symlink (a plain write over a symlink-occupied path refuses on the node
 * adapter).
 */
export const writeMarkedConflict = async (
  ctx: Context,
  conflict: MergeConflict,
  scanner?: LeadingPathScanner,
): Promise<void> => {
  // Materialise with the merged mode when the merge resolved one, else the
  // surviving side's (ours, or theirs for modify-delete with ours deleted) so
  // the kind (symlink / exec bit) is preserved. Every conflict constructor
  // pairs ids with modes, so bytes being derivable implies a mode exists; the
  // guard checks anyway and skips the blob read when no mode is present.
  const mode = conflict.mergedMode ?? conflict.ourMode ?? conflict.theirMode;
  if (mode === undefined) return;
  const bytes = await conflictBytes(ctx, conflict);
  if (bytes === undefined) return;
  await writeWorkingTreeEntry(ctx, conflict.path, bytes, mode, scanner);
};

/** A `MergeOutcome` known to change a path the merge actually writes — the
 *  'conflict' variant is excluded before this type is ever reached (its own
 *  path lives on `MergeConflict`, handled separately). */
type ChangedOutcome = Exclude<MergeOutcome, { readonly status: 'conflict' }>;

/**
 * Validate then materialise one changed clean outcome. Every outcome path is
 * sourced from a tree walk (the merge's `ours`/`theirs` flatten), never from
 * a parsed index, so `resolved-deleted` is validated here too — it has NOT
 * already passed this check anywhere upstream. `resolved-deleted` carries no
 * mode of its own (a delete writes nothing); REGULAR stands in because the
 * only mode-sensitive rule this call can trigger — the `.gitmodules`-symlink
 * rejection — is a write-time concern that does not apply to a removal.
 */
const writeChangedOutcome = async (
  ctx: Context,
  outcome: ChangedOutcome,
  scanner: LeadingPathScanner,
): Promise<void> => {
  validateIndexPath(
    outcome.path,
    NO_PARSER_OFFSET,
    outcome.status === 'resolved-deleted' ? FILE_MODE.REGULAR : outcome.mode,
  );
  if (outcome.status === 'resolved-deleted') {
    await removeWorkingTreeFile(ctx, outcome.path);
    return;
  }
  if (outcome.status === 'resolved-merged') {
    await writeWorkingTreeFile(ctx, outcome.path, outcome.bytes, scanner);
    return;
  }
  // Known and unchanged outcomes alike: an unchanged one is changed only once a rename moved it.
  await writeWorkingTreeFileStream(ctx, outcome.path, outcome.id, scanner);
};

/**
 * Validate then materialise one conflict's working-tree marker/sides.
 * Validated ahead of the `distinct-types` dispatch (using the resolved mode's
 * fallback chain) so one call covers both branches below. Runs
 * unconditionally, whether or not a mode is derivable: `conflictsToIndexEntries`
 * still writes an index entry for a mode-less conflict, so its path reaches
 * `.git/index` regardless of whether this function goes on to write
 * working-tree bytes. REGULAR stands in when no mode is derivable — the only
 * mode-sensitive rule is the write-time-only `.gitmodules`-symlink
 * rejection, inapplicable when nothing is written.
 */
const writeValidatedConflict = async (
  ctx: Context,
  conflict: MergeConflict,
  scanner: LeadingPathScanner,
): Promise<void> => {
  const mode = conflict.mergedMode ?? conflict.ourMode ?? conflict.theirMode;
  validateIndexPath(conflict.path, NO_PARSER_OFFSET, mode ?? FILE_MODE.REGULAR);
  if (conflict.type === 'distinct-types') {
    await writeDistinctTypesSides(ctx, conflict, scanner);
    return;
  }
  await writeMarkedConflict(ctx, conflict, scanner);
};

/**
 * Write the changed clean outcomes + conflict markers to the working tree.
 * One scanner for the whole call: its per-directory memo serves every write
 * below (clean outcomes and conflict markers alike), so a deep tree with
 * many paths under the same symlinked directory costs one `lstat` per
 * distinct directory, not one per path.
 */
const writeConflictWorktree = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
  changed: ReadonlySet<FilePath>,
): Promise<void> => {
  const scanner = createLeadingPathScanner(ctx);
  for (const outcome of outcomes) {
    // Stryker disable next-line ConditionalExpression: equivalent — the `!changed.has` half only skips outcomes that equal `ours` (writing them reproduces working bytes); the `if(true)` skip-all variant is killed by the multi-path conflict test that asserts the clean side is written.
    if (outcome.status === 'conflict' || !changed.has(outcome.path)) continue;
    await writeChangedOutcome(ctx, outcome, scanner);
  }
  for (const conflict of conflicts) {
    await writeValidatedConflict(ctx, conflict, scanner);
  }
};

/** Stage-0 (clean) + stage-1/2/3 (conflicts) index entries, path/stage-sorted. */
const buildUnmergedIndex = (
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
  merged: ReadonlyArray<IndexEntry>,
): ReadonlyArray<IndexEntry> => {
  const stage0 = [...blobBackedEntries(outcomes), ...merged];
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

/** The blob a conflicted path holds in the result tree: the bytes its working-tree file gets. */
const conflictBlobId = async (
  ctx: Context,
  conflict: MergeConflict,
): Promise<ObjectId | undefined> => {
  if (conflict.conflictContent !== undefined) {
    const blob = { type: 'blob', content: conflict.conflictContent, id: '' as ObjectId } as const;
    return writeObject(ctx, blob);
  }
  if (SURVIVOR_CONFLICT_TYPES.has(conflict.type)) return conflict.ourId ?? conflict.theirId;
  return conflict.ourId;
};

/** A distinct-types conflict keeps each side at its own recorded path. */
const distinctTypesLeaves = (conflict: MergeConflict): ReadonlyArray<IndexEntry> => {
  const { ourPath, ourId, ourMode, theirPath, theirId, theirMode } = conflict;
  const ourSide =
    ourPath !== undefined && ourId !== undefined && ourMode !== undefined
      ? [stage0Entry(ourPath, ourId, ourMode)]
      : [];
  const theirSide =
    theirPath !== undefined && theirId !== undefined && theirMode !== undefined
      ? [stage0Entry(theirPath, theirId, theirMode)]
      : [];
  return [...ourSide, ...theirSide];
};

const conflictLeaves = async (
  ctx: Context,
  conflict: MergeConflict,
): Promise<ReadonlyArray<IndexEntry>> => {
  if (conflict.type === 'distinct-types') return distinctTypesLeaves(conflict);
  const mode = conflict.mergedMode ?? conflict.ourMode ?? conflict.theirMode;
  const id = await conflictBlobId(ctx, conflict);
  return mode === undefined || id === undefined ? [] : [stage0Entry(conflict.path, id, mode)];
};

/**
 * git's ort result tree for a conflicted merge: every clean entry (`merged`
 * carries the line-merged blobs) plus each conflicted path as its working-tree
 * file holds it.
 */
export const conflictResultTree = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
  merged: ReadonlyArray<IndexEntry>,
): Promise<ObjectId> => {
  const leaves = [...blobBackedEntries(outcomes), ...merged];
  for (const conflict of conflicts) leaves.push(...(await conflictLeaves(ctx, conflict)));
  return synthesizeResultTree(ctx, leaves);
};

/** git's `merge_switch_to_result`: `AUTO_MERGE` names the result tree it checked out. */
export const writeAutoMerge = async (ctx: Context, tree: ObjectId): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${AUTO_MERGE}`, `${tree}\n`);
};

/** Materialise a conflicted merge: working tree, `AUTO_MERGE`, and the unmerged index it stages. */
const materialiseConflict = async (
  ctx: Context,
  merged: {
    readonly outcomes: ReadonlyArray<MergeOutcome>;
    readonly conflicts: ReadonlyArray<MergeConflict>;
  },
  changed: ReadonlySet<FilePath>,
): Promise<ApplyMergeResult> => {
  // Whole-set path gate, hoisted above the write wave: a hostile name
  // anywhere in the batch refuses before the FIRST byte is written, not
  // partway through it.
  validateMergeWritePaths(merged.outcomes, merged.conflicts, changed);
  await writeConflictWorktree(ctx, merged.outcomes, merged.conflicts, changed);
  const mergedBlobs = await mergedBlobEntries(ctx, merged.outcomes);
  await writeAutoMerge(
    ctx,
    await conflictResultTree(ctx, merged.outcomes, merged.conflicts, mergedBlobs),
  );
  return {
    kind: 'conflict',
    conflicts: merged.conflicts,
    indexEntries: buildUnmergedIndex(merged.outcomes, merged.conflicts, mergedBlobs),
  };
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
  const detected = await detectMergeRenames(ctx, base, ours, theirs);
  const diffAlgorithm = await readUiDiffAlgorithm(ctx);
  const settings = diffAlgorithm === undefined ? {} : { diffAlgorithm };
  const contentMerger = buildContentMerger(ctx, input.labels, settings);
  const trees = { base, ours, theirs };
  const renames = await mergeCollidingRenameSources(ctx, trees, detected, contentMerger);
  const merged = await mergeTrees(base, ours, theirs, contentMerger, input.labels, renames);
  // Stryker disable next-line ConditionalExpression: equivalent — `rejectUnsupported` over an empty conflict list is a no-op, so the `if(true)` variant behaves identically on a clean merge; `if(false)` is killed by the gitlink-rejection test.
  if (!merged.cleanMerge) rejectUnsupported(merged.conflicts);

  const changed = changedPaths(merged.outcomes, merged.conflicts, ours.entries);
  const overwrite = await findWouldOverwrite(ctx, changed, input.currentIndex);
  if (overwrite.localChanges.length > 0 || overwrite.untracked.length > 0) {
    return {
      kind: 'would-overwrite',
      localChanges: overwrite.localChanges,
      untracked: overwrite.untracked,
    };
  }

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
  return materialiseConflict(ctx, merged, changed);
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
    readonly labels?: MergeLabels;
  },
): Promise<MergeTreesResult> => {
  const [base, ours, theirs] = await Promise.all([
    input.baseTree !== undefined ? flattenTree(ctx, input.baseTree) : Promise.resolve(undefined),
    flattenTree(ctx, input.oursTree),
    flattenTree(ctx, input.theirsTree),
  ]);
  const merged = await mergeTrees(
    base,
    ours,
    theirs,
    buildContentMerger(ctx, input.labels),
    input.labels,
  );
  // Stryker disable next-line ConditionalExpression: equivalent — `if(true)` (always-conflict) is killed by the clean `--index` reinstatement test; `if(false)` only mishandles a *conflicting* index-side `--index` merge, which v1 intentionally leaves un-reinstated ("Index was not unstashed", ADR-211), so the caller's behaviour is unchanged.
  if (!merged.cleanMerge) return { kind: 'conflict', conflicts: merged.conflicts };
  return { kind: 'clean', mergedTree: await synthesiseMergedTree(ctx, merged.outcomes) };
};
