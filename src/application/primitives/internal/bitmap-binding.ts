/**
 * The shared bitmap-tier closure algorithm — resolves `W AND NOT N` over a
 * validated `LoadedBitmapArtefact`, indifferent to which of the two
 * flavours produced it: a pack's own `.bitmap` (`pack-bitmap-binding.ts`)
 * or a multi-pack-index's `.bitmap` (`midx-bitmap-binding.ts`). Both
 * flavours share every function in this module — including the load/parse/
 * range-validate pipeline (`usableBitmapBytes` + `validateBitmapContainer`,
 * themselves built on `bitmap-reconstruct.ts` and
 * `bitmap-range-validation.ts`) both loaders call, in that order, with their
 * own I/O interleaved exactly where it always was — and differ in exactly
 * the two mapping functions `LoadedBitmapArtefact` declares:
 * `resolveOwnPosition` (an oid to the position an entry header's own
 * `position` field would carry for it) and `oidAtBitPosition` (a
 * reachability bit to an oid). For a pack bitmap both run through the
 * pack's own `.idx`; for a midx bitmap both run through the midx's OIDL and
 * its reverse-index chunk, with no pack access at all.
 *
 * Position mapping and range validation run entirely inside a flavour's own
 * loader, and in that order: every position a bitmap decodes — entry
 * headers AND every set bit any of its streams declares — is checked against
 * the indexed artefact's own object count BEFORE `resolveOwnPosition` or
 * `oidAtBitPosition` is ever built or called. A violation declines the
 * WHOLE artefact, never just the offending entry, and is reported through
 * `ctx.logger?.warn?.`; the caller falls back to the next artefact in the
 * preference order, with nothing surfaced.
 */
import { TsgitError } from '../../../domain/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import {
  type BitmapEntryHeader,
  bitmapEntryHeaders,
  type PackBitmap,
  parsePackBitmap,
} from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';
import { MAX_PUSH_OBJECTS } from '../types.js';
import { isGitlink } from '../validators.js';
import { walkTree } from '../walk-tree.js';
import { laneCountFor, validateBitmapRanges } from './bitmap-range-validation.js';
import {
  createReconstructionContext,
  orInto,
  type ReconstructionContext,
  reconstructEntry,
} from './bitmap-reconstruct.js';
import { resolveTagChain } from './object-emit.js';
import type { ArtefactLoad } from './pack-artefact-source.js';
import { faultContext } from './pack-shared.js';

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

/** own-position -> entry index — identical construction for every flavour,
 *  since `BitmapEntryHeader.position` already carries whichever position
 *  space the flavour's own artefact uses. */
export function buildEntryByOwnPosition(
  headers: ReadonlyArray<BitmapEntryHeader>,
): ReadonlyMap<number, number> {
  return new Map(headers.map((header, i) => [header.position, i] as const));
}

/**
 * Inverts a bit-position -> own-position table (`positions[bitPosition] =
 * ownPosition`) into its own-position -> bit-position form, PROVING the
 * input is a permutation of `[0, n)` first. Shared by both flavours: a pack
 * bitmap inverts `packPositions` (index position at each pack position); a
 * midx bitmap inverts the reverse-index chunk (midx position at each
 * pseudo-pack position) — same shape either way.
 *
 * `undefined` — the caller's whole-artefact decline — whenever a stored
 * value is out of range or names a slot already claimed. A table that names
 * one own position twice necessarily leaves another unnamed (n values into n
 * slots), and an unnamed own position has NO bit: a `.rev` body storing 0
 * everywhere would otherwise leave a holey inverse, silently mark bit 0 for
 * every tip, and answer a wrong pack. Rejecting a duplicate therefore
 * rejects a hole too, with no separate pass.
 */
export function invertPositions(positions: Uint32Array): Uint32Array | undefined {
  const inverse = new Uint32Array(positions.length);
  const claimed = new Uint8Array(positions.length);
  for (const [bitPosition, ownPosition] of positions.entries()) {
    if (ownPosition >= positions.length || claimed[ownPosition] === 1) return undefined;
    claimed[ownPosition] = 1;
    inverse[ownPosition] = bitPosition;
  }
  return inverse;
}

export interface ParsedBitmapContainer {
  readonly bitmap: PackBitmap;
  readonly headers: ReadonlyArray<BitmapEntryHeader>;
}

/**
 * The one decline shape for a present-but-unusable artefact this module
 * recognises past the load: warn with the artefact's own name, return
 * `undefined` so the caller falls through to the next artefact in the
 * preference order with nothing surfaced.
 */
export function declineBitmap(ctx: Context, reason: string, artefactName: string): undefined {
  ctx.logger?.warn?.(`bitmapBinding: ${reason}`, { bitmap: artefactName });
  return undefined;
}

