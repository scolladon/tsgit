import type { FilePath } from '../../../domain/objects/object-id.js';

/**
 * Per-path ignore predicate. Returns `true` to skip the path.
 *
 * Phase 14.1 used a synchronous predicate; Phase 14.3 widens the
 * return type to `boolean | Promise<boolean>` so the real
 * `.gitignore` evaluator can perform lazy nested-rule I/O during the
 * walk. Sync callers (the §14.1 stub, custom test injections) still
 * satisfy the type without rewriting.
 *
 * The predicate is consulted by `walkWorkingTree` on directories
 * BEFORE descent (to prune subtrees) and on leaves BEFORE yielding.
 * See ADR-035.
 */
export type IgnorePredicate = (path: FilePath, isDirectory: boolean) => boolean | Promise<boolean>;

/**
 * Phase 14.1 stub: nothing is ignored. Phase 14.3 keeps it as the
 * fallback for tests/callers that want the §14.1 baseline; production
 * code goes through `buildRepoIgnorePredicate`.
 * See `docs/adr/029-add-all-ignore-stub.md`.
 */
export const defaultIgnorePredicate: IgnorePredicate = () => false;
