/**
 * One pack-directory scan's generation: the candidate packs, the midx bound
 * to them, the lazily-forced `.idx` classification, and the empty generation
 * a missing pack directory resolves to. Imports `RegisteredPack` and
 * `MidxBitmapLoad` from `../pack-registry.js` TYPE-ONLY — no runtime value
 * crosses back from here into the registry, so the edge is erased at compile
 * time and cannot form a runtime cycle.
 */

import type { TsgitErrorData } from '../../../domain/error.js';
import type { PackIndex } from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import type { MidxBitmapLoad, RegisteredPack } from '../pack-registry.js';
import { boundedMapFor } from './concurrency.js';
import type { LoadedMidx } from './midx-binding.js';
import type { MidxLoadResult } from './midx-source.js';
import { faultContext, isSkippableIdxFault } from './pack-shared.js';
import { createPromiseMemo, type PromiseMemo } from './promise-memo.js';

export const NO_PACKS: ReadonlyArray<RegisteredPack> = Object.freeze([]);
const NO_INDEX_FAULTS: ReadonlyArray<{ readonly name: string; readonly data: TsgitErrorData }> =
  Object.freeze([]);

/**
 * The scan layer's classification of one generation's candidates: which
 * ones have a loaded, parsed `.idx` (`packs`), and which were skipped as
 * unreadable/unparseable (`indexFaults`). Built once per generation by
 * `resolveIndexes`, behind `PackGeneration.indexed`.
 */
export interface IndexedPack {
  readonly pack: RegisteredPack;
  /** The settled parse — held here so lookup's fallback loop stays synchronous. */
  readonly index: PackIndex;
}

export interface IndexedPacks {
  readonly packs: ReadonlyArray<IndexedPack>;
  /** The same packs projected once — `all()` returns one stable reference per generation. */
  readonly packList: ReadonlyArray<RegisteredPack>;
  readonly indexFaults: ReadonlyArray<{ readonly name: string; readonly data: TsgitErrorData }>;
}

const NO_INDEXED_PACKS: ReadonlyArray<IndexedPack> = Object.freeze([]);

const EMPTY_INDEXED: IndexedPacks = Object.freeze({
  packs: NO_INDEXED_PACKS,
  packList: NO_PACKS,
  indexFaults: NO_INDEX_FAULTS,
});

const EMPTY_MIDX_LOAD: MidxLoadResult = Object.freeze({
  set: undefined,
  faults: Object.freeze([]),
  flatFilePresent: false,
});

export interface PackGeneration {
  /** Every candidate with a sibling `.pack` — orphans excluded, `.idx` not
   *  yet read. The safe superset for `refresh()`/`dispose()` to close: a
   *  pack whose index never loaded simply has nothing to close. */
  readonly packs: ReadonlyArray<RegisteredPack>;
  /** The multi-pack-index load this generation's scan captured from the
   *  store gate it awaited — the same `MidxLoadResult` `assertLoadable`
   *  observed for this generation, so no consumer can ever pair one
   *  generation's midx with another's packs. Read by `computeMidxHealth`
   *  for the generation's fault set and flat-file presence; `midx` below is
   *  the bound, lookup-facing view. `assertLoadable` does NOT read this
   *  field — it awaits the same store gate this was captured from. */
  readonly midxLoad: MidxLoadResult;
  /** `midxLoad.set` bound to this generation's own `packs`, or `undefined`
   *  exactly when `midxLoad.set` is. The one field `lookup` reads to decide
   *  whether the midx is authoritative for this generation. */
  readonly midx: LoadedMidx | undefined;
  /** Forces every candidate's `.idx` load, once, on first use. */
  readonly indexed: PromiseMemo<IndexedPacks>;
  /**
   * `.idx` names already warned about this generation — the lazy unclaimed
   * scan retries a failed parse on every lookup (no negative cache), and
   * without this dedup each retry would emit another identical warn.
   */
  readonly warnedIdx: Set<string>;
  /** Every regular-file name this scan's `readdir` saw — the same set each
   *  pack's own artefact discovery (`.rev`, and the bitmap arms) is built
   *  from, so no artefact probe ever costs a second `readdir`. */
  readonly fileNames: ReadonlySet<string>;
  /** The in-use midx's bitmap, or `undefined` when there is no usable midx
   *  for this generation. Memoised per **generation**, not per pack — the
   *  artefact's identity depends on the midx layer in use, so it cannot
   *  live on a `RegisteredPack` the way `.rev`/`.bitmap` do. */
  readonly midxBitmap: PromiseMemo<MidxBitmapLoad | undefined>;
}

