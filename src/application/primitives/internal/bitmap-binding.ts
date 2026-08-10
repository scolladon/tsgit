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
 * headers AND every set bit a folded stream yields — is checked against the
 * indexed artefact's own object count BEFORE `resolveOwnPosition` or
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
   * at all.
   */
  readonly resolveOwnPosition: (oid: ObjectId) => number | undefined;
  /** own-position -> entry index, built once from `headers`. */
  readonly entryByOwnPosition: ReadonlyMap<number, number>;
  /**
   * own-position -> reachability bit position: a PACK position for a pack
   * bitmap, a PSEUDO-PACK position for a midx bitmap.
   */
  readonly ownPositionToBitPosition: ReadonlyArray<number>;
  /**
   * reachability bit position -> oid: `allObjectIds` through
   * `ownPositionToBitPosition`'s inverse for a pack bitmap,
   * `midxOidAt`/`midxReverseIndexAt` for a midx bitmap.
   */
  readonly oidAtBitPosition: (bitPosition: number) => ObjectId;
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

/** Inverts an own-position -> bit-position array (`positions[bitPosition] =
 *  ownPosition`) into its bit-position -> own-position form. Shared by both
 *  flavours: a pack bitmap inverts `packPositions` (index position at each
 *  pack position); a midx bitmap inverts the reverse-index chunk (midx
 *  position at each pseudo-pack position) — same shape either way. */
export function invertPositions(positions: ReadonlyArray<number>): ReadonlyArray<number> {
  const inverse = new Array<number>(positions.length);
  positions.forEach((ownPosition, bitPosition) => {
    inverse[ownPosition] = bitPosition;
  });
  return inverse;
}

export interface ParsedBitmapContainer {
  readonly bitmap: PackBitmap;
  readonly headers: ReadonlyArray<BitmapEntryHeader>;
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
): ParsedBitmapContainer | undefined {
  try {
    const bitmap = parsePackBitmap(bytes, ctx.hashConfig.digestLength);
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
 * Parses `bytes` and range-validates the result against `objectCount` —
 * identical work for both flavours (see this module's own doc), taken once
 * a caller has `bytes` (from `usableBitmapBytes`) and its own artefact's
 * object count in hand. Returns `undefined` for the caller to decline —
 * a structural parse refusal warns inside `parseBitmapContainer` itself; an
 * out-of-range position warns here, with one `ctx.logger?.warn?.` either way.
 */
export function validateBitmapContainer(
  ctx: Context,
  flavour: 'pack' | 'midx',
  artefactName: string,
  bytes: Uint8Array,
  objectCount: number,
): ValidatedBitmapContainer | undefined {
  const parsed = parseBitmapContainer(ctx, bytes, artefactName, flavour);
  if (parsed === undefined) return undefined;
  const { bitmap, headers } = parsed;

  const validated = validateBitmapRanges(bitmap, headers, objectCount);
  if (validated === undefined) {
    ctx.logger?.warn?.(`bitmapBinding: ${flavour} bitmap position out of range, declining`, {
      bitmap: artefactName,
    });
    return undefined;
  }

  return {
    bitmap,
    headers,
    objectCount,
    laneCount: laneCountFor(objectCount),
    typeBits: validated.typeBits,
  };
}

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
 *  names it, else a shared extended position — and sets it in `state`. */
function markPosition(
  artefact: LoadedBitmapArtefact,
  extended: ExtendedPositions,
  state: FillState,
  oid: ObjectId,
): void {
  const ownPosition = artefact.resolveOwnPosition(oid);
  if (ownPosition !== undefined) {
    setBit(state.bits, artefact.ownPositionToBitPosition[ownPosition] as number);
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
  while (queue.length > 0) {
    const id = queue.shift() as ObjectId;
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
  for (let position = 0; position < artefact.objectCount; position += 1) {
    if (!bitIsSet(wantState.bits, position) || bitIsSet(notState.bits, position)) continue;
    const type = typeOfPosition(artefact, position);
    if (!isIncludedType(type, request.objects)) continue;
    results.push({ id: artefact.oidAtBitPosition(position), type });
  }
  for (const extIndex of wantState.extended) {
    if (notState.extended.has(extIndex)) continue;
    const oid = extended.oids[extIndex] as ObjectId;
    const obj = await readObject(ctx, oid);
    if (!isIncludedType(obj.type, request.objects)) continue;
    results.push({ id: oid, type: obj.type });
  }
  return results;
}
