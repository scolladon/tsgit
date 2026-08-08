/**
 * Discovers, tiers and loads the multi-pack-index: the flat file wins if it
 * *loads* (not merely exists), the incremental chain is tried only when the
 * flat file is absent or discarded, and the `.idx` scan remains the final
 * fallback when neither exists. Every fault is classified into one of two
 * tiers: a structurally self-inconsistent midx propagates and denies every
 * read; a merely-unusable one is discarded silently in favour of the next
 * source in the precedence order.
 *
 * The trailer checksum is never verified on this path — corruption detection
 * here rests on the filesystem and the parser's own structural checks, not on
 * hashing the whole file on every open.
 */
import { TsgitError, type TsgitErrorData } from '../../../domain/error.js';
import {
  invalidMultiPackIndex,
  type MidxCheck,
  type MultiPackIndex,
  parseMultiPackIndex,
} from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import type { FileStat } from '../../../ports/file-system.js';
import {
  multiPackIndexChainPath,
  multiPackIndexLayerPath,
  multiPackIndexPath,
} from '../path-layout.js';
import {
  exceedsMaxMidxBytes,
  exceedsMaxMidxChainLayers,
  REASON_MIDX_CHAIN_TOO_LONG,
  REASON_MIDX_EXCEEDS_MAX,
} from '../validators.js';

const FLAT_ARTEFACT = 'multi-pack-index';
const CHAIN_ARTEFACT = 'multi-pack-index-chain';

/** An ordered, fully-loaded midx set: one layer for a flat file, N for a
 *  chain (base first). `artefacts` names the on-disk file each layer came
 *  from, in the same order — its last element is the artefact in use for
 *  trailer verification: the flat file, or the chain head. */
export interface MidxSet {
  readonly layers: ReadonlyArray<MultiPackIndex>;
  readonly kind: 'flat' | 'chain';
  readonly artefacts: ReadonlyArray<string>;
}

/** One discarded midx artefact and why. */
export interface MidxFault {
  readonly artefact: string;
  readonly data: TsgitErrorData;
}

export interface MidxLoadResult {
  /** `undefined` ⇒ fall back to the `.idx` scan. */
  readonly set: MidxSet | undefined;
  readonly faults: ReadonlyArray<MidxFault>;
  /** Whether the flat file exists on disk — a stat, not a successful read. */
  readonly flatFilePresent: boolean;
}

type MidxTier = 'A' | 'B';

/** One total function from the closed `MidxCheck` union to a tier. No
 *  `default` arm: a future `MidxCheck` member is a compile error here, not a
 *  runtime surprise. */
function tierOf(check: MidxCheck): MidxTier {
  switch (check) {
    case 'size':
    case 'chunk-table':
    case 'chunk-length':
    case 'hash-version':
      return 'B';
    case 'signature':
    case 'version':
    case 'required-chunk':
    case 'fanout':
    case 'pack-names':
    case 'pack-int-id':
    case 'large-offset':
      return 'A';
  }
}

/**
 * Positive test for Tier B — everything else (a Tier-A midx check, or any
 * code outside the midx/io allow-list) falls through and must be rethrown by
 * the caller. Never invert this into a Tier-A allow-list: that would
 * silently swallow a future `MidxCheck` member the tier map forgot.
 */
export function isTierBMidxFault(err: unknown): err is TsgitError {
  if (!(err instanceof TsgitError)) return false;
  const { data } = err;
  if (data.code === 'FILE_NOT_FOUND' || data.code === 'PERMISSION_DENIED') return true;
  return data.code === 'INVALID_MULTI_PACK_INDEX' && tierOf(data.check) === 'B';
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'FILE_NOT_FOUND';
}

function layerArtefactName(digest: string): string {
  return `multi-pack-index-${digest}.midx`;
}

