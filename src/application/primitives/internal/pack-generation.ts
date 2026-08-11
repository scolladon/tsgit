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
interface IndexedPack {
  readonly pack: RegisteredPack;
  /** The settled parse — held here so lookup's fallback loop stays synchronous. */
  readonly index: PackIndex;
}

interface IndexedPacks {
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
  /** The multi-pack-index this generation's scan discovered, produced by the
   *  SAME `scanPacks` call as `packs` — so no consumer can ever pair one
   *  generation's midx with another's packs. Has no reader beyond
   *  `assertLoadable` propagating its rejection: `midx` below is the bound,
   *  lookup-facing view. */
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
 * The single site that classifies an index-layer fault — run once per
 * generation, behind `PackGeneration.indexed`, sequentially in candidate
 * order, never per lookup — so a generation warns for each unreadable index
 * exactly once no matter how many consumers later force the memo. Forces
 * every candidate's `.idx` load, not just the ones a lookup needed, so
 * `all()`, `indexFaults()` and `health()` see a complete classification even
 * when no lookup ever ran.
 */
export async function resolveIndexes(
  ctx: Context,
  packs: ReadonlyArray<RegisteredPack>,
): Promise<IndexedPacks> {
  const loaded: IndexedPack[] = [];
  const faults: Array<{ readonly name: string; readonly data: TsgitErrorData }> = [];
  for (const pack of packs) {
    try {
      loaded.push({ pack, index: await pack.index() });
    } catch (err) {
      if (!isSkippableIdxFault(err)) throw err;
      ctx.logger?.warn?.('packRegistry: skipping unreadable pack index', {
        idx: `${pack.name}.idx`,
        ...faultContext(err.data),
      });
      faults.push({ name: pack.name, data: err.data });
    }
  }
  return { packs: loaded, packList: loaded.map((entry) => entry.pack), indexFaults: faults };
}
