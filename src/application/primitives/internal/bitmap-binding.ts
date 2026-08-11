/**
 * The shared bitmap-tier closure algorithm — resolves `W AND NOT N` over a
 * validated `LoadedBitmapArtefact`, indifferent to which of the two
 * flavours produced it: a pack's own `.bitmap` (`pack-bitmap-binding.ts`)
 * or a multi-pack-index's `.bitmap` (`midx-bitmap-binding.ts`). Both
 * flavours share every function in this module — and, before any of it, the
 * load/parse/range-validate pipeline `bitmap-container.ts` holds, which both
 * loaders call with their own I/O interleaved between its steps. They differ
 * in exactly the two mapping functions `LoadedBitmapArtefact` declares:
 * `resolveOwnPosition` (an oid to the position an entry header's own
 * `position` field would carry for it) and `oidAtBitPosition` (a
 * reachability bit to an oid). For a pack bitmap both run through the
 * pack's own `.idx`; for a midx bitmap both run through the midx's OIDL and
 * its reverse-index chunk, with no pack access at all.
 *
 * Position mapping and range validation run entirely inside a flavour's own
 * loader, and in that order: every position a bitmap decodes is checked
 * against the indexed artefact's own object count BEFORE `resolveOwnPosition`
 * or `oidAtBitPosition` is ever built or called, so nothing in this module
 * ever sees an out-of-range position.
 */
import { TsgitError } from '../../../domain/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { BitmapEntryHeader, PackBitmap } from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';
import { MAX_PUSH_OBJECTS } from '../types.js';
import { isGitlink } from '../validators.js';
import { walkTree } from '../walk-tree.js';
import {
  createReconstructionContext,
  orInto,
  type ReconstructionContext,
  reconstructEntry,
} from './bitmap-reconstruct.js';
import { resolveTagChain } from './object-emit.js';

export interface BitmapClosureRequest {
  readonly wants: ReadonlyArray<ObjectId>;
  readonly not: ReadonlyArray<ObjectId>;
  /** Include trees and blobs, not just commits and tags. */
  readonly objects: boolean;
}

export interface BitmapClosureObject {
  readonly id: ObjectId;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
}

/**
 * The shape both bitmap flavours produce once loaded and range-validated,
 * and the only shape the closure algorithm below ever sees — neither a
 * `RegisteredPack` nor a `MultiPackIndex` crosses past a flavour's own
 * loader. `resolveOwnPosition` and `oidAtBitPosition` are the two mapping
 * functions the module doc calls out; everything else here is generic
 * bookkeeping a loader builds once, at load time, from those two mappings.
 */
export interface LoadedBitmapArtefact {
  readonly artefactName: string;
  readonly bitmap: PackBitmap;
  readonly headers: ReadonlyArray<BitmapEntryHeader>;
  readonly objectCount: number;
  readonly laneCount: number;
  /** One folded, range-proved bit array per type stream, commits/trees/blobs/tags. */
  readonly typeBits: readonly [Uint32Array, Uint32Array, Uint32Array, Uint32Array];
  /**
   * oid -> the position an entry header's own `position` field carries for
   * it: an INDEX position for a pack bitmap, a MIDX position for a midx
   * bitmap. `undefined` when the indexed artefact does not carry this oid
   * at all. A SEARCH, never a materialised map: the tier resolves a handful
   * of tips, not every object the artefact carries.
   */
  readonly resolveOwnPosition: (oid: ObjectId) => number | undefined;
  /** own-position -> entry index, built once from `headers`. */
  readonly entryByOwnPosition: ReadonlyMap<number, number>;
  /**
   * own-position -> reachability bit position: a PACK position for a pack
   * bitmap, a PSEUDO-PACK position for a midx bitmap. The one inverse
   * mapping the closure genuinely needs, proved a permutation of
   * `[0, objectCount)` by `invertPositions` before the artefact exists.
   */
  readonly ownPositionToBitPosition: Uint32Array;
  /**
   * reachability bit position -> oid, resolved LAZILY at emit time — through
   * the pack's `.idx` for a pack bitmap, the midx's OIDL for a midx bitmap.
   * `undefined` when the artefact's own position table does not name that
   * bit, which the emit loop skips rather than pushing an id-less object.
   */
  readonly oidAtBitPosition: (bitPosition: number) => ObjectId | undefined;
}

