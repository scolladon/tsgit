/**
 * Binds a scan's multi-pack-index to the `RegisteredPack` objects the SAME
 * scan produced, resolves lookups against it, and computes the fsck-facing
 * `MidxHealth` verdict. Imports `RegisteredPack`/`PackLookupHit`/
 * `PackGeneration` from `../pack-registry.js` TYPE-ONLY — no runtime value
 * crosses back from here into the registry, so the edge is erased at
 * compile time and cannot form a runtime cycle.
 */

import { TsgitError, type TsgitErrorData } from '../../../domain/error.js';
import { bytesEqual, hexToBytes } from '../../../domain/objects/encoding.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import {
  type MidxEntry,
  type MultiPackIndex,
  midxEntryAt,
  midxOidAt,
} from '../../../domain/storage/index.js';
import { lookupMultiPackIndexBytes } from '../../../domain/storage/midx.js';
import type { Context } from '../../../ports/context.js';
// Type-only: keeps the dependency-cruiser no-circular rule happy (it exempts
// type-only edges) and structurally forbids this module from ever importing
// a runtime value out of the registry it is bound into.
import type { PackGeneration, PackLookupHit, RegisteredPack } from '../pack-registry.js';
import type { MidxFault, MidxSet } from './midx-source.js';
import {
  isSafePackName,
  isSkippableIdxFault,
  isSkippablePackFault,
  packBaseName,
} from './pack-shared.js';

/**
 * One generation's midx bound to the `RegisteredPack` objects the SAME scan
 * produced. `packsByLayer[layerIndex][packIndex]` is `undefined` exactly
 * when that layer's `PNAM` entry names nothing this scan registered —
 * either it failed `isSafePackName`, or it matched no candidate (an
 * orphaned/excluded `.idx`, or a name no file on disk carries at all).
 * `claimedNames` holds only the names that DID bind, `.idx`-suffixed as
 * `PNAM` stores them — the subtraction set the `.idx` loop skips.
 */
export interface LoadedMidx {
  readonly set: MidxSet;
  readonly packsByLayer: ReadonlyArray<ReadonlyArray<RegisteredPack | undefined>>;
  readonly claimedNames: ReadonlySet<string>;
  /**
   * Whether each `PNAM` entry's sibling `.pack` file exists in the scan's own
   * listing. An unbound entry whose `.pack` IS on disk (its `.idx` alone is
   * missing) resolved to a real pack in git's eyes — its objects go
   * unresolved but the pack itself is not reported missing.
   */
  readonly packFileOnDiskByLayer: ReadonlyArray<ReadonlyArray<boolean>>;
}

/**
 * Binds every layer's `PNAM` entries to the `RegisteredPack` the same scan
 * produced, by exact string equality against the already-audited `.idx`
 * base names — never by constructing a path from a `PNAM` value (a hostile
 * repository controls that value). A name is resolved only when it passes
 * `isSafePackName` AND matches a pack this scan actually registered; either
 * failure binds `undefined` and withholds the name from `claimedNames`, so
 * the real pack of that name, if any, is scanned normally through the
 * ordinary `.idx` loop. A safe-but-unmatched name warns once, mirroring the
 * orphan-`.idx` warn discipline; an unsafe name never reaches the logger
 * raw — `isSafePackName` exists precisely to keep a hostile filename out of
 * it.
 */
export function bindMidx(
  ctx: Context,
  packs: ReadonlyArray<RegisteredPack>,
  set: MidxSet,
  fileNames: ReadonlySet<string>,
): LoadedMidx {
  const packsByIdxName = new Map(packs.map((pack) => [`${pack.name}.idx`, pack]));
  const claimedNames = new Set<string>();
  const packsByLayer: Array<Array<RegisteredPack | undefined>> = [];
  const packFileOnDiskByLayer: Array<Array<boolean>> = [];
  for (const layer of set.layers) {
    const bound: Array<RegisteredPack | undefined> = [];
    const packOnDisk: boolean[] = [];
    for (const name of layer.packNames) {
      // One safety evaluation per entry feeds both views. The on-disk flag
      // demands the .idx suffix too: PNAM never legitimately carries any
      // other shape, and a hostile non-.idx name must not be able to borrow
      // an existing .pack file to suppress its own unresolved finding.
      const safe = isSafePackName(name);
      const wellFormed = safe && name.endsWith('.idx');
      packOnDisk.push(wellFormed && fileNames.has(`${packBaseName(name)}.pack`));
      if (!safe) {
        bound.push(undefined);
        continue;
      }
      const pack = packsByIdxName.get(name);
      if (pack === undefined) {
        ctx.logger?.warn?.(
          'packRegistry: multi-pack-index names a pack this scan did not register',
          {
            // Escaped like the finding sink: isSafePackName admits C1/bidi
            // code points that must not reach a log field raw.
            pack: escapeControlBytes(name),
          },
        );
        bound.push(undefined);
        continue;
      }
      claimedNames.add(name);
      bound.push(pack);
    }
    packsByLayer.push(bound);
    packFileOnDiskByLayer.push(packOnDisk);
  }
  return { set, packsByLayer, claimedNames, packFileOnDiskByLayer };
}

