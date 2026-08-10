/**
 * The application-layer binding between a parsed `PackBitmap` and a pack's
 * objects — resolves the bitmap-tier closure (`W AND NOT N`) over a pack
 * bitmap. Model: `internal/midx-binding.ts`, including its type-only import
 * of the registry (keeps the `no-circular` depcruise rule happy and
 * structurally forbids reaching a runtime value out of the registry it is
 * bound into).
 *
 * Position mapping (a bit is a PACK position, an entry header's `position`
 * is an INDEX position) and range validation run entirely inside
 * `loadPackBitmapArtefact`, and in that order: every position this module
 * decodes from the artefact — entry headers AND every set bit a folded
 * stream yields — is checked against the pack's own object count BEFORE
 * `packPositions()`/`allObjectIds` ever turn a decoded position into an
 * oid. A violation declines the WHOLE artefact, never just the offending
 * entry, and is reported through `ctx.logger?.warn?.`; the caller falls
 * back to the walk with nothing surfaced.
 */
import { TsgitError } from '../../../domain/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import {
  type BitmapEntryHeader,
  bitmapEntryHeaders,
  entryOffsets,
  lookupPackIndex,
  type PackBitmap,
  type PackIndex,
  parsePackBitmap,
} from '../../../domain/storage/index.js';
// `allObjectIds` is not barrel-exported — imported directly, as
// `enumerate-objects.ts` already does.
import { allObjectIds } from '../../../domain/storage/pack-index.js';
import type { Context } from '../../../ports/context.js';
// Type-only: keeps the dependency-cruiser no-circular rule happy and
// structurally forbids this module from ever importing a runtime value out
// of the registry it is bound into.
import type { RegisteredPack } from '../pack-registry.js';
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

/** A pack bitmap bound to the pack it indexes, past every range check —
 *  never constructed for an artefact this module has not already validated. */
export interface LoadedPackBitmap {
  readonly artefactName: string;
  readonly bitmap: PackBitmap;
  readonly headers: ReadonlyArray<BitmapEntryHeader>;
  readonly index: PackIndex;
  readonly objectCount: number;
  readonly laneCount: number;
  /** Pack position → index position, `RegisteredPack.packPositions()`'s own shape. */
  readonly packPositions: ReadonlyArray<number>;
  /** Index position → pack position, the inverse of `packPositions` — resolves
   *  an arbitrary known oid (a tag, a tree/blob want, a tree entry) to its bit. */
  readonly indexPositionToPackPosition: ReadonlyArray<number>;
  /** Index position → entry index, built from `headers[i].position`. */
  readonly indexPositionToEntry: ReadonlyMap<number, number>;
  /** Pack byte offset → index position — `lookupPackIndex` resolves an oid
   *  to its OFFSET, never its index position directly, so every oid → index
   *  position lookup in this module goes through this map, built once from
   *  `entryOffsets(index)` (offset at index position `i`, inverted). */
  readonly offsetToIndexPosition: ReadonlyMap<number, number>;
  /** One folded, range-proved bit array per type stream, commits/trees/blobs/tags. */
  readonly typeBits: readonly [Uint32Array, Uint32Array, Uint32Array, Uint32Array];
}

function invertPackPositions(packPositions: ReadonlyArray<number>): ReadonlyArray<number> {
  const inverse = new Array<number>(packPositions.length);
  packPositions.forEach((indexPosition, packPosition) => {
    inverse[indexPosition] = packPosition;
  });
  return inverse;
}

/**
 * Loads, parses and range-validates a pack's bitmap, or returns `undefined`
 * for the caller to fall back to the walk — silently for absent/unreadable,
 * with one `ctx.logger?.warn?.` for a present-but-faulty artefact (refused,
 * a structural parse refusal, or an out-of-range position): the opposite of
 * the silent cases, because git itself prints an error there.
 *
 * `pack.packPositions()` — the position-mapping memo whose result turns a
 * decoded pack position into an oid — is reached ONLY after
 * `validateBitmapRanges` has already accepted every position the artefact
 * decodes. Nothing above that call resolves an oid.
 */
