import type { Context } from '../../../ports/context.js';
import {
  type SubmoduleInitOptions,
  type SubmoduleInitResult,
  type SubmoduleListOptions,
  type SubmoduleListResult,
  type SubmoduleSyncOptions,
  type SubmoduleSyncResult,
  submoduleInit,
  submoduleList,
  submoduleSync,
} from '../submodule.js';

/**
 * The nested-namespace surface for `repo.submodule.*`. Each method runs the
 * caller-supplied `guard()` first (so a disposed repository throws before any
 * work) and then forwards to the corresponding context-aware command in
 * `commands/submodule.ts`.
 */
export interface SubmoduleNamespace {
  readonly list: (opts?: SubmoduleListOptions) => Promise<SubmoduleListResult>;
  readonly init: (opts?: SubmoduleInitOptions) => Promise<SubmoduleInitResult>;
  readonly sync: (opts?: SubmoduleSyncOptions) => Promise<SubmoduleSyncResult>;
}

/**
 * Bind the `repo.submodule.*` nested-namespace dispatcher. `guard()` is the
 * lifecycle gate (typically the disposed/closed check from `openRepository`);
 * it is invoked before every method forwards to its underlying command. The
 * returned object is frozen — callers cannot monkey-patch the namespace.
 */
export const bindSubmoduleNamespace = (ctx: Context, guard: () => void): SubmoduleNamespace => {
  const ns: SubmoduleNamespace = {
    list: (opts) => {
      guard();
      return submoduleList(ctx, opts);
    },
    init: (opts) => {
      guard();
      return submoduleInit(ctx, opts);
    },
    sync: (opts) => {
      guard();
      return submoduleSync(ctx, opts);
    },
  };
  return Object.freeze(ns);
};
