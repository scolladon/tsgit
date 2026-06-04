import { TsgitError } from '../../../domain/error.js';
import type { Commit, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';

export interface ReadCommitOptions {
  readonly verifyHash: boolean;
  readonly ignoreMissing: boolean;
  /** Sink recording oids skipped under `ignoreMissing` — the caller's read-dedup memo. */
  readonly missing: Set<string>;
}

/**
 * Lenient commit read for ancestry walks: resolves `id`, returning `undefined`
 * for a non-commit object and — under `ignoreMissing` — for a missing one (its
 * oid recorded in `missing`). Any other read failure propagates unchanged.
 */
export const readCommit = async (
  ctx: Context,
  id: ObjectId,
  opts: ReadCommitOptions,
): Promise<Commit | undefined> => {
  try {
    const object = await readObject(ctx, id, { verifyHash: opts.verifyHash });
    return object.type === 'commit' ? object : undefined;
  } catch (error) {
    if (opts.ignoreMissing && isObjectNotFound(error)) {
      opts.missing.add(id);
      return undefined;
    }
    throw error;
  }
};

const isObjectNotFound = (error: unknown): boolean =>
  error instanceof TsgitError && error.data.code === 'OBJECT_NOT_FOUND';