export async function loadPackBitmapArtefact(
  ctx: Context,
  pack: RegisteredPack,
): Promise<LoadedPackBitmap | undefined> {
  if (!pack.hasBitmap) return undefined;
  const load = await pack.bitmapBytes();
  if (load.kind === 'absent' || load.kind === 'unreadable') return undefined;
  const artefactName = `${pack.name}.bitmap`;
  if (load.kind === 'refused') {
    ctx.logger?.warn?.('bitmapBinding: discarding unusable pack bitmap', {
      bitmap: artefactName,
      ...faultContext(load.data),
    });
    return undefined;
  }

  const index = await pack.index();
  let bitmap: PackBitmap;
  let headers: ReadonlyArray<BitmapEntryHeader>;
  try {
    bitmap = parsePackBitmap(load.bytes, ctx.hashConfig.digestLength);
    headers = bitmapEntryHeaders(bitmap);
  } catch (err) {
    if (!(err instanceof TsgitError) || err.data.code !== 'INVALID_PACK_BITMAP') throw err;
    ctx.logger?.warn?.('bitmapBinding: discarding unusable pack bitmap', {
      bitmap: artefactName,
      ...faultContext(err.data),
    });
    return undefined;
  }

  const objectCount = index.objectCount;
  const validated = validateBitmapRanges(bitmap, headers, objectCount);
  if (validated === undefined) {
    ctx.logger?.warn?.('bitmapBinding: pack bitmap position out of range, declining', {
      bitmap: artefactName,
    });
    return undefined;
  }

  const packPositions = await pack.packPositions();
  return {
    artefactName,
    bitmap,
    headers,
    index,
    objectCount,
    laneCount: laneCountFor(objectCount),
    packPositions,
    indexPositionToPackPosition: invertPackPositions(packPositions),
    indexPositionToEntry: new Map(headers.map((header, i) => [header.position, i] as const)),
    offsetToIndexPosition: new Map(entryOffsets(index).map((offset, i) => [offset, i] as const)),
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

/** `oid`'s index position — the SHA-sorted rank `.idx` assigns it — or
 *  `undefined` when this pack does not carry it. `lookupPackIndex` resolves
 *  an oid to its pack byte OFFSET, never a position directly, so every
 *  lookup here goes through `offsetToIndexPosition` to translate. */
function indexPositionOf(artefact: LoadedPackBitmap, oid: ObjectId): number | undefined {
  const offset = lookupPackIndex(artefact.index, oid);
  if (offset === undefined) return undefined;
  return artefact.offsetToIndexPosition.get(offset);
}

/** Resolves `oid` to a bit — a pack position when the artefact's own `.idx`
 *  names it, else a shared extended position — and sets it in `state`. */
function markPosition(
  artefact: LoadedPackBitmap,
  extended: ExtendedPositions,
  state: FillState,
  oid: ObjectId,
): void {
  const indexPosition = indexPositionOf(artefact, oid);
  if (indexPosition !== undefined) {
    setBit(state.bits, artefact.indexPositionToPackPosition[indexPosition] as number);
    return;
  }
  state.extended.add(getOrAssignExtended(extended, oid));
}

/** `entryFor`: the index position `.idx` gives `commitOid`, mapped to its
 *  bitmap entry, when the pack indexes the object and the bitmap has an
 *  entry for it. */
function entryFor(artefact: LoadedPackBitmap, commitOid: ObjectId): number | undefined {
  const indexPosition = indexPositionOf(artefact, commitOid);
  if (indexPosition === undefined) return undefined;
  return artefact.indexPositionToEntry.get(indexPosition);
}

/** Marks `treeId` and every non-gitlink descendant it reaches — the
 *  `objects`-side walk a pending commit (one with no bitmap entry) falls
 *  back to, mirroring the walk tier's own tree recursion via `walkTree`. */
async function markTreeBits(
  ctx: Context,
  artefact: LoadedPackBitmap,
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
  artefact: LoadedPackBitmap,
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
  artefact: LoadedPackBitmap,
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
function typeOfPosition(artefact: LoadedPackBitmap, position: number): BitmapClosureObject['type'] {
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
 * Resolves `request` against a validated pack bitmap: `W = fill(wants)`,
 * `N = fill(not)`, `W AND NOT N` over in-artefact positions plus the
 * set-difference of each fill's own extended positions. `path` is never
 * produced — the artefact has none.
 */
export async function resolveBitmapClosure(
  ctx: Context,
  artefact: LoadedPackBitmap,
  request: BitmapClosureRequest,
): Promise<ReadonlyArray<BitmapClosureObject>> {
  const rc = createReconstructionContext(artefact.bitmap, artefact.headers, artefact.laneCount);
  const extended: ExtendedPositions = { indexByOid: new Map(), oids: [] };

  const wantState = await fill(ctx, artefact, extended, rc, request.wants, request.objects);
  const notState = await fill(ctx, artefact, extended, rc, request.not, request.objects);

  const results: BitmapClosureObject[] = [];
  const oidsByIndexPosition = allObjectIds(artefact.index);
  for (let position = 0; position < artefact.objectCount; position += 1) {
    if (!bitIsSet(wantState.bits, position) || bitIsSet(notState.bits, position)) continue;
    const type = typeOfPosition(artefact, position);
    if (!isIncludedType(type, request.objects)) continue;
    const oid = oidsByIndexPosition[artefact.packPositions[position] as number] as ObjectId;
    results.push({ id: oid, type });
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