/**
 * Walk the midx's layers newest-first and resolve the first hit. A layer's
 * `lookupMultiPackIndex` can throw a deferred `pack-int-id` or
 * `large-offset` Tier-A fault — never caught here, so it propagates to
 * `lookup`'s caller unchanged. A hit whose pack never bound (an
 * unresolvable `PNAM` entry) and no hit in any layer both return
 * `undefined`: either way the caller falls through to the `.idx` loop.
 */
export function findMidxHit(midx: LoadedMidx, id: ObjectId): PackLookupHit | undefined {
  const targetBytes = hexToBytes(id);
  for (let layerIndex = midx.set.layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const entry = lookupMultiPackIndexBytes(midx.set.layers[layerIndex]!, targetBytes);
    if (entry === undefined) continue;
    // packsByLayer is built by mapping set.layers, so the layer index always
    // exists; only the pack binding itself can be undefined.
    const pack = midx.packsByLayer[layerIndex]![entry.packIndex];
    return pack === undefined ? undefined : { pack, offset: entry.offset };
  }
  return undefined;
}

// A hostile PNAM value can carry anything TextDecoder tolerates — C0/C1
// controls, bidi overrides, line separators — so everything outside
// printable ASCII is hex-escaped, and the input is truncated first: its
// only structural bound is the PNAM chunk itself, far too large to spread
// into a finding.
const MAX_FINDING_NAME_LENGTH = 256;
const escapeControlBytes = (name: string): string => {
  const bounded = name.slice(0, MAX_FINDING_NAME_LENGTH);
  let escaped = '';
  for (let i = 0; i < bounded.length; i += 1) {
    const code = bounded.charCodeAt(i);
    // 0x5c (backslash) is escaped too, or a literal '\\u0001' in a hostile
    // name would be indistinguishable from an escaped real control byte.
    const isPlain = code >= 0x20 && code <= 0x7e && code !== 0x5c;
    escaped += isPlain ? bounded[i] : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return name.length > MAX_FINDING_NAME_LENGTH ? `${escaped}\u2026` : escaped;
};

// `PNAM` carries `pack-<hex>.idx`; findings elsewhere in this file carry the
// pack BASE name, so the suffix is stripped here to match. A name failing
// `isSafePackName` has every control byte hex-escaped rather than reaching a
// finding (or a path) raw — an attacker-controlled midx fully controls this
// string.
const midxPackNameForFinding = (name: string): string =>
  isSafePackName(name) && name.endsWith('.idx') ? packBaseName(name) : escapeControlBytes(name);

/**
 * Chain-global position + safe pack name for every `PNAM` entry this scan's
 * binding left unresolved — a pure walk over the
 * already-bound `packsByLayer`, no I/O, so it can never contribute a
 * contained fault.
 */
function unresolvedMidxPacks(
  midx: LoadedMidx,
): ReadonlyArray<{ readonly position: number; readonly pack: string }> {
  const unresolved: Array<{ readonly position: number; readonly pack: string }> = [];
  let base = 0;
  for (const [layerIndex, layer] of midx.set.layers.entries()) {
    const bound = midx.packsByLayer[layerIndex]!;
    const packOnDisk = midx.packFileOnDiskByLayer[layerIndex]!;
    layer.packNames.forEach((name, packIndex) => {
      // An unbound entry whose .pack survives on disk resolved as a pack in
      // git's eyes (only its .idx is gone): its objects are unresolved, but
      // no pack-level finding is emitted for it.
      // Stryker disable next-line ConditionalExpression: equivalent — bound[packIndex] !== undefined only when loadCandidatePack registered that name's pack, which requires fileNames.has(`${pack.name}.pack`) already — the exact predicate packOnDisk[packIndex] re-derives, so whenever the first operand would differ, packOnDisk is already true and !packOnDisk short-circuits the whole condition to the same false.
      if (bound[packIndex] === undefined && !packOnDisk[packIndex]) {
        unresolved.push({ position: base + packIndex, pack: midxPackNameForFinding(name) });
      }
    });
    base += layer.packNames.length;
  }
  return unresolved;
}

/** Whether a bound pack can actually serve the entry the midx routes to it —
 *  the same two allow-lists `lookup`'s own header gate and the scan layer's
 *  index gate use, so a corrupt `.idx` or a header-refused pack both count
 *  as "cannot serve" without laundering an unrecognised fault into a skip. */
async function probeMidxEntryServiceable(pack: RegisteredPack): Promise<boolean> {
  try {
    await pack.index();
    await pack.header();
    return true;
  } catch (err) {
    if (isSkippableIdxFault(err) || isSkippablePackFault(err)) return false;
    throw err;
  }
}

interface MidxEntryWalkResult {
  readonly unresolvedEntries: ReadonlyArray<ObjectId>;
  /** The fault that ended the walk early, when `lookupMultiPackIndex` hit a
   *  deferred Tier-A check (`pack-int-id`, `large-offset`) decoding one
   *  specific entry — git's own child process dies there too, so the walk
   *  stops at the SAME point git's would, and every entry already
   *  classified stays classified. */
  readonly containedFault: MidxFault | undefined;
}

/**
 * One layer's entry walk. Returns the fault data that ended it early (a
 * deferred Tier-A decode), or `undefined` when the layer walked to the end.
 * The serviceability map is probed synchronously first: an await on a
 * cached verdict would cost a microtask per entry, dominating a walk whose
 * body is `DataView` reads. One probe per distinct pack — the verdict
 * cannot change mid-walk, and the header memo clears on rejection, so a
 * per-entry probe would re-issue the header read for every routed oid.
 */
async function walkLayerEntries(
  layer: MultiPackIndex,
  bound: ReadonlyArray<RegisteredPack | undefined>,
  serviceable: Map<RegisteredPack, boolean>,
  unresolvedEntries: ObjectId[],
): Promise<TsgitErrorData | undefined> {
  for (let i = 0; i < layer.objectCount; i += 1) {
    let entry: MidxEntry;
    try {
      // Index-addressed: the walk already knows every position, so it
      // never re-derives one through the fanout binary search, and an oid
      // is hex-materialised only for the entries that turn out unresolved.
      entry = midxEntryAt(layer, i);
    } catch (err) {
      // Stryker disable next-line ConditionalExpression: equivalent — midxEntryAt only ever throws a TsgitError via invalidMultiPackIndex, which always sets code:'INVALID_MULTI_PACK_INDEX'; the OR's second operand is thus always false whenever the first is (err is that TsgitError), so forcing it to false changes nothing.
      if (!(err instanceof TsgitError) || err.data.code !== 'INVALID_MULTI_PACK_INDEX') throw err;
      return err.data;
    }
    const pack = bound[entry.packIndex];
    if (pack === undefined) {
      unresolvedEntries.push(midxOidAt(layer, i));
      continue;
    }
    const cached = serviceable.get(pack);
    const serves =
      cached === undefined ? await probeAndCacheServiceable(pack, serviceable) : cached;
    if (!serves) {
      unresolvedEntries.push(midxOidAt(layer, i));
    }
  }
  return undefined;
}

async function probeAndCacheServiceable(
  pack: RegisteredPack,
  serviceable: Map<RegisteredPack, boolean>,
): Promise<boolean> {
  const verdict = await probeMidxEntryServiceable(pack);
  serviceable.set(pack, verdict);
  return verdict;
}

/**
 * Resolve every oid the midx lists, per layer, oldest first: the same
 * per-entry walk git's `verify` child runs. A pack that never bound makes
 * its oids unresolved without touching the pack; a bound pack's oids are
 * unresolved when it cannot serve them (`probeMidxEntryServiceable`). A
 * Tier-A fault surfacing HERE — not at load, since every layer already
 * parsed — is contained: the walk ends and the fault it hit is returned
 * alongside whatever was classified before it.
 */
async function walkMidxEntries(midx: LoadedMidx): Promise<MidxEntryWalkResult> {
  const unresolvedEntries: ObjectId[] = [];
  const headArtefact = midx.set.artefacts[midx.set.artefacts.length - 1]!;
  const serviceable = new Map<RegisteredPack, boolean>();
  for (const [layerIndex, layer] of midx.set.layers.entries()) {
    const bound = midx.packsByLayer[layerIndex]!;
    const faultData = await walkLayerEntries(layer, bound, serviceable, unresolvedEntries);
    if (faultData !== undefined) {
      return { unresolvedEntries, containedFault: { artefact: headArtefact, data: faultData } };
    }
  }
  return { unresolvedEntries, containedFault: undefined };
}

/** Once, over exactly the artefact in use (the flat file, or the chain
 *  head) — never a base layer. `MultiPackIndex._bytes` is the whole file,
 *  so no second read is needed. The digest algorithm is never selected
 *  here: `hashVersion`'s width is checked against the repository's own
 *  `ctx.hashConfig.digestLength` at parse time (a disagreement is a Tier-B
 *  `hash-version` discard before the artefact could ever reach this point),
 *  so the surviving artefact's width always agrees with
 *  `ctx.hash.digestLength` by construction. */
async function verifyMidxTrailer(ctx: Context, midx: LoadedMidx): Promise<boolean> {
  const head = midx.set.layers[midx.set.layers.length - 1]!;
  const bodyEnd = head._bytes.length - head.digestLength;
  const digest = await ctx.hash.hash(head._bytes.subarray(0, bodyEnd));
  return bytesEqual(digest, head._bytes.subarray(bodyEnd));
}

/**
 * Compute this generation's `MidxHealth` once. Never rejects for a midx
 * fault: a contained Tier-A walk fault is folded into the returned `faults`
 * (tagged with the in-use artefact so the fsck pass can recognise it
 * unconditionally, never through the "no usable artefact" verdict), so the
 * memo's usual clear-on-rejection never fires for one — the resolved value
 * already IS the fault set.
 */
export async function computeMidxHealth(
  ctx: Context,
  generation: PackGeneration,
): Promise<MidxHealth> {
  const { midxLoad, midx } = generation;
  if (midx === undefined) {
    return {
      artefact: undefined,
      faults: midxLoad.faults,
      flatFilePresent: midxLoad.flatFilePresent,
      unresolvedPacks: [],
      unresolvedEntries: [],
      checksumOk: undefined,
    };
  }
  const artefact = midx.set.artefacts[midx.set.artefacts.length - 1]!;
  const checksumOk = await verifyMidxTrailer(ctx, midx);
  const unresolvedPacks = unresolvedMidxPacks(midx);
  const { unresolvedEntries, containedFault } = await walkMidxEntries(midx);
  return {
    artefact,
    faults: containedFault === undefined ? midxLoad.faults : [...midxLoad.faults, containedFault],
    flatFilePresent: midxLoad.flatFilePresent,
    unresolvedPacks,
    unresolvedEntries,
    checksumOk,
  };
}

/**
 * The multi-pack-index's accessibility + integrity verdict for the current
 * generation — the state `fsck`'s midx pass needs and nothing else needs.
 * A sibling of `PackHealth` — a midx fault is not a pack fault — never a
 * widening of it.
 */
export interface MidxHealth {
  /**
   * The artefact actually IN USE — the flat file, or the chain head.
   * `undefined` covers both "there is none" and "every candidate was
   * Tier-B-unusable"; `flatFilePresent` tells those two apart.
   */
  readonly artefact: string | undefined;
  /**
   * Tier-B faults the read path discarded, plus — when the entry-resolution
   * walk below hits a Tier-A fault decoding one specific entry — the single
   * fault that ended the walk (`fsck` treats that case unconditionally,
   * never through the "no usable artefact" verdict the other faults here
   * feed).
   */
  readonly faults: ReadonlyArray<MidxFault>;
  /** Whether a flat `multi-pack-index` file exists — a stat, not a
   *  successful read (the verdict gate). */
  readonly flatFilePresent: boolean;
  /** Chain-global pack positions whose `PNAM` entry resolves to no pack this
   *  generation registered. */
  readonly unresolvedPacks: ReadonlyArray<{ readonly position: number; readonly pack: string }>;
  /** Oids the midx assigns to a pack that cannot serve them — either the
   *  `PNAM` binding failed (see `unresolvedPacks`) or the bound pack's own
   *  `.idx`/header gate rejects. */
  readonly unresolvedEntries: ReadonlyArray<ObjectId>;
  /** The in-use artefact's trailer digest, verified once. `undefined` when
   *  there is no artefact to hash. */
  readonly checksumOk: boolean | undefined;
}
