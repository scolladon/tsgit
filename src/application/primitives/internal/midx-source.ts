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
import type { TsgitError, TsgitErrorData } from '../../../domain/error.js';
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
  MAX_MIDX_CHAIN_LAYERS,
  REASON_MIDX_CHAIN_TOO_LONG,
  REASON_MIDX_EXCEEDS_MAX,
} from '../validators.js';

const FLAT_ARTEFACT = 'multi-pack-index';
const CHAIN_ARTEFACT = 'multi-pack-index-chain';
const REASON_MIDX_IRREGULAR_FILE = 'multi-pack-index artefact is not a regular file';
const REASON_MIDX_CHAIN_DUPLICATE = 'multi-pack-index chain lists a layer digest twice';

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
/**
 * Structural, never `instanceof`: the probes below classify errors thrown by
 * `ctx.fs`, and in mixed-module-graph test harnesses (a source-graph
 * registry over a dist-bundle Context) the adapter's `TsgitError` class is
 * a different identity than this module's. The `data.code` shape is the
 * stable contract; class identity is not.
 *
 * Exported for the pack registry's own `objects/pack` listing probe, which
 * classifies errors from the same `ctx.fs` and so faces the same hazard.
 */
export function errorDataCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { readonly data?: { readonly code?: unknown } }).data;
  return typeof data?.code === 'string' ? data.code : undefined;
}

export function isTierBMidxFault(err: unknown): err is TsgitError {
  const code = errorDataCode(err);
  // NOT_A_DIRECTORY joins the two absence-ish codes: it is what probing
  // `objects/pack/multi-pack-index` reports when `objects/pack` is itself a
  // regular file. Canonical git prints `error: unable to open object pack
  // directory: …: Not a directory` and still serves a loose read at exit 0 —
  // it dies during object-store setup on a self-inconsistent multi-pack-index,
  // never on the pack directory's shape. Treating it as a Tier-B discard is
  // what reproduces that.
  if (code === 'FILE_NOT_FOUND' || code === 'PERMISSION_DENIED' || code === 'NOT_A_DIRECTORY') {
    return true;
  }
  if (code !== 'INVALID_MULTI_PACK_INDEX') return false;
  const check = (err as { readonly data: { readonly check: MidxCheck } }).data.check;
  return tierOf(check) === 'B';
}

function isFileNotFound(error: unknown): boolean {
  return errorDataCode(error) === 'FILE_NOT_FOUND';
}

function layerArtefactName(digest: string): string {
  return `multi-pack-index-${digest}.midx`;
}

type FlatPresence =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly stat: FileStat }
  | { readonly kind: 'fault'; readonly fault: MidxFault };

/**
 * Presence probe for the flat file. An io fault the tier map classifies as
 * Tier B (a permission-denied stat from an out-of-root symlink or a symlink
 * loop) is a recorded discard, never a propagated denial — git proceeds
 * without the midx in every such shape. A non-regular entry (FIFO, socket,
 * directory) is likewise discarded rather than opened: reading a FIFO would
 * block every object read in the repository indefinitely.
 */
async function probeFlat(ctx: Context, path: string): Promise<FlatPresence> {
  let stat: FileStat;
  try {
    stat = await ctx.fs.stat(path);
  } catch (error) {
    if (isFileNotFound(error)) return { kind: 'absent' };
    if (!isTierBMidxFault(error)) throw error;
    return { kind: 'fault', fault: { artefact: FLAT_ARTEFACT, data: error.data } };
  }
  if (!stat.isFile) {
    return {
      kind: 'fault',
      fault: {
        artefact: FLAT_ARTEFACT,
        data: invalidMultiPackIndex('size', REASON_MIDX_IRREGULAR_FILE).data,
      },
    };
  }
  return { kind: 'present', stat };
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
 * Cursor walk, never a `split`: the cap must fire before anything scales
 * with the manifest's size, and a split would materialise every line of a
 * hostile many-line file first. A trailing newline yields a final empty
 * slice, which never matches the hex pattern and terminates the run at
 * exactly the real end. Collection stops one past the layer cap so the
 * caller can still detect the over-cap condition.
 */
function leadingHexRun(chainText: string, digestLength: number): ReadonlyArray<string> {
  const hexLine = new RegExp(`^[0-9a-f]{${digestLength * 2}}$`);
  const digests: string[] = [];
  let cursor = 0;
  // Stryker disable next-line LogicalOperator,ConditionalExpression,EqualityOperator: equivalent — cursor only ever advances to a newline index found via indexOf within [0,chainText.length), so cursor<=chainText.length always holds here; once cursor reaches the true end the next slice is '' and hexLine.test('') breaks the loop before any push, and any cap overshoot yields the identical exceedsMaxMidxChainLayers() verdict regardless of magnitude — so weakening either operand (< vs <=, && vs ||, or forcing either side true) never changes the returned digests.
  while (cursor <= chainText.length && digests.length <= MAX_MIDX_CHAIN_LAYERS) {
    const newline = chainText.indexOf('\n', cursor);
    const line = newline === -1 ? chainText.slice(cursor) : chainText.slice(cursor, newline);
    if (!hexLine.test(line)) break;
    digests.push(line);
    if (newline === -1) break;
    cursor = newline + 1;
  }
  return digests;
}

/**
 * The manifest's own shape bound: one hex digest plus newline per layer up
 * to the layer cap, with two spare lines of slack. Sized in the tens of
 * kilobytes — never the midx body's own gigabyte-scale artefact bound, whose
 * reuse here would admit a manifest large enough to exceed V8's string
 * limit (a process abort, not an error a catch can contain) before any
 * cap could fire.
 */
function maxChainManifestBytes(digestLength: number): number {
  return (MAX_MIDX_CHAIN_LAYERS + 2) * (digestLength * 2 + 1);
}

type ChainManifest =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'oversized' };

