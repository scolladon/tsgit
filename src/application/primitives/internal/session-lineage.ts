import type { Session } from '../../../ports/context.js';

/**
 * Which sessions a session minted while it was alive. A derived context
 * that crosses a repository boundary (a submodule's git dir, an alternate
 * donor, a clone target) gets its own session and, with it, its own object
 * store and pack handles. Nothing else holds those children: the derived
 * context is a local of the operation that built it, so the only owner
 * that can still release their handles is the parent session's disposal.
 */
const childrenOf = new WeakMap<Session, Set<Session>>();

/** Records `child` as minted by `parent`, so disposing the parent reaches it. */
export const adoptSession = (parent: Session, child: Session): void => {
  const children = childrenOf.get(parent);
  if (children === undefined) {
    childrenOf.set(parent, new Set([child]));
    return;
  }
  children.add(child);
};

/** Every session `parent` minted, nearest first; a session minted twice is listed once. */
export const sessionsMintedBy = (parent: Session): ReadonlyArray<Session> => [
  ...(childrenOf.get(parent) ?? []),
];
