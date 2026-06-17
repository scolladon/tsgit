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
import { readConfig } from './config-read.js';
import { serializeAndHash } from './internal/serialize-and-hash.js';
import { looseObjectPath, objectsDir } from './path-layout.js';
import { hasDeclaredId } from './validators.js';

/** zlib minimum valid compression level (synonym for the implementation default). */
const ZLIB_MIN_LEVEL = -1;
/** zlib maximum valid compression level. */
const ZLIB_MAX_LEVEL = 9;

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
  await ctx.fs.mkdir(objectsDir(ctx.layout.gitDir, prefix));
  const path = looseObjectPath(ctx.layout.gitDir, computed);
  const compressed =
    looseLevel !== undefined && looseLevel >= ZLIB_MIN_LEVEL && looseLevel <= ZLIB_MAX_LEVEL
      ? await ctx.compressor.deflate(bytes, looseLevel)
      : await ctx.compressor.deflate(bytes);

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
