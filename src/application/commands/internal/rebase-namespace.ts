import type { Context } from '../../../ports/context.js';
import {
  type RebaseAbortResult,
  type RebaseResult,
  type RebaseRunInput,
  rebaseAbort,
  rebaseContinue,
  rebaseRun,
  rebaseSkip,
} from '../rebase.js';

/**
 * The nested-namespace surface for `repo.rebase.*` (ADR-181/192/230). Each method
 * runs the caller-supplied `guard()` first (so a disposed repository throws before
 * any work) and forwards to the Context-aware command. Frozen.
 */
export interface RebaseNamespace {
  readonly run: (input: RebaseRunInput) => Promise<RebaseResult>;
  readonly continue: () => Promise<RebaseResult>;
  readonly skip: () => Promise<RebaseResult>;
  readonly abort: () => Promise<RebaseAbortResult>;
}

export const bindRebaseNamespace = (ctx: Context, guard: () => void): RebaseNamespace => {
  const ns: RebaseNamespace = {
    run: (input) => {
      guard();
      return rebaseRun(ctx, input);
    },
    continue: () => {
      guard();
      return rebaseContinue(ctx);
    },
    skip: () => {
      guard();
      return rebaseSkip(ctx);
    },
    abort: () => {
      guard();
      return rebaseAbort(ctx);
    },
  };
  return Object.freeze(ns);
};
