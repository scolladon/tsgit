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
import { freshenObject, touchLooseCopy } from './internal/freshen-object.js';
import { invalidateLooseOid } from './internal/loose-oid-cache.js';
import {
  assertRepoSettingsValid,
  repoSettingsVerdictSettled,
} from './internal/repo-settings-gate.js';
import { serializeAndHash } from './internal/serialize-and-hash.js';
import { commonGitDir, looseObjectPath, objectsDir } from './path-layout.js';
import { hasDeclaredId } from './validators.js';

interface Serialized {
  readonly bytes: Uint8Array;
  readonly id: ObjectId;
}

async function serializeChecked(ctx: Context, object: GitObject): Promise<Serialized> {
  if (!repoSettingsVerdictSettled(ctx)) await assertRepoSettingsValid(ctx);
  if (ctx.signal?.aborted) throw operationAborted();

  const serialized = await serializeAndHash(ctx, object);

  const declaredId = object.id as string;
  if (hasDeclaredId(declaredId) && declaredId !== serialized.id) {
    throw objectHashMismatch(object.id, serialized.id);
  }

  if (ctx.signal?.aborted) throw operationAborted();
  return serialized;
}

export async function writeObject(ctx: Context, object: GitObject): Promise<ObjectId> {
  const { bytes, id } = await serializeChecked(ctx, object);
  if (await freshenObject(ctx, id)) return id;
  return storeLoose(ctx, bytes, id);
}

/** git's `force_object_loose`: the loose copy is written even when a source already holds the
 *  object — for callers about to drop the copy that holds it. */
export async function writeLooseObject(ctx: Context, object: GitObject): Promise<ObjectId> {
  const { bytes, id } = await serializeChecked(ctx, object);
  return storeLoose(ctx, bytes, id);
}

const isValidLooseLevel = (level: number | undefined): level is number =>
  level !== undefined && level >= ZLIB_MIN_LEVEL && level <= ZLIB_MAX_LEVEL;

async function storeLoose(ctx: Context, bytes: Uint8Array, id: ObjectId): Promise<ObjectId> {
  const looseLevel = (await readConfig(ctx)).core?.looseCompression;
  await ctx.fs.mkdir(objectsDir(commonGitDir(ctx), id.slice(0, 2)));
  const path = looseObjectPath(commonGitDir(ctx), id);
  const compressed = isValidLooseLevel(looseLevel)
    ? await ctx.compressor.deflate(bytes, looseLevel)
    : await ctx.compressor.deflate(bytes);
  try {
    await ctx.fs.writeExclusive(path, compressed);
  } catch (error) {
    if (!isFileExists(error)) throw error;
    invalidateLooseOid(ctx, id);
    await touchLooseCopy(ctx, path);
    return id;
  }
  invalidateLooseOid(ctx, id);
  return id;
}

function isFileExists(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'FILE_EXISTS';
}
