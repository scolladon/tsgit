/**
 * Standalone blob OID computation. Mirrors `git hash-object [-w]`:
 * the default mode hashes without touching the object store, while
 * `{ write: true }` files the loose object under `.git/objects/<2>/<38>`
 * via the shared `writeObject` path so the on-disk layout, mkdir
 * behaviour, and `FILE_EXISTS` idempotency stay byte-identical
 * across both code paths (ADR-162).
 */
import { workingTreeFileTooLarge } from '../../domain/commands/error.js';
import { operationAborted } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { serializeAndHash } from './internal/serialize-and-hash.js';
import { MAX_WORKING_TREE_BLOB_BYTES } from './types.js';
import { writeObject } from './write-object.js';

export interface HashBlobOptions {
  /** Persist the loose object under `.git/objects/<2>/<38>`. Default `false`. */
  readonly write?: boolean;
}

const CALLER_SUPPLIED_PATH = '(hashBlob-content)' as FilePath;

export const hashBlob = async (
  ctx: Context,
  content: Uint8Array,
  opts: HashBlobOptions = {},
): Promise<ObjectId> => {
  if (ctx.signal?.aborted) throw operationAborted();

  // Mirror the size guard `commands/add` enforces on working-tree blobs so
  // a caller-supplied buffer cannot smuggle an oversize object into the
  // store via the lower-level primitive.
  if (content.byteLength > MAX_WORKING_TREE_BLOB_BYTES) {
    throw workingTreeFileTooLarge(
      CALLER_SUPPLIED_PATH,
      content.byteLength,
      MAX_WORKING_TREE_BLOB_BYTES,
    );
  }

  // Compute the OID via the same serialise+hash helper `writeObject` uses,
  // so a `write: false` call and a subsequent `write: true` call return the
  // same OID for identical input.
  const { id } = await serializeAndHash(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content,
  });

  if (opts.write !== true) return id;

  // Re-checks `ctx.signal` inside writeObject; delegating keeps the
  // FILE_EXISTS idempotency and mkdir behaviour byte-identical.
  return writeObject(ctx, { type: 'blob', id, content });
};
