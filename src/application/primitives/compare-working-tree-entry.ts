/**
 * Single source of truth for "is this index entry dirty in the working tree?".
 *
 * Compares the working file at `entry.path` against the entry's `(id, mode)`:
 * `absent` when no working file exists, `type-changed` when the file kind differs
 * (file↔symlink, git's `T`; gitlink/submodule entries are excluded — git reports
 * them as `M`), `modified` when the content hash differs, `mode-changed` when only
 * the mode (exec bit) differs with identical content, else `unchanged`. Content is
 * hashed via the
 * uncapped `serializeAndHash` core (never the size-capped `hashBlob` write path),
 * so a read-only comparison never throws on a large working file. Symlink
 * content is its target (`readlink`), not the followed file.
 *
 * Consumed by `status` (which reads the richer `compareWorkingTreeDelta`) and by
 * `rm` / `stash` / clean-work-tree / apply-merge (the local-modification valve,
 * which read the `compareWorkingTreeEntry` enum projection).
 */
import { isSameKind } from '../../domain/diff/mode-kind.js';
import type { IndexEntry } from '../../domain/git-index/index-entry.js';
import { deriveWorkingMode, FILE_MODE, type FileMode } from '../../domain/objects/file-mode.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { serializeAndHash } from './internal/serialize-and-hash.js';

export type WorkingTreeComparison =
  | 'absent'
  | 'unchanged'
  | 'modified'
  | 'type-changed'
  | 'mode-changed';

/**
 * A working-tree comparison plus the working file's mode (`mW`). `worktreeMode`
 * is what `git status --porcelain=v2` reports for the worktree side; it is
 * present whenever a working file exists and omitted only when the file is
 * `absent`. There is no working blob oid — the file need not be in the object
 * store, so git itself prints no `hW`.
 */
export interface WorkingTreeDelta {
  readonly status: WorkingTreeComparison;
  readonly worktreeMode?: FileMode;
}

/**
 * Whether a working-tree comparison represents a present-but-differing file —
 * the "modified variant" set git's local-modification valve refuses to clobber.
 * `absent` (gone) and `unchanged` (clean) are excluded; everything else
 * (`modified`, `type-changed`, `mode-changed`) is a local modification.
 */
export const isWorkingTreeModified = (comparison: WorkingTreeComparison): boolean =>
  comparison !== 'unchanged' && comparison !== 'absent';

const LINK_ENCODER = new TextEncoder();

export const compareWorkingTreeDelta = async (
  ctx: Context,
  entry: IndexEntry,
): Promise<WorkingTreeDelta> => {
  const absPath = `${ctx.layout.workDir}/${entry.path}`;
  const stat = await ctx.fs.lstat(absPath).catch(() => undefined);
  if (stat === undefined) return { status: 'absent' };
  const worktreeMode = deriveWorkingMode(stat);
  // A file↔symlink kind change is git's `T`, decided on mode alone — no hash
  // needed and the content is meaningless across kinds. A gitlink (submodule)
  // entry is excluded: `deriveWorkingMode` cannot derive a gitlink, so the
  // comparison would always spuriously read `T`; git reports a submodule as `M`,
  // so the gitlink entry falls through to the content path (an unreadable
  // submodule directory degrades to `modified`).
  if (entry.mode !== FILE_MODE.GITLINK && !isSameKind(worktreeMode, entry.mode)) {
    return { status: 'type-changed', worktreeMode };
  }
  try {
    const content = stat.isSymbolicLink
      ? LINK_ENCODER.encode(await ctx.fs.readlink(absPath))
      : await ctx.fs.read(absPath);
    const { id } = await serializeAndHash(ctx, { type: 'blob', id: '' as ObjectId, content });
    // Content dominates: a changed blob is `modified` regardless of mode. Only a
    // same-blob mode difference (exec bit) is `mode-changed`.
    if (id !== entry.id) return { status: 'modified', worktreeMode };
    return { status: worktreeMode === entry.mode ? 'unchanged' : 'mode-changed', worktreeMode };
  } catch {
    // The file exists (lstat succeeded) but cannot be read/hashed — never report
    // an unverifiable file as `unchanged`; treat it as modified (dirty).
    return { status: 'modified', worktreeMode };
  }
};

/**
 * Enum projection over {@link compareWorkingTreeDelta} — the dirtiness verdict
 * without the mode. Consumed by the local-modification valve (`rm`, `stash`,
 * clean-work-tree, apply-merge) where only the status matters.
 */
export const compareWorkingTreeEntry = async (
  ctx: Context,
  entry: IndexEntry,
): Promise<WorkingTreeComparison> => (await compareWorkingTreeDelta(ctx, entry)).status;
