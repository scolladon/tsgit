import type { Context } from '../../../ports/context.js';
import {
  type SparseCheckoutAddInput,
  type SparseCheckoutAppliedResult,
  type SparseCheckoutDisableInput,
  type SparseCheckoutListResult,
  type SparseCheckoutReapplyInput,
  type SparseCheckoutSetInput,
  sparseCheckoutAdd,
  sparseCheckoutDisable,
  sparseCheckoutList,
  sparseCheckoutReapply,
  sparseCheckoutSet,
} from '../sparse-checkout.js';

/**
 * The nested-namespace surface for `repo.sparseCheckout.*`. Each method runs
 * the caller-supplied `guard()` first (so a disposed repository throws before
 * any work) and then forwards to the corresponding context-aware command in
 * `commands/sparse-checkout.ts`.
 */
export interface SparseCheckoutNamespace {
  readonly list: () => Promise<SparseCheckoutListResult>;
  readonly set: (input: SparseCheckoutSetInput) => Promise<SparseCheckoutAppliedResult>;
  readonly add: (input: SparseCheckoutAddInput) => Promise<SparseCheckoutAppliedResult>;
  readonly reapply: (input?: SparseCheckoutReapplyInput) => Promise<SparseCheckoutAppliedResult>;
  readonly disable: (input?: SparseCheckoutDisableInput) => Promise<SparseCheckoutAppliedResult>;
}

/**
 * Bind the `repo.sparseCheckout.*` nested-namespace dispatcher. `guard()` is
 * the lifecycle gate (typically the disposed/closed check from
 * `openRepository`); it is invoked before every method forwards to its
 * underlying command.
 *
 * The returned object is frozen — callers cannot monkey-patch methods onto
 * the namespace at runtime.
 */
export const bindSparseCheckoutNamespace = (
  ctx: Context,
  guard: () => void,
): SparseCheckoutNamespace => {
  const ns: SparseCheckoutNamespace = {
    list: () => {
      guard();
      return sparseCheckoutList(ctx);
    },
    set: (input) => {
      guard();
      return sparseCheckoutSet(ctx, input);
    },
    add: (input) => {
      guard();
      return sparseCheckoutAdd(ctx, input);
    },
    reapply: (input) => {
      guard();
      return sparseCheckoutReapply(ctx, input);
    },
    disable: (input) => {
      guard();
      return sparseCheckoutDisable(ctx, input);
    },
  };
  return Object.freeze(ns);
};
