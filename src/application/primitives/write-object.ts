/**
 * Loose-object writer. Encodes a GitObject as `<type> <size>\0<payload>`,
 * zlib-deflates it, and files it under `.git/objects/<2>/<38>`. The
 * resulting file is byte-identical to `git hash-object -w` output for the
 * same payload.
 *
 * @writes
 *   surface: looseObject
 *   kind:    equivalent-under-readback
 *   format:  git-loose-object
 */
import { operationAborted, TsgitError } from '../../domain/error.js';
import { objectHashMismatch } from '../../domain/objects/error.js';
import type { GitObject, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readConfig, ZLIB_MAX_LEVEL, ZLIB_MIN_LEVEL } from './config-read.js';
import { invalidateLooseOid } from './internal/loose-oid-cache.js';
import { serializeAndHash } from './internal/serialize-and-hash.js';
import { commonGitDir, looseObjectPath, objectsDir } from './path-layout.js';
import { hasDeclaredId } from './validators.js';

export async function writeObject(ctx: Context, object: GitObject): Promise<ObjectId> {
  if (ctx.signal?.aborted) throw operationAborted();

  const { bytes, id: computed } = await serializeAndHash(ctx, object);

  const declaredId = object.id as string;
  if (hasDeclaredId(declaredId) && declaredId !== computed) {
    throw objectHashMismatch(object.id, computed);
  }

  if (ctx.signal?.aborted) throw operationAborted();

  const config = await readConfig(ctx);
  const looseLevel = config.core?.looseCompression;

  const prefix = computed.slice(0, 2);
  await ctx.fs.mkdir(objectsDir(commonGitDir(ctx), prefix));
  const path = looseObjectPath(commonGitDir(ctx), computed);
  const compressed =
    looseLevel !== undefined && looseLevel >= ZLIB_MIN_LEVEL && looseLevel <= ZLIB_MAX_LEVEL
      ? await ctx.compressor.deflate(bytes, looseLevel)
      : await ctx.compressor.deflate(bytes);

  try {
    await ctx.fs.writeExclusive(path, compressed);
  } catch (error) {
    if (isFileExists(error)) {
      invalidateLooseOid(ctx, computed);
      return computed;
    }
    throw error;
  }
  invalidateLooseOid(ctx, computed);
  return computed;
}

function isFileExists(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'FILE_EXISTS';
}
