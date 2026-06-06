/**
 * Shared rev resolution for the porcelain reads (`log`, `diff`): resolve a
 * revision through the full `revParse` grammar (`~`/`^`/`@{…}`/`:path`/oid-prefix)
 * and peel it to the object kind the caller needs. Peeling reuses `rev-parse`'s
 * `peel` (follows annotated tags; `commit→tree` for the tree target), so a tag
 * argument is followed to its underlying object and a rev that cannot reach the
 * wanted kind refuses exactly as `git` does.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { peel, revParse } from '../rev-parse.js';

/** Resolve `rev` and peel to its commit (annotated tags followed). */
export const resolveCommit = async (ctx: Context, rev: string): Promise<ObjectId> =>
  peel(ctx, await revParse(ctx, rev), 'commit');

/** Resolve `rev` and peel to its tree (commit → its tree, tags followed). */
export const resolveTreeish = async (ctx: Context, rev: string): Promise<ObjectId> =>
  peel(ctx, await revParse(ctx, rev), 'tree');
