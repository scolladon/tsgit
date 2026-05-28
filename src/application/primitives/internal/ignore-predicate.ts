import type { FilePath } from '../../../domain/objects/object-id.js';

/**
 * Per-path ignore predicate. Returns `true` to skip the path.
 *
 * used a synchronous predicate.3 widens the return
 * type to `boolean | Promise<boolean>` so the real `.gitignore`
 * evaluator can perform lazy nested-rule I/O during the walk. Sync
 * callers (test injections, hand-rolled filters) still satisfy the
 * type without rewriting.
 *
 * The predicate is consulted by `walkWorkingTree` on directories BEFORE
 * descent (to prune subtrees) and on leaves BEFORE yielding.
 */
export type IgnorePredicate = (path: FilePath, isDirectory: boolean) => boolean | Promise<boolean>;