/**
 * Parses `bytes` as a bitmap container and its per-commit entry headers —
 * identical work for both flavours, since the CONTAINER format is the same
 * whether it indexes a pack or a midx; only what a decoded `position` MEANS
 * differs, and that is entirely a loader's own concern past this point.
 * Returns `undefined` on a structural parse refusal, having already logged
 * it with `artefactName` — the caller's decline signal, matching every
 * other present-but-faulty artefact this module recognises.
 */
export function parseBitmapContainer(
  ctx: Context,
  bytes: Uint8Array,
  artefactName: string,
  flavour: 'pack' | 'midx',
  objectCount: number,
): ParsedBitmapContainer | undefined {
  try {
    const bitmap = parsePackBitmap(bytes, ctx.hashConfig.digestLength);
    // Canonical git never writes more per-commit entries than the artefact
    // has objects — one entry names one commit, and every commit is an
    // object — so refusing here refuses nothing git reads. Checked BEFORE
    // the entry walk, so a hostile 32-bit `entryCount` never gets to
    // allocate a header per declared entry.
    if (bitmap.entryCount > objectCount) {
      return declineBitmap(
        ctx,
        `${flavour} bitmap declares more entries than the artefact has objects, declining`,
        artefactName,
      );
    }
    return { bitmap, headers: bitmapEntryHeaders(bitmap) };
  } catch (err) {
    if (!(err instanceof TsgitError) || err.data.code !== 'INVALID_PACK_BITMAP') throw err;
    ctx.logger?.warn?.(`bitmapBinding: discarding unusable ${flavour} bitmap`, {
      bitmap: artefactName,
      ...faultContext(err.data),
    });
    return undefined;
  }
}

/**
 * Resolves a load outcome to usable bytes, or `undefined` for the caller to
 * decline and fall back to the next artefact in the preference order —
 * silently for absent/unreadable, with one `ctx.logger?.warn?.` for a
 * refused load. Identical for both flavours past the load outcome itself;
 * only the message's flavour word differs. Takes no I/O of its own, so a
 * caller that has not yet fetched what it needs to validate against (a
 * pack's `.idx`, say) is free to keep that fetch AFTER this call, exactly as
 * before this function existed.
 */
export function usableBitmapBytes(
  ctx: Context,
  flavour: 'pack' | 'midx',
  artefactName: string,
  load: ArtefactLoad<Uint8Array>,
): Uint8Array | undefined {
  if (load.kind === 'absent' || load.kind === 'unreadable') return undefined;
  if (load.kind === 'refused') {
    ctx.logger?.warn?.(`bitmapBinding: discarding unusable ${flavour} bitmap`, {
      bitmap: artefactName,
      ...faultContext(load.data),
    });
    return undefined;
  }
  return load.bytes;
}

export interface ValidatedBitmapContainer {
  readonly bitmap: PackBitmap;
  readonly headers: ReadonlyArray<BitmapEntryHeader>;
  readonly objectCount: number;
  readonly laneCount: number;
  readonly typeBits: readonly [Uint32Array, Uint32Array, Uint32Array, Uint32Array];
}

/**
 * Validated containers keyed by the exact bytes they were validated from.
 * Both flavours' byte loads are already memoised — per pack for a `.bitmap`,
 * per generation for a midx's — so the key is stable for as long as the
 * artefact is, and one closure at the bitmap tier pays the parse, the entry
 * walk and the range validation for every later one. A `refresh()` produces
 * new bytes, and the entry keyed on the old ones dies with them. Only
 * ACCEPTED containers are held: a decline must keep warning once per
 * attempt, exactly as it did before this memo existed.
 */
const validatedContainers = new WeakMap<Uint8Array, ValidatedBitmapContainer>();

/**
 * Parses `bytes` and range-validates the result against `objectCount` —
 * identical work for both flavours (see this module's own doc), taken once
 * a caller has `bytes` (from `usableBitmapBytes`) and its own artefact's
 * object count in hand. Returns `undefined` for the caller to decline — a
 * structural parse refusal and an over-long entry table both warn inside
 * `parseBitmapContainer` itself, an out-of-range position warns here, with
 * one `ctx.logger?.warn?.` whichever fires.
 */
export function validateBitmapContainer(
  ctx: Context,
  flavour: 'pack' | 'midx',
  artefactName: string,
  bytes: Uint8Array,
  objectCount: number,
): ValidatedBitmapContainer | undefined {
  const memoised = validatedContainers.get(bytes);
  if (memoised !== undefined) return memoised;

  const parsed = parseBitmapContainer(ctx, bytes, artefactName, flavour, objectCount);
  if (parsed === undefined) return undefined;
  const { bitmap, headers } = parsed;

  const validated = validateBitmapRanges(bitmap, headers, objectCount);
  if (validated === undefined) {
    return declineBitmap(ctx, `${flavour} bitmap position out of range, declining`, artefactName);
  }

  const container: ValidatedBitmapContainer = {
    bitmap,
    headers,
    objectCount,
    laneCount: laneCountFor(objectCount),
    typeBits: validated.typeBits,
  };
  validatedContainers.set(bytes, container);
  return container;
}

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
