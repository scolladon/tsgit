import type { TreeSnapshot } from './snapshot.js';

/**
 * A point-in-time view of a stash entry. The trio (index, workdir,
 * untracked) is exposed as plain properties — discoverable at hand-out
 * time, not behind a method (ADR-156 + design §9.1).
 *
 * `untracked` is `null` when the stash was created without
 * `--include-untracked`. Consumers branch on the property's value, not
 * on whether a method exists.
 */
export interface StashSnapshot {
  readonly kind: 'stash';
  readonly index: TreeSnapshot;
  readonly workdir: TreeSnapshot;
  readonly untracked: TreeSnapshot | null;
}

export const createStashSnapshot = (parts: {
  readonly index: TreeSnapshot;
  readonly workdir: TreeSnapshot;
  readonly untracked: TreeSnapshot | null;
}): StashSnapshot => ({ kind: 'stash', ...parts });
