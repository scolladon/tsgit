/**
 * The load → parse → range-validate pipeline both bitmap flavours run before
 * a `LoadedBitmapArtefact` (`bitmap-binding.ts`) exists at all, plus the two
 * position-table helpers a flavour's loader builds its mappings from.
 *
 * Every function here is identical work for a pack's own `.bitmap` and a
 * multi-pack-index's, because the CONTAINER format is the same whether it
 * indexes a pack or a midx; only what a decoded `position` MEANS differs,
 * and that is entirely a loader's own concern past this point. Nothing here
 * takes I/O of its own, so a caller that has not yet fetched what it needs
 * to validate against (a pack's `.idx`, say) is free to keep that fetch
 * between two of these calls.
 *
 * One decline shape throughout: return `undefined` so the caller falls
 * through to the next artefact in the preference order, silently for an
 * absent or unreadable artefact and with exactly one `ctx.logger?.warn?.`
 * for a present-but-faulty one. A violation declines the WHOLE artefact,
 * never just the offending entry.
 */
import { TsgitError } from '../../../domain/error.js';
import {
  type BitmapEntryHeader,
  bitmapEntryHeaders,
  type PackBitmap,
  parsePackBitmap,
} from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import { laneCountFor, validateBitmapRanges } from './bitmap-range-validation.js';
import type { ArtefactLoad } from './pack-artefact-source.js';
import { faultContext } from './pack-shared.js';

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
 * The one decline shape for a present-but-unusable artefact past the load:
 * warn with the artefact's own name, return `undefined` so the caller falls
 * through to the next artefact in the preference order with nothing
 * surfaced.
 */
export function declineBitmap(ctx: Context, reason: string, artefactName: string): undefined {
  ctx.logger?.warn?.(`bitmapBinding: ${reason}`, { bitmap: artefactName });
  return undefined;
}

/**
 * Parses `bytes` as a bitmap container and its per-commit entry headers.
 * Returns `undefined` on a structural parse refusal, having already logged
 * it with `artefactName` — the caller's decline signal, matching every
 * other present-but-faulty artefact this pipeline recognises.
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
 * only the message's flavour word differs.
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
 * Parses `bytes` and range-validates the result against `objectCount`, taken
 * once a caller has `bytes` (from `usableBitmapBytes`) and its own artefact's
 * object count in hand: every position the bitmap decodes — entry headers
 * AND every set bit any of its streams declares — is checked here, BEFORE a
 * loader builds either of its mapping functions. Returns `undefined` for the
 * caller to decline — a structural parse refusal and an over-long entry
 * table both warn inside `parseBitmapContainer` itself, an out-of-range
 * position warns here, with one `ctx.logger?.warn?.` whichever fires.
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
