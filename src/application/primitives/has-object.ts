/**
 * Local-only object-presence probe. A CQS query: unlike `readObject`, it never
 * inflates, never verifies, and never consults `ctx.promisor` — a promised
 * (not-yet-fetched) object in a partial repo answers `false` here, exactly as
 * it would on disk. Callers that need the object's bytes still go through
 * `readObject`.
 */
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { commonGitDir, looseObjectPath } from './path-layout.js';
import { getPackRegistry } from './read-object.js';

export const hasObject = async (ctx: Context, id: ObjectId): Promise<boolean> => {
  const hit = await getPackRegistry(ctx).lookup(id);
  if (hit !== undefined) return true;
  return ctx.fs.exists(looseObjectPath(commonGitDir(ctx), id));
};