/**
 * Absent, empty, irregular (a directory or FIFO at the manifest path) or
 * unreadable all mean "no chain" — silently, with no fault recorded, the
 * design's pinned posture for a broken manifest. The read is stat-bounded
 * first so a hostile manifest is refused before it is decoded, and a FIFO
 * is never opened (an open would block every read).
 */
async function readChainManifest(
  ctx: Context,
  chainPath: string,
  digestLength: number,
): Promise<ChainManifest> {
  const maxBytes = maxChainManifestBytes(digestLength);
  let stat: FileStat;
  try {
    stat = await ctx.fs.stat(chainPath);
  } catch (error) {
    if (isFileNotFound(error) || isTierBMidxFault(error)) return { kind: 'none' };
    throw error;
  }
  if (!stat.isFile) return { kind: 'none' };
  if (stat.size > maxBytes) return { kind: 'oversized' };
  try {
    const text = await ctx.fs.readUtf8(chainPath);
    return text.length > maxBytes ? { kind: 'oversized' } : { kind: 'text', text };
  } catch (error) {
    if (isTierBMidxFault(error)) return { kind: 'none' };
    throw error;
  }
}

interface ChainOutcome {
  readonly set: MidxSet | undefined;
  readonly faults: ReadonlyArray<MidxFault>;
}

const NO_CHAIN: ChainOutcome = { set: undefined, faults: [] };

function chainFault(reason: string): ChainOutcome {
  return {
    set: undefined,
    faults: [{ artefact: CHAIN_ARTEFACT, data: invalidMultiPackIndex('size', reason).data }],
  };
}

function hasDuplicateDigest(digests: ReadonlyArray<string>): boolean {
  return new Set(digests).size !== digests.length;
}

async function loadChain(
  ctx: Context,
  packsDir: string,
  digestLength: number,
): Promise<ChainOutcome> {
  const manifest = await readChainManifest(ctx, multiPackIndexChainPath(packsDir), digestLength);
  if (manifest.kind === 'none') return NO_CHAIN;
  // The manifest's bound derives from the layer cap, so overrunning it IS
  // the too-many-layers condition — not the artefact-size one.
  if (manifest.kind === 'oversized') return chainFault(REASON_MIDX_CHAIN_TOO_LONG);

  const digests = leadingHexRun(manifest.text, digestLength);
  if (digests.length === 0) return NO_CHAIN;

  if (exceedsMaxMidxChainLayers(digests.length)) {
    return chainFault(REASON_MIDX_CHAIN_TOO_LONG);
  }
  // A repeated digest would load (and retain) the same layer twice — the one
  // shape that lets a small manifest amplify its on-disk bytes in memory. A
  // git-written chain never repeats a digest, so refusing costs nothing.
  if (hasDuplicateDigest(digests)) {
    return chainFault(REASON_MIDX_CHAIN_DUPLICATE);
  }

  const layers: MultiPackIndex[] = [];
  // One artefact budget for the WHOLE chain, not per layer: distinct hostile
  // layers must not sum past what a single flat midx may occupy in memory.
  let totalLayerBytes = 0;
  for (const digest of digests) {
    const layerPath = multiPackIndexLayerPath(packsDir, digest);
    try {
      const stat = await ctx.fs.stat(layerPath);
      if (!stat.isFile) {
        throw invalidMultiPackIndex('size', REASON_MIDX_IRREGULAR_FILE);
      }
      totalLayerBytes += stat.size;
      if (exceedsMaxMidxBytes(totalLayerBytes)) {
        throw invalidMultiPackIndex('size', REASON_MIDX_EXCEEDS_MAX);
      }
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
  const presence = await probeFlat(ctx, flatPath);

  if (presence.kind === 'absent') {
    const chain = await loadChain(ctx, packsDir, digestLength);
    return { set: chain.set, faults: chain.faults, flatFilePresent: false };
  }

  if (presence.kind === 'fault') {
    const chain = await loadChain(ctx, packsDir, digestLength);
    return {
      set: chain.set,
      faults: [presence.fault, ...chain.faults],
      flatFilePresent: true,
    };
  }

  const flatOutcome = await loadFlatBody(ctx, flatPath, presence.stat.size, digestLength);
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
