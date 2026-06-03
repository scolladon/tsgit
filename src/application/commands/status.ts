import { primaryPath } from '../../domain/diff/change-path.js';
import {
  type ConflictKind,
  classifyUnmerged,
  comparePaths,
  type DiffChange,
  diffIndexAgainstTree,
  groupUnmergedEntries,
  type UnmergedEntryGroup,
} from '../../domain/diff/index.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import type { FileMode, RefName } from '../../domain/objects/index.js';
import type { FilePath, ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import {
  compareWorkingTreeEntry,
  type WorkingTreeComparison,
} from '../primitives/compare-working-tree-entry.js';
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

export type { ConflictKind } from '../../domain/diff/index.js';

/** A single merge stage's blob: its object id and file mode. */
export interface ConflictStage {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

/**
 * An unmerged (conflicted) path: its git conflict state plus the per-stage blobs
 * (`base` = stage 1, `ours` = stage 2, `theirs` = stage 3; `undefined` when that
 * stage is absent). The stages make the entry lossless against git's porcelain
 * unmerged reporting (v1 `XY` from `kind`, v2 `u`-line modes/oids from the stages).
 */
export interface UnmergedEntry {
  readonly kind: ConflictKind;
  readonly path: FilePath;
  readonly base?: ConflictStage;
  readonly ours?: ConflictStage;
  readonly theirs?: ConflictStage;
}

export interface StatusResult {
  readonly branch: RefName | undefined;
  readonly detached: boolean;
  readonly indexChanges: ReadonlyArray<ChangeEntry>;
  readonly workingTreeChanges: ReadonlyArray<ChangeEntry>;
  readonly unmerged: ReadonlyArray<UnmergedEntry>;
  readonly clean: boolean;
}

const STATUS_SCAN_OP = 'status:scan';
const STATUS_SCAN_GRANULARITY = 100;

/**
 * Summarize the state of the working tree against git's columns: the **staged**
 * column (HEAD-tree vs index — git's "Changes to be committed",
 * `diff-index --cached HEAD`), the **working-tree** column (index vs working
 * tree), untracked files, and the **unmerged** column (conflicted paths with
 * stage 1/2/3 entries — git's "Unmerged paths"). The staged and working-tree
 * passes are independent; a path may appear in both (e.g. removed from the index
 * but still on disk → staged delete + untracked). A conflicted path is reported
 * only under `unmerged`, never in the other columns. `clean` is true only when
 * every column and the unmerged set are empty.
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
  // Partition the index into the stage-0 (tracked) entries and the unmerged
  // (stage 1/2/3) groups. A conflicted path has no stage-0 entry, so it is
  // reported only under the unmerged column — never in the working-tree column.
  const grouped = groupUnmergedEntries(index);
  const trackedPaths = new Set<FilePath>(grouped.unmerged.keys());
  for (const entry of grouped.staged) trackedPaths.add(entry.path);
  ctx.progress.start(STATUS_SCAN_OP);
  try {
    const tracker = createGranularityTracker(ctx.progress, STATUS_SCAN_OP, STATUS_SCAN_GRANULARITY);
    // Pass 1: stage-0 index entries vs. working tree.
    const settled = await Promise.all(
      grouped.staged.map(async (entry) => {
        const result = await classifyEntry(ctx, entry);
        tracker.tick();
        return result;
      }),
    );
    const indexChecks = settled.filter((c): c is ChangeEntry => c !== undefined);
    // Pass 2: untracked file enumeration. Walk the working tree (with
    // gitignore filtering); anything not tracked (stage-0 or unmerged) is
    // untracked. Tracked-but-ignored entries stay tracked; the ignore filter
    // here only affects untracked emission (Git's "ignored-tracked stays
    // tracked" invariant).
    const ignore = await buildRepoIgnorePredicate(ctx);
    const untracked: ChangeEntry[] = [];
    for await (const { path } of walkWorkingTree(ctx, { ignore })) {
      if (!trackedPaths.has(path)) untracked.push({ kind: 'untracked', path });
    }
    untracked.sort((a, b) => comparePaths(a.path, b.path));
    const workingTreeChanges = [...indexChecks, ...untracked];
    // Staged column: HEAD-tree vs index (git's "Changes to be committed"). A
    // conflicted path (stage 1/2/3, no stage-0) is in HEAD's tree but absent from
    // the stage-0 map, so `diffIndexAgainstTree` would surface it as a spurious
    // staged delete — drop it, since git reports it only under unmerged.
    const headTree = await readHeadTree(ctx);
    const indexChanges = diffIndexAgainstTree(index, headTree)
      .changes.map(toStagedChange)
      .filter((change) => !grouped.unmerged.has(change.path));
    // Unmerged column: conflicted paths (stage 1/2/3), git's "Unmerged paths".
    const unmerged = toUnmergedEntries(grouped.unmerged);
    const clean =
      indexChanges.length === 0 && workingTreeChanges.length === 0 && unmerged.length === 0;
    return {
      branch,
      detached,
      indexChanges,
      workingTreeChanges,
      unmerged,
      clean,
    };
  } finally {
    ctx.progress.end(STATUS_SCAN_OP);
  }
};

/**
 * Project an index-vs-HEAD `DiffChange` onto the `ChangeKind` used by both status
 * columns. A kind change is `type-changed` (git `T`); a same-blob mode difference
 * is `mode-changed`; a content change is `modified`. `diffIndexAgainstTree` never
 * emits renames, so the residual `modified` arm is only reached by a
 * content-bearing `modify`.
 */
export const toStagedChange = (change: DiffChange): ChangeEntry => {
  if (change.type === 'add') return { kind: 'added', path: change.newPath };
  if (change.type === 'delete') return { kind: 'deleted', path: change.oldPath };
  if (change.type === 'type-change') return { kind: 'type-changed', path: change.path };
  if (change.type === 'modify' && change.oldId === change.newId) {
    return { kind: 'mode-changed', path: change.path };
  }
  return { kind: 'modified', path: primaryPath(change) };
};

const conflictStage = (entry: IndexEntry): ConflictStage => ({ id: entry.id, mode: entry.mode });

/**
 * Project the grouped unmerged entries into `UnmergedEntry[]`, carrying the
 * conflict state and the present per-stage blobs. The result is byte-ordered by
 * path without an explicit sort: `groupUnmergedEntries` preserves the order of
 * the index, whose entries are required to be byte-sorted (a git index invariant).
 */
const toUnmergedEntries = (groups: ReadonlyMap<FilePath, UnmergedEntryGroup>): UnmergedEntry[] => {
  const entries: UnmergedEntry[] = [];
  for (const [path, group] of groups) {
    entries.push({
      kind: classifyUnmerged(group),
      path,
      ...(group.stage1 && { base: conflictStage(group.stage1) }),
      ...(group.stage2 && { ours: conflictStage(group.stage2) }),
      ...(group.stage3 && { theirs: conflictStage(group.stage3) }),
    });
  }
  return entries;
};

/**
 * Project a working-tree comparison onto the working-tree `ChangeKind`: `absent`
 * is git's ` D`, the type/mode/content variants map 1:1, and `unchanged` drops
 * out (no entry).
 */
export const toWorkingTreeChange = (
  comparison: WorkingTreeComparison,
  path: FilePath,
): ChangeEntry | undefined => {
  if (comparison === 'absent') return { kind: 'deleted', path };
  if (comparison === 'type-changed') return { kind: 'type-changed', path };
  if (comparison === 'mode-changed') return { kind: 'mode-changed', path };
  if (comparison === 'modified') return { kind: 'modified', path };
  return undefined;
};

const classifyEntry = async (ctx: Context, entry: IndexEntry): Promise<ChangeEntry | undefined> => {
  // A skip-worktree entry is intentionally absent from the working tree;
  // reporting its absence as `deleted` would make a sparse repo permanently
  // dirty. Its stage-0 path is still in `trackedPaths`, so pass 2 treats it as
  // tracked (never untracked).
  if (entry.flags.skipWorktree) return undefined;
  return toWorkingTreeChange(await compareWorkingTreeEntry(ctx, entry), entry.path);
};
