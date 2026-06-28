// Shared object-emit helpers for pack-building enumerators.
//
// Extracted from enumerate-push-objects and enumerate-bundle-objects, which both
// implement a cap-guarded emitter and a tag-chain resolver with the same algorithm.
// Canonical, fully-commented source: enumerate-push-objects.ts.
import { TsgitError } from '../../../domain/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';

export interface EmitState {
  readonly emitted: Set<ObjectId>;
  readonly cap: number;
}

export const tryEmit = (state: EmitState, id: ObjectId): boolean => {
  if (state.emitted.has(id)) return false;
  // Pre-check the cap so the Set's invariant ("only contains emitted ids
  // within the cap") holds on the failure path. Without this, the throw
  // would happen AFTER the cap-violating entry was already inserted,
  // leaving the Set one element above the cap.
  if (state.emitted.size >= state.cap) {
    throw new TsgitError({
      code: 'PACK_TOO_LARGE',
      objectCount: state.emitted.size + 1,
      limit: state.cap,
    });
  }
  state.emitted.add(id);
  return true;
};

/**
 * Follow a tag chain (annotated tag → annotated tag →... → commit)
 * yielding each tag oid through `recordTag`. Returns the terminal
 * commit oid for the caller to use as a commit-walk seed. Non-tag
 * oids pass through untouched.
 */
export const resolveTagChain = async (
  ctx: Context,
  id: ObjectId,
  recordTag: (id: ObjectId) => void,
): Promise<ObjectId> => {
  let current = id;
  // A pathological tag-of-tag chain would be rare but a malicious server
  // could in principle advertise one; cap the unwrap at the same depth
  // we already use for symbolic ref resolution to avoid an infinite loop
  // if a tag points back at itself (corrupt object).
  for (let i = 0; i < 16; i += 1) {
    const obj = await readObject(ctx, current);
    if (obj.type !== 'tag') return current;
    recordTag(current);
    current = obj.data.object;
  }
  return current;
};