/** Pack-flavour alias: same shape, kept distinct so a call site's own type
 *  still documents which artefact it expects. */
export type LoadedPackBitmap = LoadedBitmapArtefact;

const WORD_BITS = 32;
const FULL_LANE = 0xffffffff;

function setBit(bits: Uint32Array, position: number): void {
  const lane = position >>> 5;
  bits[lane] = (bits[lane]! | (1 << (position & 31))) >>> 0;
}

function bitIsSet(bits: Uint32Array, position: number): boolean {
  return ((bits[position >>> 5]! >>> (position & 31)) & 1) === 1;
}

/** Objects the partial walk reaches that the artefact has no position for
 *  (another pack, a loose object) — appended after `objectCount` in the
 *  engine's own bit space, deduplicated by oid, capped like every other
 *  reachability enumerator in this codebase. Shared across a `wants` and a
 *  `not` fill within the SAME closure call, so the same oid always resolves
 *  to the same extended index on both sides. */
interface ExtendedPositions {
  readonly indexByOid: Map<ObjectId, number>;
  readonly oids: ObjectId[];
}

function getOrAssignExtended(extended: ExtendedPositions, oid: ObjectId): number {
  const existing = extended.indexByOid.get(oid);
  if (existing !== undefined) return existing;
  if (extended.oids.length >= MAX_PUSH_OBJECTS) {
    throw new TsgitError({
      code: 'PACK_TOO_LARGE',
      objectCount: extended.oids.length + 1,
      limit: MAX_PUSH_OBJECTS,
    });
  }
  const index = extended.oids.length;
  extended.oids.push(oid);
  extended.indexByOid.set(oid, index);
  return index;
}

interface FillState {
  readonly bits: Uint32Array;
  readonly extended: Set<number>;
}

/** Resolves `oid` to a bit — a reachability bit position when the artefact
 *  names it, else a shared extended position — and sets it in `state`. The
 *  table read is folded into the same `undefined` test the own-position
 *  lookup already needs, so an oid the position table cannot place lands in
 *  the extended space (where it is resolved by oid) instead of coercing to
 *  bit 0. */
function markPosition(
  artefact: LoadedBitmapArtefact,
  extended: ExtendedPositions,
  state: FillState,
  oid: ObjectId,
): void {
  const ownPosition = artefact.resolveOwnPosition(oid);
  const bitPosition =
    ownPosition === undefined ? undefined : artefact.ownPositionToBitPosition[ownPosition];
  if (bitPosition !== undefined) {
    setBit(state.bits, bitPosition);
    return;
  }
  state.extended.add(getOrAssignExtended(extended, oid));
}

/** `entryFor`: `commitOid`'s bitmap entry, when the artefact indexes the
 *  object and the bitmap has an entry for it. */
function entryFor(artefact: LoadedBitmapArtefact, commitOid: ObjectId): number | undefined {
  const ownPosition = artefact.resolveOwnPosition(commitOid);
  if (ownPosition === undefined) return undefined;
  return artefact.entryByOwnPosition.get(ownPosition);
}

/** Marks `treeId` and every non-gitlink descendant it reaches — the
 *  `objects`-side walk a pending commit (one with no bitmap entry) falls
 *  back to, mirroring the walk tier's own tree recursion via `walkTree`. */
async function markTreeBits(
  ctx: Context,
  artefact: LoadedBitmapArtefact,
  extended: ExtendedPositions,
  state: FillState,
  treeId: ObjectId,
): Promise<void> {
  markPosition(artefact, extended, state, treeId);
  for await (const entry of walkTree(ctx, treeId)) {
    if (isGitlink(entry.mode)) continue;
    markPosition(artefact, extended, state, entry.id);
  }
}

