import type { Context } from '../../../ports/context.js';
import {
  type RevertAbortResult,
  type RevertResult,
  type RevertRunInput,
  revertAbort,
  revertContinue,
  revertRun,
  revertSkip,
} from '../revert.js';

/**
 * The nested-namespace surface for `repo.revert.*` (ADR-181/192/210/217 lineage).
 * Each method runs the caller-supplied `guard()` first (so a disposed repository
 * throws before any work) and forwards to the Context-aware command. Frozen.
 * `continue` / `skip` take no arguments — revert has no resume-time options.
 */
export interface RevertNamespace {
  readonly run: (input: RevertRunInput) => Promise<RevertResult>;
  readonly continue: () => Promise<RevertResult>;
  readonly skip: () => Promise<RevertResult>;
  readonly abort: () => Promise<RevertAbortResult>;
}

export const bindRevertNamespace = (ctx: Context, guard: () => void): RevertNamespace => {
  const ns: RevertNamespace = {
    run: (input) => {
      guard();
      return revertRun(ctx, input);
    },
    continue: () => {
      guard();
      return revertContinue(ctx);
    },
    skip: () => {
      guard();
      return revertSkip(ctx);
    },
    abort: () => {
      guard();
      return revertAbort(ctx);
    },
  };
  return Object.freeze(ns);
};
