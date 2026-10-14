import {
  invalidateIndexCache,
  readIndex,
} from '../../../../../src/application/primitives/read-index.js';
import { serializeCacheTree } from '../../../../../src/domain/git-index/cache-tree.js';
import { serializeIndex } from '../../../../../src/domain/git-index/index.js';
import type {
  CacheTreeEntry,
  IndexExtension,
} from '../../../../../src/domain/git-index/index-entry.js';
import { concatBytes, encode, hexToBytes } from '../../../../../src/domain/objects/encoding.js';
import type { Context } from '../../../../../src/ports/context.js';

const NUL = 0;
const BLOB_MODE_OCTAL = '100644';
const ABSENT_MODE_OCTAL = '0';

export const UNKNOWN_EXTENSION: IndexExtension = {
  signature: 'ZZZZ',
  data: Uint8Array.of(0xde, 0xad, 0xbe, 0xef),
};

export const UNTR_EXTENSION: IndexExtension = {
  signature: 'UNTR',
  data: Uint8Array.of(0x01, 0x02, 0x03, 0x04, 0x05),
};

const nulTerminated = (text: string): Uint8Array => Uint8Array.of(...encode(text), NUL);

/** A `REUC` extension with one record: `path` resolved from a single stage-1 blob `id`. */
export const resolveUndoExtension = (
  path: string,
  id: string,
  digestLength: 20 | 32,
): IndexExtension => {
  const oid = hexToBytes(id);
  if (oid.length !== digestLength) throw new Error('resolve-undo oid width mismatch');
  return {
    signature: 'REUC',
    data: concatBytes([
      nulTerminated(path),
      nulTerminated(BLOB_MODE_OCTAL),
      nulTerminated(ABSENT_MODE_OCTAL),
      nulTerminated(ABSENT_MODE_OCTAL),
      oid,
    ]),
  };
};

export const cacheTreeExtension = (
  root: CacheTreeEntry,
  digestLength: 20 | 32,
): IndexExtension => ({
  signature: 'TREE',
  data: serializeCacheTree(root, digestLength),
});

/** Rewrite the on-disk index so it carries exactly `extensions`. */
export const withIndexExtensions = async (
  ctx: Context,
  extensions: ReadonlyArray<IndexExtension>,
): Promise<void> => {
  const index = await readIndex(ctx);
  const body = serializeIndex({ ...index, extensions }, ctx.hashConfig.digestLength);
  const checksum = await ctx.hash.hash(body);
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, concatBytes([body, checksum]));
  invalidateIndexCache(ctx);
};

/** The extensions the on-disk index carries, by signature. */
export const indexExtensionsOf = async (ctx: Context): Promise<Map<string, Uint8Array>> => {
  invalidateIndexCache(ctx);
  const index = await readIndex(ctx);
  return new Map(index.extensions.map((extension) => [extension.signature, extension.data]));
};