const NO_FILE_NAMES: ReadonlySet<string> = Object.freeze(new Set<string>());

export function emptyGeneration(): PackGeneration {
  return {
    packs: NO_PACKS,
    midxLoad: EMPTY_MIDX_LOAD,
    midx: undefined,
    indexed: createPromiseMemo(() => Promise.resolve(EMPTY_INDEXED)),
    warnedIdx: new Set(),
    fileNames: NO_FILE_NAMES,
    midxBitmap: createPromiseMemo(() => Promise.resolve(undefined)),
  };
}

/**
 * One pack's settled `.idx` load, kept alongside its origin pack so the
 * bounded fan-out below can be walked back into candidate order once every
 * load has settled. `fatal` captures a non-skippable rejection AS DATA
 * instead of letting it escape the worker: an error thrown from inside
 * `boundedMap`'s `worker` rejects whichever runner's promise settles first
 * in REAL completion order, not candidate order — capturing it here lets the
 * candidate-order walk below decide which fatal fault wins.
 */
type IndexOutcome =
  | { readonly kind: 'loaded'; readonly index: PackIndex }
  | { readonly kind: 'fault'; readonly data: TsgitErrorData }
  | { readonly kind: 'fatal'; readonly error: unknown };

async function loadIndexOutcome(pack: RegisteredPack): Promise<IndexOutcome> {
  try {
    return { kind: 'loaded', index: await pack.index() };
  } catch (err) {
    if (!isSkippableIdxFault(err)) return { kind: 'fatal', error: err };
    return { kind: 'fault', data: err.data };
  }
}

/** Warns once per `.idx` per generation — shared with the lazy lookup's own
 *  `unclaimedIndexOrSkip`, through the SAME `warnedIdx` set, so a pack either
 *  side already warned about never warns twice. */
function warnUnreadableIndexOnce(
  ctx: Context,
  packName: string,
  data: TsgitErrorData,
  warnedIdx: Set<string>,
): void {
  const idxName = `${packName}.idx`;
  if (warnedIdx.has(idxName)) return;
  warnedIdx.add(idxName);
  ctx.logger?.warn?.('packRegistry: skipping unreadable pack index', {
    idx: idxName,
    ...faultContext(data),
  });
}

/**
 * The single site that classifies an index-layer fault — run once per
 * generation, behind `PackGeneration.indexed`, never per lookup — so a
 * generation warns for each unreadable index exactly once no matter how many
 * consumers later force the memo, and never twice when a lazy lookup already
 * warned about the same `.idx` first. Forces every candidate's `.idx` load,
 * not just the ones a lookup needed, so `all()`, `indexFaults()` and
 * `health()` see a complete classification even when no lookup ever ran.
 * Every load races in the ctx's I/O-bound pool, but the walk that builds
 * `packs`/`indexFaults` and warns runs afterward, over the settled results in
 * CANDIDATE order — never completion order — so the accessible list and the
 * warn sequence stay identical to a strictly sequential scan. A fatal fault
 * is rethrown from that same candidate-order walk, so two packs completing
 * in reverse of candidate order still surface the EARLIER candidate's fault,
 * never whichever happened to finish first.
 */
export async function resolveIndexes(
  ctx: Context,
  packs: ReadonlyArray<RegisteredPack>,
  warnedIdx: Set<string>,
): Promise<IndexedPacks> {
  const outcomes = await boundedMapFor(ctx, 'ioBound', packs, loadIndexOutcome);
  const loaded: IndexedPack[] = [];
  const faults: Array<{ readonly name: string; readonly data: TsgitErrorData }> = [];
  packs.forEach((pack, position) => {
    const outcome = outcomes[position]!;
    if (outcome.kind === 'fatal') throw outcome.error;
    if (outcome.kind === 'loaded') {
      loaded.push({ pack, index: outcome.index });
      return;
    }
    faults.push({ name: pack.name, data: outcome.data });
    warnUnreadableIndexOnce(ctx, pack.name, outcome.data, warnedIdx);
  });
  return { packs: loaded, packList: loaded.map((entry) => entry.pack), indexFaults: faults };
}
