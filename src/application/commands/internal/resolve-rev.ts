/**
 * Shared rev resolution for the porcelain reads (`log`, `diff`): resolve a
 * revision through the full `resolveRevision` grammar (`~`/`^`/`@{…}`/`:path`/oid-prefix)
 * and peel it to the object kind the caller needs. Peeling reuses `rev-parse`'s
 * `peel` (follows annotated tags; `commit→tree` for the tree target), so a tag
 * argument is followed to its underlying object and a rev that cannot reach the
 * wanted kind refuses exactly as `git` does.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import type { ObjectTypeTable } from '../../primitives/internal/object-type-table.js';
import { peel } from '../../primitives/internal/peel.js';
import { resolveRevision } from '../rev-parse.js';
import { requireReference } from './require-reference.js';

/** Resolve `rev` and peel to its commit (annotated tags followed). */
export const resolveCommit = async (ctx: Context, rev: string): Promise<ObjectId> =>
  peel(ctx, undefined, await resolveRevision(ctx, rev), 'commit');

/** Resolve `rev` and peel to its tree (commit → its tree, tags followed). */
export const resolveTreeish = async (ctx: Context, rev: string): Promise<ObjectId> =>
  peel(ctx, undefined, await resolveRevision(ctx, rev), 'tree');

/** git's `get_reference`: `rev` resolved and its object parsed into `table`, dying `bad object <rev>`. */
export const resolveReference = async (
  ctx: Context,
  table: ObjectTypeTable,
  rev: string,
): Promise<ObjectId> => {
  const id = await resolveRevision(ctx, rev);
  await requireReference(ctx, table, rev, id);
  return id;
};

/** A {@link resolveReference}d object peeled to its tree through the same table. */
export const peelToTree = (ctx: Context, table: ObjectTypeTable, id: ObjectId): Promise<ObjectId> =>
  peel(ctx, table, id, 'tree');