async function statOrAbsent(ctx: Context, path: string): Promise<FileStat | undefined> {
  try {
    return await ctx.fs.stat(path);
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

/** Bound-checked read + parse of one midx artefact. Throws the parser's own
 *  Tier-A/Tier-B error, or an io fault from the read itself — the caller
 *  classifies via `isTierBMidxFault`. */
async function readAndParseMidx(
  ctx: Context,
  path: string,
  statSize: number,
  digestLength: number,
): Promise<MultiPackIndex> {
  if (exceedsMaxMidxBytes(statSize)) {
    throw invalidMultiPackIndex('size', REASON_MIDX_EXCEEDS_MAX);
  }
  const bytes = await ctx.fs.read(path);
  if (exceedsMaxMidxBytes(bytes.length)) {
    throw invalidMultiPackIndex('size', REASON_MIDX_EXCEEDS_MAX);
  }
  return parseMultiPackIndex(bytes, digestLength);
}

type FlatOutcome =
  | { readonly kind: 'loaded'; readonly midx: MultiPackIndex }
  | { readonly kind: 'discarded'; readonly fault: MidxFault };

/**
 * Load the flat file's body once presence is established. A Tier-A fault is
 * NOT caught here — it propagates to the caller unchanged, which is what
 * makes it escape `loadMidxSet` entirely (the chain is never tried).
 */
async function loadFlatBody(
  ctx: Context,
  flatPath: string,
  statSize: number,
  digestLength: number,
): Promise<FlatOutcome> {
  try {
    const midx = await readAndParseMidx(ctx, flatPath, statSize, digestLength);
    return { kind: 'loaded', midx };
  } catch (error) {
    if (!isTierBMidxFault(error)) throw error;
    return { kind: 'discarded', fault: { artefact: FLAT_ARTEFACT, data: error.data } };
  }
}

/**
 * `.split('\n')` on a chain file's trailing newline always yields a final
 * empty element, which never matches the hex pattern and therefore
 * terminates the run at exactly the real end — no separate trim/filter step
 * is needed to keep a well-formed chain's last real line in the run.
 */
function leadingHexRun(chainText: string, digestLength: number): ReadonlyArray<string> {
  const hexLine = new RegExp(`^[0-9a-f]{${digestLength * 2}}$`);
  const digests: string[] = [];
  for (const line of chainText.split('\n')) {
    if (!hexLine.test(line)) break;
    digests.push(line);
  }
  return digests;
}

/** Absent, empty or unreadable (a TOCTOU race after the presence check) all
 *  mean "no chain" — silently, with no fault recorded. Mirrors the
 *  commit-graph chain reader's own exists-gated, FILE_NOT_FOUND-tolerant
 *  shape; any other read failure still propagates. */
async function readChainText(ctx: Context, chainPath: string): Promise<string | undefined> {
  if (!(await ctx.fs.exists(chainPath))) return undefined;
  try {
    return await ctx.fs.readUtf8(chainPath);
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

interface ChainOutcome {
  readonly set: MidxSet | undefined;
  readonly faults: ReadonlyArray<MidxFault>;
}

const NO_CHAIN: ChainOutcome = { set: undefined, faults: [] };

async function loadChain(
  ctx: Context,
  packsDir: string,
  digestLength: number,
): Promise<ChainOutcome> {
  const chainText = await readChainText(ctx, multiPackIndexChainPath(packsDir));
  if (chainText === undefined) return NO_CHAIN;

  const digests = leadingHexRun(chainText, digestLength);
  if (digests.length === 0) return NO_CHAIN;

  if (exceedsMaxMidxChainLayers(digests.length)) {
    return {
      set: undefined,
      faults: [
        {
          artefact: CHAIN_ARTEFACT,
          data: invalidMultiPackIndex('size', REASON_MIDX_CHAIN_TOO_LONG).data,
        },
      ],
    };
  }

  const layers: MultiPackIndex[] = [];
  for (const digest of digests) {
    const layerPath = multiPackIndexLayerPath(packsDir, digest);
    try {
      const stat = await ctx.fs.stat(layerPath);
      const midx = await readAndParseMidx(ctx, layerPath, stat.size, digestLength);
      layers.push(midx);
    } catch (error) {
      if (!isTierBMidxFault(error)) throw error;
      return {
        set: undefined,
        faults: [{ artefact: layerArtefactName(digest), data: error.data }],
      };
    }
  }

  return {
    set: { layers, kind: 'chain', artefacts: digests.map(layerArtefactName) },
    faults: [],
  };
}

export async function loadMidxSet(ctx: Context, packsDir: string): Promise<MidxLoadResult> {
  const digestLength = ctx.hashConfig.digestLength;
  const flatPath = multiPackIndexPath(packsDir);
  const flatStat = await statOrAbsent(ctx, flatPath);

  if (flatStat === undefined) {
    const chain = await loadChain(ctx, packsDir, digestLength);
    return { set: chain.set, faults: chain.faults, flatFilePresent: false };
  }

  const flatOutcome = await loadFlatBody(ctx, flatPath, flatStat.size, digestLength);
  if (flatOutcome.kind === 'loaded') {
    return {
      set: { layers: [flatOutcome.midx], kind: 'flat', artefacts: [FLAT_ARTEFACT] },
      faults: [],
      flatFilePresent: true,
    };
  }

  const chain = await loadChain(ctx, packsDir, digestLength);
  return {
    set: chain.set,
    faults: [flatOutcome.fault, ...chain.faults],
    flatFilePresent: true,
  };
}
