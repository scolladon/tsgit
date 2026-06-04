import type { Context } from '../../../ports/context.js';
import { type MergeAbortResult, mergeAbort } from '../abort-merge.js';
import {
  type MergeContinueInput,
  type MergeContinueResult,
  mergeContinue,
} from '../continue-merge.js';
import { type MergeResult, type MergeRunInput, mergeRun } from '../merge.js';

/**
 * The nested-namespace surface for `repo.merge.*` (ADR-181/192/263). Each method
 * runs the caller-supplied `guard()` first (so a disposed repository throws
 * before any work) and forwards to the Context-aware command. Frozen.
 *
 * There is no `skip` verb — a merge applies a single integration, so the verbs
 * are `run` / `continue` / `abort` (git `merge` / `merge --continue` /
 * `merge --abort`). `run` never exposes `merge`'s internal reflog-action channel.
 */
export interface MergeNamespace {
  readonly run: (input: MergeRunInput) => Promise<MergeResult>;
  readonly continue: (input?: MergeContinueInput) => Promise<MergeContinueResult>;
  readonly abort: () => Promise<MergeAbortResult>;
}

export const bindMergeNamespace = (ctx: Context, guard: () => void): MergeNamespace => {
  const ns: MergeNamespace = {
    run: (input) => {
      guard();
      return mergeRun(ctx, input);
    },
    continue: (input) => {
      guard();
      return mergeContinue(ctx, input);
    },
    abort: () => {
      guard();
      return mergeAbort(ctx);
    },
  };
  return Object.freeze(ns);
};
