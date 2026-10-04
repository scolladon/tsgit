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
import { peel } from '../../primitives/internal/peel.js';
import { evaluateRevision, resolveRevision } from '../rev-parse.js';

/** Resolve `rev` and peel to its commit (annotated tags followed). */
export const resolveCommit = async (ctx: Context, rev: string): Promise<ObjectId> =>
  peel(ctx, undefined, await resolveRevision(ctx, rev), 'commit');

/** Resolve `rev` and peel to its tree (commit → its tree, tags followed). */
export const resolveTreeish = async (ctx: Context, rev: string): Promise<ObjectId> =>
  peel(ctx, undefined, await resolveRevision(ctx, rev), 'tree');

/** {@link resolveCommit} for the commands that refuse their argument after one read (`name-rev`, `range-diff`'s ranges). */
export const resolveCommitOnce = async (ctx: Context, rev: string): Promise<ObjectId> =>
  peel(ctx, undefined, await evaluateRevision(ctx, rev), 'commit');
