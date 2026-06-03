/**
 * Single source of truth for "is this index entry dirty in the working tree?".
 *
 * Compares the working file at `entry.path` against the entry's `(id, mode)`:
 * `absent` when no working file exists, `type-changed` when the file kind differs
 * (file↔symlink↔gitlink, git's `T`), `modified` when the content hash differs,
 * `mode-changed` when only the mode (exec bit) differs with identical content,
 * else `unchanged`. Content is hashed via the
 * uncapped `serializeAndHash` core (never the size-capped `hashBlob` write path),
 * so a read-only comparison never throws on a large working file. Symlink
 * content is its target (`readlink`), not the followed file.
 *
 * Consumed by `status` (reporting) and `rm` (the local-modification valve).
 */
import { isSameKind } from '../../domain/diff/mode-kind.js';
import type { IndexEntry } from '../../domain/git-index/index-entry.js';
import { deriveWorkingMode } from '../../domain/objects/file-mode.js';
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
 * Whether a working-tree comparison represents a present-but-differing file —
 * the "modified variant" set git's local-modification valve refuses to clobber.
 * `absent` (gone) and `unchanged` (clean) are excluded; everything else
 * (`modified`, `type-changed`, `mode-changed`) is a local modification.
 */
export const isWorkingTreeModified = (comparison: WorkingTreeComparison): boolean =>
  comparison !== 'unchanged' && comparison !== 'absent';

const LINK_ENCODER = new TextEncoder();

export const compareWorkingTreeEntry = async (
  ctx: Context,
  entry: IndexEntry,
): Promise<WorkingTreeComparison> => {
  const absPath = `${ctx.layout.workDir}/${entry.path}`;
  const stat = await ctx.fs.lstat(absPath).catch(() => undefined);
  if (stat === undefined) return 'absent';
  const workingMode = deriveWorkingMode(stat);
  // A kind change (file↔symlink↔gitlink) is git's `T`, decided on mode alone —
  // no hash needed and the content is meaningless across kinds.
  if (!isSameKind(workingMode, entry.mode)) return 'type-changed';
  try {
    const content = stat.isSymbolicLink
      ? LINK_ENCODER.encode(await ctx.fs.readlink(absPath))
      : await ctx.fs.read(absPath);
    const { id } = await serializeAndHash(ctx, { type: 'blob', id: '' as ObjectId, content });
    // Content dominates: a changed blob is `modified` regardless of mode. Only a
    // same-blob mode difference (exec bit) is `mode-changed`.
    if (id !== entry.id) return 'modified';
    return workingMode === entry.mode ? 'unchanged' : 'mode-changed';
  } catch {
    // The file exists (lstat succeeded) but cannot be read/hashed — never report
    // an unverifiable file as `unchanged`; treat it as modified (dirty).
    return 'modified';
  }
};
