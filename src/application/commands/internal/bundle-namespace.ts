import type { Context } from '../../../ports/context.js';
import {
  type BundleCreateOptions,
  type BundleCreateResult,
  bundleCreate,
} from '../bundle-create.js';
import {
  type BundleListHeadsInput,
  type BundleListHeadsResult,
  bundleListHeads,
} from '../bundle-list-heads.js';
import { type BundleVerifyInput, type BundleVerifyResult, bundleVerify } from '../bundle-verify.js';

/**
 * Nested-namespace surface for `repo.bundle.{create,verify,listHeads}`. Each
 * method runs the caller-supplied `guard()` first (so a disposed repository
 * throws before any work) and then forwards to the context-aware command.
 * Frozen.
 */
export interface BundleNamespace {
  readonly create: (opts: BundleCreateOptions) => Promise<BundleCreateResult>;
  readonly verify: (input: BundleVerifyInput) => Promise<BundleVerifyResult>;
  readonly listHeads: (input: BundleListHeadsInput) => Promise<BundleListHeadsResult>;
}

/**
 * Bind the `repo.bundle.*` nested-namespace dispatcher. `guard()` is the
 * lifecycle gate (typically the disposed/closed check from `openRepository`);
 * it is invoked before every method forwards to its underlying command.
 *
 * The returned object is frozen — callers cannot monkey-patch methods onto
 * the namespace at runtime.
 */
export const bindBundleNamespace = (ctx: Context, guard: () => void): BundleNamespace => {
  const ns: BundleNamespace = {
    create: (opts) => {
      guard();
      return bundleCreate(ctx, opts);
    },
    verify: (input) => {
      guard();
      return bundleVerify(ctx, input);
    },
    listHeads: (input) => {
      guard();
      return bundleListHeads(ctx, input);
    },
  };
  return Object.freeze(ns);
};
