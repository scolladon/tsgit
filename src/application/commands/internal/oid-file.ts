/**
 * Read a git state file that holds a single `<oid>\n` — e.g. `CHERRY_PICK_HEAD`,
 * or the sequencer's `head` / `abort-safety`. Returns `undefined` when the file
 * is absent or empty; a corrupt (non-40-hex) value throws `INVALID_OBJECT_ID`
 * via the ObjectId factory, so a mid-write crash never yields a malformed id.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import { ObjectId as ObjectIdFactory } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';

export const readOptionalOidFile = async (
  ctx: Context,
  path: string,
): Promise<ObjectId | undefined> => {
  if (!(await ctx.fs.exists(path))) return undefined;
  const trimmed = (await ctx.fs.readUtf8(path)).trim();
  if (trimmed.length === 0) return undefined;
  return ObjectIdFactory.from(trimmed);
};
