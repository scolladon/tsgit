import type { Context } from '../../../ports/context.js';
import type { StashDropResult } from '../../primitives/stash-ref.js';
import {
  type StashApplyInput,
  type StashApplyResult,
  type StashDropInput,
  type StashListResult,
  type StashPopResult,
  type StashPushInput,
  type StashPushResult,
  stashApply,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
} from '../stash.js';

/**
 * The nested-namespace surface for `repo.stash.*` (ADR-181 / ADR-192). Each
 * method runs the caller-supplied `guard()` first (so a disposed repository
 * throws before any work) and then forwards to the corresponding Context-aware
 * command in `commands/stash.ts`. The returned object is frozen.
 */
export interface StashNamespace {
  readonly push: (input?: StashPushInput) => Promise<StashPushResult>;
  readonly list: () => Promise<StashListResult>;
  readonly apply: (input?: StashApplyInput) => Promise<StashApplyResult>;
  readonly pop: (input?: StashApplyInput) => Promise<StashPopResult>;
  readonly drop: (input?: StashDropInput) => Promise<StashDropResult>;
}

export const bindStashNamespace = (ctx: Context, guard: () => void): StashNamespace => {
  const ns: StashNamespace = {
    push: (input) => {
      guard();
      return stashPush(ctx, input);
    },
    list: () => {
      guard();
      return stashList(ctx);
    },
    apply: (input) => {
      guard();
      return stashApply(ctx, input);
    },
    pop: (input) => {
      guard();
      return stashPop(ctx, input);
    },
    drop: (input) => {
      guard();
      return stashDrop(ctx, input);
    },
  };
  return Object.freeze(ns);
};
