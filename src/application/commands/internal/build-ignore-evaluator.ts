/**
 * @deprecated — Source of truth moved to `primitives/internal/ignore-evaluator.ts`.
 * This shim keeps the existing command imports working; new callers should
 * import from the primitives location.
 */
export type { IgnoreEvaluator } from '../../primitives/internal/ignore-evaluator.js';
export {
  buildIgnoreEvaluator,
  buildRepoIgnorePredicate,
} from '../../primitives/internal/ignore-evaluator.js';
