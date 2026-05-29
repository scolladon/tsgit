import type { Context } from '../../../ports/context.js';
import {
  type BranchCreateInput,
  type BranchCreateResult,
  type BranchDeleteInput,
  type BranchDeleteResult,
  type BranchListResult,
  type BranchRenameInput,
  type BranchRenameResult,
  branchCreate,
  branchDelete,
  branchList,
  branchRename,
} from '../branch.js';

/**
 * The nested-namespace surface for `repo.branch.*`. Each method runs the
 * caller-supplied `guard()` first (so a disposed repository throws before any
 * work) and then forwards to the corresponding context-aware command in
 * `commands/branch.ts`.
 */
export interface BranchNamespace {
  readonly list: () => Promise<BranchListResult>;
  readonly create: (input: BranchCreateInput) => Promise<BranchCreateResult>;
  readonly delete: (input: BranchDeleteInput) => Promise<BranchDeleteResult>;
  readonly rename: (input: BranchRenameInput) => Promise<BranchRenameResult>;
}

/**
 * Bind the `repo.branch.*` nested-namespace dispatcher. `guard()` is the
 * lifecycle gate (typically the disposed/closed check from `openRepository`);
 * it is invoked before every method forwards to its underlying command.
 *
 * The returned object is frozen — callers cannot monkey-patch methods onto
 * the namespace at runtime.
 */
export const bindBranchNamespace = (ctx: Context, guard: () => void): BranchNamespace => {
  const ns: BranchNamespace = {
    list: () => {
      guard();
      return branchList(ctx);
    },
    create: (input) => {
      guard();
      return branchCreate(ctx, input);
    },
    delete: (input) => {
      guard();
      return branchDelete(ctx, input);
    },
    rename: (input) => {
      guard();
      return branchRename(ctx, input);
    },
  };
  return Object.freeze(ns);
};
