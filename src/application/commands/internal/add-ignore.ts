import type { FilePath } from '../../../domain/objects/object-id.js';

/**
 * Per-path ignore predicate. Phase 14.1 evaluates this only at LEAF
 * entries (files/symlinks) yielded by `walkWorkingTree`, so the
 * `isDirectory` flag is always `false` at the current call site. Phase
 * 14.3 will introduce directory-level pruning by passing the predicate
 * down into the walker itself; the parameter is reserved now so the
 * signature does not change when that happens.
 */
export type IgnorePredicate = (path: FilePath, isDirectory: boolean) => boolean;

/**
 * Phase 14.1 stub: nothing is ignored. Replaced by a real `.gitignore`
 * evaluator in Phase 14.3. See `docs/adr/029-add-all-ignore-stub.md`.
 */
export const defaultIgnorePredicate: IgnorePredicate = () => false;