/**
 * Walks `seeds` (already-peeled commit oids) and their ancestry,
 * ITERATIVELY: a commit with a bitmap entry contributes its reconstructed
 * set and is NOT traversed further; otherwise its own bit is set (and,
 * under `objects`, its own tree) and its parents are enqueued.
 */
async function walkPendingCommits(
  ctx: Context,
  artefact: LoadedBitmapArtefact,
  extended: ExtendedPositions,
  rc: ReconstructionContext,
  state: FillState,
  seeds: ReadonlyArray<ObjectId>,
  objects: boolean,
): Promise<void> {
  const visited = new Set<ObjectId>();
  const queue: ObjectId[] = [...seeds];
  // Head cursor, never `shift()`: draining a repo-sized frontier one shift at
  // a time re-indexes the whole queue per step, O(n²) in its own length.
  let head = 0;
  while (head < queue.length) {
    const id = queue[head]!;
    head += 1;
    if (visited.has(id)) continue;
    visited.add(id);

    const entryIndex = entryFor(artefact, id);
    if (entryIndex !== undefined) {
      orInto(state.bits, reconstructEntry(rc, entryIndex));
      continue;
    }

    markPosition(artefact, extended, state, id);
    const commit = await readObject(ctx, id);
    if (commit.type !== 'commit') continue;
    if (objects) await markTreeBits(ctx, artefact, extended, state, commit.data.tree);
    for (const parentId of commit.data.parents) {
      if (!visited.has(parentId)) queue.push(parentId);
    }
  }
}

/**
 * `fill(tips)`: peels tags (each tag oid joins the result directly),
 * resolves a tree/blob tip on the spot (itself, plus its own subtree for a
 * tree), and hands every peeled commit to the pending-commit walk. Returns
 * the bit set — in-artefact positions plus this call's own extended
 * positions — reachable from `tips`.
 */
async function fill(
  ctx: Context,
  artefact: LoadedBitmapArtefact,
  extended: ExtendedPositions,
  rc: ReconstructionContext,
  tips: ReadonlyArray<ObjectId>,
  objects: boolean,
): Promise<FillState> {
  const state: FillState = { bits: new Uint32Array(artefact.laneCount), extended: new Set() };
  const commitSeeds: ObjectId[] = [];

  for (const tip of tips) {
    const peeled = await resolveTagChain(ctx, tip, (tagId) =>
      markPosition(artefact, extended, state, tagId),
    );
    const obj = await readObject(ctx, peeled);
    if (obj.type === 'commit') {
      commitSeeds.push(peeled);
      continue;
    }
    if (obj.type === 'tree') {
      await markTreeBits(ctx, artefact, extended, state, peeled);
      continue;
    }
    markPosition(artefact, extended, state, peeled);
  }

  await walkPendingCommits(ctx, artefact, extended, rc, state, commitSeeds, objects);
  return state;
}

/** commits, trees, blobs — checked explicitly; tags is the fallthrough, so
 *  a position claimed by no OTHER stream is read as a tag rather than
 *  refused, matching the four streams' total-partition guarantee without a
 *  fourth, always-redundant bit test. */
function typeOfPosition(
  artefact: LoadedBitmapArtefact,
  position: number,
): BitmapClosureObject['type'] {
  if (bitIsSet(artefact.typeBits[0], position)) return 'commit';
  if (bitIsSet(artefact.typeBits[1], position)) return 'tree';
  if (bitIsSet(artefact.typeBits[2], position)) return 'blob';
  return 'tag';
}

/** A bitmap entry's reconstructed set is the commit's WHOLE reachable
 *  closure (commits, trees and blobs together — a bitmap has no
 *  "commits-only" sub-answer), so the `objects` gate is enforced here, at
 *  the very end, exactly as git's own per-type output loop enforces it:
 *  commits and tags are always shown; trees and blobs only under
 *  `objects`, matching the walk tier's own commits-and-tags default. */
