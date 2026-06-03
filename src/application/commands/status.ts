import { primaryPath } from '../../domain/diff/change-path.js';
import { type DiffChange, diffIndexAgainstTree } from '../../domain/diff/index.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import type { RefName } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { compareWorkingTreeEntry } from '../primitives/compare-working-tree-entry.js';
import { readHeadTree } from '../primitives/read-head-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { walkWorkingTree } from '../primitives/walk-working-tree.js';
import { buildRepoIgnorePredicate } from './internal/build-ignore-evaluator.js';
import { createGranularityTracker } from './internal/progress-tracker.js';
import { assertRepository, readHeadRaw } from './internal/repo-state.js';

export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'untracked'
  | 'type-changed'
  | 'mode-changed';

export interface ChangeEntry {
  readonly kind: ChangeKind;
  readonly path: FilePath;
}

export interface StatusResult {
  readonly branch: RefName | undefined;
  readonly detached: boolean;
  readonly indexChanges: ReadonlyArray<ChangeEntry>;
  readonly workingTreeChanges: ReadonlyArray<ChangeEntry>;
  readonly clean: boolean;
}

const STATUS_SCAN_OP = 'status:scan';
const STATUS_SCAN_GRANULARITY = 100;

/**
 * Summarize the state of the working tree against both git columns: the
 * **staged** column (HEAD-tree vs index — git's "Changes to be committed",
 * `diff-index --cached HEAD`) and the **working-tree** column (index vs working
 * tree), plus untracked files. The two columns are independent passes; a path
 * may appear in both (e.g. removed from the index but still on disk → staged
 * delete + untracked). `clean` is true only when every column is empty.
 *
 * Progress reporting: emits `status:scan` start before the
 * fan-out, updates at every 100 lstat completions, and end in a finally
 * block so the consumer always pairs start with end. `total` is undefined
 * — design choice that prevents revealing repository size to non-trusted
 * progress sinks.
 */
export const status = async (ctx: Context): Promise<StatusResult> => {
  await assertRepository(ctx);
  const head = await readHeadRaw(ctx);
  const branch = head.kind === 'symbolic' ? head.target : undefined;
  const detached = head.kind === 'direct';
  // `readIndex` returns an empty index when the file is absent (fresh/unborn
  // repo); a thrown error means a corrupt index, which we let propagate rather
  // than fabricate an empty one — fabricating it would report every HEAD path as
  // a spurious staged deletion (git errors on a corrupt index too).
  const index = await readIndex(ctx);
  const indexByPath = new Map<FilePath, IndexEntry>();
  for (const entry of index.entries) indexByPath.set(entry.path, entry);
  ctx.progress.start(STATUS_SCAN_OP);
  try {
    const tracker = createGranularityTracker(ctx.progress, STATUS_SCAN_OP, STATUS_SCAN_GRANULARITY);
    // Pass 1: index entries vs. working tree.
    const settled = await Promise.all(
      Array.from(indexByPath.values()).map(async (entry) => {
        const result = await classifyEntry(ctx, entry);
        tracker.tick();
        return result;
      }),
    );
    const indexChecks = settled.filter((c): c is ChangeEntry => c !== undefined);
    // Pass 2: untracked file enumeration. Walk the working tree (with
    // gitignore filtering); anything not in the index is untracked.
    // Tracked-but-ignored entries stay in indexByPath; they're handled
    // by Pass 1 above, so the ignore filter here only affects untracked
    // emission (Git's "ignored-tracked stays tracked" invariant).
    const ignore = await buildRepoIgnorePredicate(ctx);
    const untracked: ChangeEntry[] = [];
    for await (const { path } of walkWorkingTree(ctx, { ignore })) {
      if (!indexByPath.has(path)) untracked.push({ kind: 'untracked', path });
    }
    untracked.sort(byPathAscending);
    const workingTreeChanges = [...indexChecks, ...untracked];
    // Staged column: HEAD-tree vs index (git's "Changes to be committed").
    const headTree = await readHeadTree(ctx);
    const indexChanges = diffIndexAgainstTree(index, headTree).changes.map(toStagedChange);
    const clean = indexChanges.length === 0 && workingTreeChanges.length === 0;
    return {
      branch,
      detached,
      indexChanges,
      workingTreeChanges,
      clean,
    };
  } finally {
    ctx.progress.end(STATUS_SCAN_OP);
  }
};

/**
 * Ascending byte-order comparator for untracked entries. A filesystem walk
 * yields each path exactly once, so `a.path === b.path` is unreachable here —
 * the comparator is intentionally two-way (no equal-path branch).
 */
// Stryker disable next-line EqualityOperator: equivalent — `untracked` is built solely from `walkWorkingTree`, which yields each filesystem path exactly once, so `a.path` and `b.path` are never equal during this sort. For two distinct paths `a.path < b.path` and `a.path <= b.path` always agree, so the mutated comparator produces an identical ordering.
const byPathAscending = (a: ChangeEntry, b: ChangeEntry): number => (a.path < b.path ? -1 : 1);

/**
 * Project an index-vs-HEAD `DiffChange` onto the coarse `ChangeKind` used by both
 * status columns. A type change folds into `modified`, mirroring the working-tree
 * column's projection. `diffIndexAgainstTree` never emits renames, so the residual
 * arm only ever sees `modify` / `type-change`.
 */
const toStagedChange = (change: DiffChange): ChangeEntry => {
  if (change.type === 'add') return { kind: 'added', path: change.newPath };
  if (change.type === 'delete') return { kind: 'deleted', path: change.oldPath };
  return { kind: 'modified', path: primaryPath(change) };
};

const classifyEntry = async (ctx: Context, entry: IndexEntry): Promise<ChangeEntry | undefined> => {
  // A skip-worktree entry is intentionally absent from the working tree;
  // reporting its absence as `deleted` would make a sparse repo permanently
  // dirty. It stays in `indexByPath` so pass 2 still treats the path as tracked.
  if (entry.flags.skipWorktree) return undefined;
  const comparison = await compareWorkingTreeEntry(ctx, entry);
  if (comparison === 'absent') return { kind: 'deleted', path: entry.path };
  if (comparison === 'type-changed') return { kind: 'type-changed', path: entry.path };
  if (comparison === 'mode-changed') return { kind: 'mode-changed', path: entry.path };
  if (comparison === 'modified') return { kind: 'modified', path: entry.path };
  return undefined;
};
