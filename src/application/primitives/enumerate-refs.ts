/**
 * Enumerate every current ref NAME: `HEAD`, loose refs under both the
 * worktree's own `refs/` (per-worktree namespaces: `refs/bisect/…`,
 * `refs/worktree/…`, `refs/rewritten/…`) and the common dir's `refs/`
 * (everything shared), and packed-refs entries — deduplicated. Consumed by
 * `describe`, `name-rev`, `push`, `remote`, `bundle-create`, fsck and
 * `reflog expire` — several of which are bench-tracked, and none of which
 * ever reads a resolved value off the result, so this delegates to
 * `listRefNames` rather than `listRefs`: names only, without opening a
 * single loose ref file to resolve (and then discard) its content.
 */
import type { RefName } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { getRefStore } from './ref-store.js';

export async function enumerateRefs(ctx: Context): Promise<ReadonlyArray<RefName>> {
  return getRefStore(ctx).listRefNames();
}
