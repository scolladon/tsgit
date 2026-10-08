/**
 * The one revisit-guarded peel walker. Every peel — commit/tag chains down to
 * a tree (`readTree`, `diff-trees.ts`'s `peelToTree`), a ref's annotated-tag
 * chain (`resolveRef`'s `peel`, `peelRefToCommit`, `name-rev`'s tips) and the
 * rev grammar's `<rev>^{<type>}` (`peel.ts`) — walks a chain to its terminal
 * object, to any depth as git does, and ends early only on a revisited object
 * (which only a store whose objects do not hash to their names can hold) or a
 * caller's hop cap. Callers supply the policy: how each link is read (strict
 * or gentle, raw or parsed), which link a hop leaves (`nextHop`), how deep it
 * may go, and what an early end means to them.
 */

import type { GitObject, ObjectId } from '../../../domain/objects/index.js';
import { refChainTooDeep } from '../../../domain/refs/error.js';
import type { Context } from '../../../ports/context.js';
import { exceedsMaxPeelDepth } from '../validators.js';

export interface PeelOutcome<T> {
  readonly id: ObjectId;
  readonly result: T;
}

/** Why the walk stopped: a terminal link, a revisited link, or the caller's hop cap. */
export type PeelEnd = 'reached' | 'revisited' | 'too-deep';

export interface PeelWalk<T> extends PeelOutcome<T> {
  readonly end: PeelEnd;
  /** The links whose hop was taken, outermost first — `id`/`result` is never among them. */
  readonly crossed: readonly T[];
}

export type PeelRead<T> = (id: ObjectId) => Promise<T>;
export type PeelHop<T> = (result: T, currentId: ObjectId) => ObjectId | undefined;

/** Which crossed annotated tag's tagger date a ref ranking keeps. */
export type TaggerDatePick = 'outermost' | 'innermost';

export interface TagChainPeel<T> {
  /** The last link loaded: the terminal object, or the tag whose target was revisited. */
  readonly object: T;
  /** A tag was crossed: the start named an annotated tag, not what it peels to. */
  readonly deref: boolean;
  /** The picked crossed tag's tagger timestamp; `0` when no tag was crossed. */
  readonly taggerDate: number;
}

const UNCAPPED = Number.POSITIVE_INFINITY;

export async function walkPeelChain<T>(
  start: PeelOutcome<T>,
  read: PeelRead<T>,
  nextHop: PeelHop<T>,
  maxHops: number = UNCAPPED,
): Promise<PeelWalk<T>> {
  const seen = new Set<ObjectId>([start.id]);
  const crossed: T[] = [];
  let { id, result } = start;
  for (;;) {
    const next = nextHop(result, id);
    if (next === undefined) return { end: 'reached', id, result, crossed };
    if (seen.has(next)) return { end: 'revisited', id, result, crossed };
    if (exceedsMaxPeelDepth(seen.size, maxHops)) return { end: 'too-deep', id, result, crossed };
    seen.add(next);
    crossed.push(result);
    id = next;
    result = await read(id);
  }
}

/** {@link walkPeelChain} from `startId`, refusing `REF_CHAIN_TOO_DEEP` on an early end. */
export async function peelChain<T>(
  ctx: Context,
  startId: ObjectId,
  read: (ctx: Context, id: ObjectId) => Promise<T>,
  nextHop: PeelHop<T>,
  maxHops: number = UNCAPPED,
): Promise<PeelOutcome<T>> {
  const readLink: PeelRead<T> = (id) => read(ctx, id);
  const start = { id: startId, result: await readLink(startId) };
  const walk = await walkPeelChain(start, readLink, nextHop, maxHops);
  if (walk.end !== 'reached') throw refChainTooDeep(walk.crossed.length + 1, []);
  return { id: walk.id, result: walk.result };
}

/** An annotated tag hops to the object it names; anything else ends the chain. */
export const tagHop = (object: GitObject | undefined): ObjectId | undefined =>
  object?.type === 'tag' ? object.data.object : undefined;

/** Peel `start` through its annotated-tag chain, keeping the `pick`ed tag's tagger date. */
export async function peelTagChain<T extends GitObject | undefined>(
  start: PeelOutcome<T>,
  read: PeelRead<T>,
  pick: TaggerDatePick,
): Promise<TagChainPeel<T>> {
  const walk = await walkPeelChain(start, read, tagHop);
  const tag = pick === 'outermost' ? walk.crossed[0] : walk.crossed.at(-1);
  const deref = walk.crossed.length > 0;
  return { object: walk.result, deref, taggerDate: taggerDateOf(tag) };
}

const taggerDateOf = (object: GitObject | undefined): number =>
  object?.type === 'tag' ? (object.data.tagger?.timestamp ?? 0) : 0;
