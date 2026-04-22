import { operationAborted, TsgitError } from '../../domain/error.js';
import { objectHashMismatch } from '../../domain/objects/error.js';
import { type GitObject, type ObjectId, serializeObject } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { looseObjectPath, objectsDir } from './path-layout.js';
import { hasDeclaredId } from './validators.js';

export async function writeObject(ctx: Context, object: GitObject): Promise<ObjectId> {
  if (ctx.signal?.aborted) throw operationAborted();

  const bytes = serializeObject(object, ctx.hashConfig);
  const computed = (await ctx.hash.hashHex(bytes)) as ObjectId;

  const declaredId = object.id as string;
  if (hasDeclaredId(declaredId) && declaredId !== computed) {
    throw objectHashMismatch(object.id, computed);
  }

  if (ctx.signal?.aborted) throw operationAborted();

  const prefix = computed.slice(0, 2);
  await ctx.fs.mkdir(objectsDir(ctx.config.gitDir, prefix));
  const path = looseObjectPath(ctx.config.gitDir, computed);
  const compressed = await ctx.compressor.deflate(bytes);

  try {
    await ctx.fs.writeExclusive(path, compressed);
  } catch (error) {
    if (isFileExists(error)) {
      return computed;
    }
    throw error;
  }
  return computed;
}

function isFileExists(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'FILE_EXISTS';
}
