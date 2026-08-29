/**
 * The ONLY path for building a derived `Context`. Every call site that used
 * to hand-roll `Object.freeze({ ...ctx, someField: x })` goes through this
 * instead, so the cache-identity decision (keep the session, or mint a fresh
 * one) is made in one reviewable place rather than re-derived — and
 * potentially mis-derived — at every call site.
 *
 * A fresh session is a fresh identity for every cache keyed on
 * `Context['session']`: the derived Context starts every one of those caches
 * cold, exactly as if it were a brand new repository. Keeping the session
 * shares all of them with `ctx`.
 *
 * Two dimensions force a fresh session unconditionally:
 *
 * - the repository root changes — `changes.layout` is present AND its
 *   resolved common dir (`commonDirOf`) differs from `ctx.layout`'s. A
 *   worktree or main-checkout derivation changes `layout.gitDir` (a
 *   different ADMIN dir) but keeps the SAME common dir — same object store,
 *   same config, same refs — so those derivations keep the session and, with
 *   it, every commonDir-anchored cache (config, shallow set, commit graph,
 *   loose-oid fanout, pack registry, reftable stack, …). A submodule
 *   derivation's common dir genuinely differs — a different repository —
 *   so it gets a fresh session.
 * - the fs root set changes with no accompanying `layout` change — `changes.fs`
 *   present, `changes.layout` absent. No current derivation site does this;
 *   the conservative default for a hypothetical future one is a fresh
 *   session, since there is no `layout` to prove it is still the same
 *   repository.
 *
 * The hash algorithm is a fresh-session dimension IN GENERAL — an oid-keyed
 * cache is meaningless across a digest-width change — but exactly two
 * derivation sites (clone's and bundle-verify's peer-algorithm adoption)
 * swap the algorithm during bootstrap, before any oid-keyed cache holds an
 * entry, and pass `keepSessionAcrossHashChange: true` to say so — each
 * licensed by its own test proving the ordering. Every other hash-changing
 * derivation gets the default fresh session.
 */
import type { Context } from '../../ports/context.js';
import { createSession } from '../../ports/context.js';
import { commonDirOf } from './path-layout.js';

export interface DeriveContextOptions {
  /**
   * Keep the session despite a hash-algorithm change. Use ONLY when the
   * derivation provably happens before any oid-keyed cache is populated —
   * see this module's docstring.
   */
  readonly keepSessionAcrossHashChange?: boolean;
}

const crossesRepositoryBoundary = (ctx: Context, changes: Partial<Context>): boolean => {
  if (changes.layout !== undefined) {
    return commonDirOf(changes.layout) !== commonDirOf(ctx.layout);
  }
  return changes.fs !== undefined;
};

const crossesHashBoundary = (changes: Partial<Context>): boolean =>
  changes.hash !== undefined || changes.hashConfig !== undefined;

export function deriveContext(
  ctx: Context,
  changes: Partial<Context>,
  options: DeriveContextOptions = {},
): Context {
  const freshSession =
    crossesRepositoryBoundary(ctx, changes) ||
    (crossesHashBoundary(changes) && options.keepSessionAcrossHashChange !== true);
  return Object.freeze({
    ...ctx,
    ...changes,
    session: freshSession ? createSession() : ctx.session,
  });
}
