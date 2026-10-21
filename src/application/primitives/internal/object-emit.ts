// Shared object-emit helpers for pack-building enumerators.
//
// Extracted from enumerate-push-objects and enumerate-bundle-objects, which both
// implement a cap-guarded emitter and a tag-chain resolver with the same algorithm.
// Canonical, fully-commented source: enumerate-push-objects.ts.
import { TsgitError } from '../../../domain/error.js';
import { objectNotFound } from '../../../domain/objects/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { peekDeclaredObjectHeader } from '../read-object.js';
import { assignObjectType, type ObjectTypeTable, parseTypedObject } from './object-type-table.js';

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
 * Whether the local stores' header types `id` a blob. A miss answers `false`
 * rather than refusing: the content read that follows owns the promisor
 * fetch, the delta-cache answer, the rescan and the final not-found.
 */
const isBlobByHeader = async (ctx: Context, id: ObjectId): Promise<boolean> =>
  (await peekDeclaredObjectHeader(ctx, id))?.type === 'blob';

/** The terminal object of a tag chain; `kind` is `'blob'` when its header
 *  typed it without a body read, `'other'` when the loop parsed it. */
export type PeeledWant = { readonly id: ObjectId; readonly kind: 'blob' | 'other' };

/**
 * Follow a tag chain (annotated tag → annotated tag →... → commit)
 * yielding each tag oid through `recordTag`. Returns the terminal
 * object for the caller to use as a walk seed. Non-tag oids pass
 * through untouched. Each object is typed into `table`, the
 * invocation's. A blob is typed from its header alone, never its body,
 * as git's `parse_object` types it through `oid_object_info`; a commit or
 * tree is parsed, as `parse_object` reads it.
 */
export const resolveTagChain = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  id: ObjectId,
  recordTag: (id: ObjectId) => void,
): Promise<PeeledWant> => {
  let current = id;
  // A pathological tag-of-tag chain would be rare but a malicious server
  // could in principle advertise one; cap the unwrap at the same depth
  // we already use for symbolic ref resolution to avoid an infinite loop
  // if a tag points back at itself (corrupt object).
  for (let i = 0; i < 16; i += 1) {
    if (await isBlobByHeader(ctx, current)) {
      if (!assignObjectType(ctx, table, current, 'blob')) throw objectNotFound(current);
      return { id: current, kind: 'blob' };
    }
    const obj = await parseTypedObject(ctx, table, current);
    if (obj === undefined) throw objectNotFound(current);
    if (obj.type !== 'tag') return { id: current, kind: 'other' };
    recordTag(current);
    current = obj.data.object;
  }
  return { id: current, kind: 'other' };
};
