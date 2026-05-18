import type { FilePath } from '../../../domain/objects/object-id.js';

export type IgnorePredicate = (path: FilePath, isDirectory: boolean) => boolean;

/**
 * Phase 14.1 stub: nothing is ignored. Replaced by a real `.gitignore`
 * evaluator in Phase 14.3. See `docs/adr/029-add-all-ignore-stub.md`.
 */
export const defaultIgnorePredicate: IgnorePredicate = () => false;
