/**
 * Enumerate every current ref: `HEAD`, loose refs under both the worktree's
 * own `refs/` (per-worktree namespaces: `refs/bisect/…`, `refs/worktree/…`,
 * `refs/rewritten/…`) and the common dir's `refs/` (everything shared), and
 * packed-refs entries — deduplicated. Consumed by `describe`, `name-rev`,
 * `push`, `remote`, `bundle-create`, fsck and `reflog expire` — several of
 * which are bench-tracked, so this delegates straight to the backend-neutral
 * `listRefs`, which walks each root exactly once.
 */
import type { RefName } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { getRefStore } from './ref-store.js';

export async function enumerateRefs(ctx: Context): Promise<ReadonlyArray<RefName>> {
  return (await getRefStore(ctx).listRefs()).map((entry) => entry.name);
}
