/**
 * Single source of truth for "is this index entry dirty in the working tree?".
 *
 * Compares the working file at `entry.path` against the entry's `(id, mode)`:
 * `absent` when no working file exists, `modified` when the derived working
 * mode or the content hash differs, else `unchanged`. Content is hashed via the
 * uncapped `serializeAndHash` core (never the size-capped `hashBlob` write path),
 * so a read-only comparison never throws on a large working file. Symlink
 * content is its target (`readlink`), not the followed file.
 *
 * Consumed by `status` (reporting) and `rm` (the local-modification valve).
 */
import type { IndexEntry } from '../../domain/git-index/index-entry.js';
import { deriveWorkingMode } from '../../domain/objects/file-mode.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { serializeAndHash } from './internal/serialize-and-hash.js';

export type WorkingTreeComparison = 'absent' | 'unchanged' | 'modified';

const LINK_ENCODER = new TextEncoder();

export const compareWorkingTreeEntry = async (
  ctx: Context,
  entry: IndexEntry,
): Promise<WorkingTreeComparison> => {
  const absPath = `${ctx.layout.workDir}/${entry.path}`;
  const stat = await ctx.fs.lstat(absPath).catch(() => undefined);
  if (stat === undefined) return 'absent';
  if (deriveWorkingMode(stat) !== entry.mode) return 'modified';
  const content = stat.isSymbolicLink
    ? LINK_ENCODER.encode(await ctx.fs.readlink(absPath))
    : await ctx.fs.read(absPath);
  const { id } = await serializeAndHash(ctx, { type: 'blob', id: '' as ObjectId, content });
  return id === entry.id ? 'unchanged' : 'modified';
};
