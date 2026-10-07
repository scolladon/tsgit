/**
 * git `name-rev`'s `name_ref` peel: each link of a ref's tag chain is loaded
 * as `parse_object` loads it, so a ref whose object is absent or does not
 * parse names nothing — git skips it and keeps naming from the other refs,
 * logging the parse failure of an object it found but could not read.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { Commit, GitObject, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../../primitives/read-object.js';

export interface NameRevTip {
  /** The commit the ref peels to; `undefined` when the chain ends elsewhere or breaks. */
  readonly commit: Commit | undefined;
  /** The ref named a tag object (an annotated tag), not the object it peels to. */
  readonly deref: boolean;
  /** Outermost annotated-tag tagger timestamp; `0` when not reached via a tag. */
  readonly taggerDate: number;
}

/** The refusals of an object found but not parsed — git's `parse_object` NULL after its `error:`. */
const UNPARSED_CODES: ReadonlySet<string | undefined> = new Set(['INVALID_TAG', 'INVALID_COMMIT']);

/** git's `parse_object`: `undefined` for an absent object, or one found but unparsed (logged). */
export const parseObjectGently = async (
  ctx: Context,
  id: ObjectId,
): Promise<GitObject | undefined> => {
  try {
    return await readObject(ctx, id);
  } catch (error) {
    const code = errorDataCode(error);
    if (code === 'OBJECT_NOT_FOUND') return undefined;
    if (!UNPARSED_CODES.has(code)) throw error;
    ctx.logger?.error?.(`bad object ${id}: ${(error as Error).message}`, { id, code });
    return undefined;
  }
};

/** Peel `oid` through its tag chain; a revisited link (a store not hashing to names) ends it. */
export const peelNameRevTip = async (ctx: Context, oid: ObjectId): Promise<NameRevTip> =>
  peelLoadedTip(ctx, oid, await parseObjectGently(ctx, oid));

/** {@link peelNameRevTip} from `oid`'s already-loaded object — git's `deref_tag` of a parsed object. */
export const peelLoadedTip = async (
  ctx: Context,
  oid: ObjectId,
  object: GitObject | undefined,
): Promise<NameRevTip> => {
  let current = object;
  let deref = false;
  let taggerDate = 0;
  const seen = new Set<ObjectId>([oid]);
  while (current?.type === 'tag' && !seen.has(current.data.object)) {
    seen.add(current.data.object);
    if (!deref) taggerDate = current.data.tagger?.timestamp ?? 0;
    deref = true;
    current = await parseObjectGently(ctx, current.data.object);
  }
  const commit = current?.type === 'commit' ? current : undefined;
  return { commit, deref, taggerDate };
};
