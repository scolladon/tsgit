import type { Context } from '../../../ports/context.js';
import {
  type CherryPickAbortResult,
  type CherryPickContinueInput,
  type CherryPickResult,
  type CherryPickRunInput,
  cherryPickAbort,
  cherryPickContinue,
  cherryPickRun,
  cherryPickSkip,
} from '../cherry-pick.js';

/**
 * The nested-namespace surface for `repo.cherryPick.*` (ADR-181/192/210). Each
 * method runs the caller-supplied `guard()` first (so a disposed repository
 * throws before any work) and forwards to the Context-aware command. Frozen.
 */
export interface CherryPickNamespace {
  readonly run: (input: CherryPickRunInput) => Promise<CherryPickResult>;
  readonly continue: (input?: CherryPickContinueInput) => Promise<CherryPickResult>;
  readonly skip: (input?: CherryPickContinueInput) => Promise<CherryPickResult>;
  readonly abort: () => Promise<CherryPickAbortResult>;
}

export const bindCherryPickNamespace = (ctx: Context, guard: () => void): CherryPickNamespace => {
  const ns: CherryPickNamespace = {
    run: (input) => {
      guard();
      return cherryPickRun(ctx, input);
    },
    continue: (input) => {
      guard();
      return cherryPickContinue(ctx, input);
    },
    skip: (input) => {
      guard();
      return cherryPickSkip(ctx, input);
    },
    abort: () => {
      guard();
      return cherryPickAbort(ctx);
    },
  };
  return Object.freeze(ns);
};