function isIncludedType(type: BitmapClosureObject['type'], objects: boolean): boolean {
  return objects || type === 'commit' || type === 'tag';
}

/**
 * Resolves `request` against a validated bitmap artefact — a pack bitmap or
 * a midx bitmap, indistinguishable from here on: `W = fill(wants)`,
 * `N = fill(not)`, `W AND NOT N` over in-artefact positions plus the
 * set-difference of each fill's own extended positions. `path` is never
 * produced — the artefact has none.
 */
export async function resolveBitmapClosure(
  ctx: Context,
  artefact: LoadedBitmapArtefact,
  request: BitmapClosureRequest,
): Promise<ReadonlyArray<BitmapClosureObject>> {
  const rc = createReconstructionContext(artefact.bitmap, artefact.headers, artefact.laneCount);
  const extended: ExtendedPositions = { indexByOid: new Map(), oids: [] };

  const wantState = await fill(ctx, artefact, extended, rc, request.wants, request.objects);
  const notState = await fill(ctx, artefact, extended, rc, request.not, request.objects);

  const results: BitmapClosureObject[] = [];
  emitInArtefactPositions(artefact, wantState, notState, request.objects, results);
  for (const extIndex of wantState.extended) {
    if (notState.extended.has(extIndex)) continue;
    const oid = extended.oids[extIndex] as ObjectId;
    const obj = await readObject(ctx, oid);
    if (!isIncludedType(obj.type, request.objects)) continue;
    pushBounded(results, { id: oid, type: obj.type });
  }
  return results;
}

/** The same bound the extended-position path enforces, applied to the
 *  in-artefact half of the SAME result set — one closure, one limit. */
function pushBounded(results: BitmapClosureObject[], object: BitmapClosureObject): void {
  if (results.length >= MAX_PUSH_OBJECTS) {
    throw new TsgitError({
      code: 'PACK_TOO_LARGE',
      objectCount: results.length + 1,
      limit: MAX_PUSH_OBJECTS,
    });
  }
  results.push(object);
}

/** The bits of lane `lane` that name a real position — every bit for a whole
 *  lane, the low `objectCount % 32` for the last one. */
function laneMask(lane: number, objectCount: number): number {
  const remaining = objectCount - lane * WORD_BITS;
  return remaining >= WORD_BITS ? FULL_LANE : ((1 << remaining) - 1) >>> 0;
}

/**
 * `W AND NOT N` over the artefact's own bit space, WORD-wise: an all-zero
 * lane is skipped whole rather than tested bit by bit, and a non-zero lane
 * walks only the bits it actually sets (`word & -word` isolates the lowest,
 * `Math.clz32` names it). A repository-sized bitmap is overwhelmingly zero
 * outside the answer, so the per-bit scan this replaces spent `objectCount`
 * iterations to emit `|result|` objects.
 */
function emitInArtefactPositions(
  artefact: LoadedBitmapArtefact,
  wantState: FillState,
  notState: FillState,
  objects: boolean,
  results: BitmapClosureObject[],
): void {
  for (let lane = 0; lane < artefact.laneCount; lane += 1) {
    let word =
      (wantState.bits[lane]! & ~notState.bits[lane]! & laneMask(lane, artefact.objectCount)) >>> 0;
    while (word !== 0) {
      const lowestSetBit = word & -word;
      word = (word ^ lowestSetBit) >>> 0;
      const position = lane * WORD_BITS + (WORD_BITS - 1 - Math.clz32(lowestSetBit));
      const type = typeOfPosition(artefact, position);
      if (!isIncludedType(type, objects)) continue;
      const id = artefact.oidAtBitPosition(position);
      if (id === undefined) continue;
      pushBounded(results, { id, type });
    }
  }
}
