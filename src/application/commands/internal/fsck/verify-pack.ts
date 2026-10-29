import { TsgitError } from '../../../../domain/error.js';
import { bytesEqual } from '../../../../domain/objects/encoding.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import {
  crc32,
  entryOffsetsF64,
  objectIdAt,
  PACK_ENTRY_TYPE,
  type PackIndex,
  parsePackEntryHeader,
  recordedEntryCrc,
} from '../../../../domain/storage/index.js';
import type { Context } from '../../../../ports/context.js';
import type { Hasher } from '../../../../ports/hash-service.js';
import { resolvePackChain } from '../../../primitives/object-resolver.js';
import {
  getObjectStore,
  type ObjectSource,
  type ObjectStore,
} from '../../../primitives/object-store.js';
import type { RegisteredPack } from '../../../primitives/pack-registry.js';
import {
  type CatalogueOptions,
  type ContentValidationResult,
  validatePackedEntry,
} from './content-validation.js';
import { EXIT_CORRUPT } from './exit-codes.js';
import type { ReadCopy } from './object-table.js';
import { packAccessibilityReported } from './pack-health.js';
import { packsInVerifyOrder } from './pack-verify-order.js';
import { attributeTo } from './source-attribution.js';
import type { FsckFinding, FsckOptions } from './types.js';

type PackFinding = Extract<
  FsckFinding,
  { type: 'pack-index-checksum-mismatch' | 'pack-checksum-mismatch' | 'pack-crc-mismatch' }
>;

/**
 * Index positions ordered by the pack offset each entry starts at, every offset below `bound`.
 * Offsets are unique, so `offset * count + position` orders exactly as the offsets do and
 * carries its position back out: one native numeric sort, no comparator call per pair. A key
 * past the largest integer a double holds exactly would round, so a pack that large takes the
 * comparator sort instead.
 */
export function positionsByOffset(offsets: Float64Array, bound: number): ReadonlyArray<number> {
  const count = offsets.length;
  if (bound * count > Number.MAX_SAFE_INTEGER) {
    return Array.from(offsets.keys()).sort((left, right) => offsets[left]! - offsets[right]!);
  }
  const keys = offsets.map((offset, position) => offset * count + position).sort();
  return Array.from(keys, (key) => key % count);
}

async function indexChecksumHolds(ctx: Context, index: PackIndex): Promise<boolean> {
  const bodyEnd = index._bytes.length - index.digestLength;
  const digest = await ctx.hash.hash(index._bytes.subarray(0, bodyEnd));
  return bytesEqual(digest, index._bytes.subarray(bodyEnd));
}

/** What walking a pack's entries reported: the entries that failed to unpack, and
 *  of those the delta bases a failing child of the same pack named. */
interface EntriesResult extends ContentValidationResult {
  readonly unpackable: ReadonlyArray<ObjectId>;
  readonly badBases: ReadonlySet<ObjectId>;
}

interface EntryScan {
  readonly checksumHolds: boolean;
  readonly entries: EntriesResult;
  readonly ids: ReadonlyArray<ObjectId>;
}

/**
 * What verifying packs reported, and every entry it handed to `fsck_obj_buffer`.
 * `badBases` are the delta bases that failed to unpack and that a delta child failing
 * in the same pack named as its base: git's `check_object` fails to read those, so its
 * walk calls them missing, where a corrupt entry no child leans on stays pack-held.
 */
export interface VerifyPackResult extends ContentValidationResult {
  readonly copies: ReadonlyArray<ReadCopy>;
  readonly badBases: ReadonlySet<ObjectId>;
}

/** Where `verifyOnePack` stands: which pack of which source, and how to report it. */
interface PackUnderVerification {
  readonly store: ObjectStore;
  readonly source: ObjectSource;
  readonly pack: RegisteredPack;
  readonly catalogue: CatalogueOptions;
}

/** git's per-entry steps: the `.idx` CRC, then the entry unpacked from its own offset. */
async function verifyEntry(
  ctx: Context,
  target: PackUnderVerification,
  bytes: Uint8Array,
  entry: { readonly id: ObjectId; readonly offset: number; readonly crc: number },
): Promise<ContentValidationResult> {
  const { store, source, pack } = target;
  const { id, offset } = entry;
  const crc = crc32(bytes) === entry.crc ? [] : [crcMismatch(pack.name, id, offset)];
  const unpacked = await validatePackedEntry(
    ctx,
    {
      id,
      location: { pack: pack.name, offset, attribution: attributeTo(store, source) },
      unpack: () => resolvePackChain(ctx, store, source, { pack, offset }, id, undefined),
    },
    target.catalogue,
  );
  return {
    findings: [...crc, ...unpacked.findings],
    exitBit: (crc.length > 0 ? EXIT_CORRUPT : 0) | unpacked.exitBit,
  };
}

/**
 * One sequential read of the pack: the bytes before the first entry, then
 * every entry in offset order — hashed for the trailer check, CRC'd against
 * the `.idx` and unpacked on the way, so the pack is read exactly once.
 */
async function scanEntries(
  ctx: Context,
  target: PackUnderVerification,
  index: PackIndex,
): Promise<EntryScan> {
  const { pack } = target;
  const layout = await entryLayoutOf(pack, index);
  const hasher = ctx.hash.createHasher();
  hasher.update(await pack.readSlice(0, layout.starts[0] ?? layout.trailerStart));
  const entries = await verifyEntriesInOrder({ ctx, target, index, layout, hasher });
  const trailer = await pack.readSlice(layout.trailerStart, index.digestLength);
  return {
    checksumHolds: bytesEqual(await hasher.digest(), trailer),
    entries,
    ids: layout.order.map((position) => objectIdAt(index, position)),
  };
}

/** Where a pack's entries sit: index positions in offset order, their start
 *  offsets in that order, and where the trailer begins. */
interface EntryLayout {
  readonly order: ReadonlyArray<number>;
  readonly starts: ReadonlyArray<number>;
  readonly trailerStart: number;
}

async function entryLayoutOf(pack: RegisteredPack, index: PackIndex): Promise<EntryLayout> {
  const { trailerStart } = await pack.offsetTable();
  const offsets = entryOffsetsF64(index);
  const order = positionsByOffset(offsets, trailerStart);
  return { order, starts: order.map((position) => offsets[position]!), trailerStart };
}

/** One pass over a pack's entries: what it reads, and the hasher the bytes feed. */
interface EntryWalk {
  readonly ctx: Context;
  readonly target: PackUnderVerification;
  readonly index: PackIndex;
  readonly layout: EntryLayout;
  readonly hasher: Hasher;
}

/** Every entry in offset order — hashed for the trailer check, CRC'd against
 *  the `.idx` and unpacked on the way. */
async function verifyEntriesInOrder(walk: EntryWalk): Promise<EntriesResult> {
  const findings: FsckFinding[] = [];
  const unpackable: UnpackableEntry[] = [];
  let exitBit = 0;
  for (const [rank, position] of walk.layout.order.entries()) {
    const step = await verifyEntryAt(walk, rank, position);
    findings.push(...step.findings);
    exitBit |= step.exitBit;
    recordUnpackable(unpackable, step.findings, step);
  }
  return {
    findings,
    exitBit,
    unpackable: unpackable.map((entry) => entry.id),
    badBases: failedBasesOf(unpackable),
  };
}

/** What one entry reported, and how to name the base it leans on. */
interface EntryStep extends ContentValidationResult {
  readonly id: ObjectId;
  readonly base: () => ObjectId | undefined;
}

/** The entry at `rank` in offset order: its bytes fed to the hasher, then verified. */
async function verifyEntryAt(walk: EntryWalk, rank: number, position: number): Promise<EntryStep> {
  const { ctx, target, index, layout, hasher } = walk;
  const offset = layout.starts[rank]!;
  const end = layout.starts[rank + 1] ?? layout.trailerStart;
  const bytes = await target.pack.readSlice(offset, end - offset);
  hasher.update(bytes);
  const id = objectIdAt(index, position);
  const crc = recordedEntryCrc(index, position);
  const own = await verifyEntry(ctx, target, bytes, { id, offset, crc });
  return { ...own, id, base: () => baseNamedBy(ctx, index, layout, { bytes, offset }) };
}

/** The base is resolved lazily: only an entry that failed to unpack needs it. */
function recordUnpackable(
  unpackable: UnpackableEntry[],
  findings: ReadonlyArray<FsckFinding>,
  entry: { readonly id: ObjectId; readonly base: () => ObjectId | undefined },
): void {
  if (!findings.some((finding) => finding.type === 'pack-entry-unpackable')) return;
  unpackable.push({ id: entry.id, base: entry.base() });
}

/** An entry that failed to unpack, and the base its header names. */
interface UnpackableEntry {
  readonly id: ObjectId;
  readonly base: ObjectId | undefined;
}

/** Judged once the walk ends: a base placed after its children is only known to have failed then. */
function failedBasesOf(unpackable: ReadonlyArray<UnpackableEntry>): ReadonlySet<ObjectId> {
  const failed = new Set(unpackable.map((entry) => entry.id));
  const bases = unpackable.flatMap(({ base }) => (base === undefined ? [] : [base]));
  return new Set(bases.filter((base) => failed.has(base)));
}

/**
 * The base a delta entry names, read from its header; undefined for a whole
 * object, or for a header too damaged to read, which names no base to blame.
 */
function baseNamedBy(
  ctx: Context,
  index: PackIndex,
  layout: EntryLayout,
  entry: { readonly bytes: Uint8Array; readonly offset: number },
): ObjectId | undefined {
  try {
    const header = parsePackEntryHeader(entry.bytes, 0, ctx.hashConfig);
    if (header.type === PACK_ENTRY_TYPE.REF_DELTA) return header.baseId;
    if (header.type !== PACK_ENTRY_TYPE.OFS_DELTA) return undefined;
    // git's get_delta_base names no base unless it starts strictly before the delta.
    if (header.baseDistance === 0) return undefined;
    const rank = rankOfStart(layout.starts, entry.offset - header.baseDistance);
    return rank < 0 ? undefined : objectIdAt(index, layout.order[rank]!);
  } catch (error) {
    if (error instanceof TsgitError) return undefined;
    throw error;
  }
}

/** The position of `offset` in the ascending `starts`, or -1 when no entry starts there. */
export function rankOfStart(starts: ReadonlyArray<number>, offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = starts[middle]!;
    if (start === offset) return middle;
    if (start < offset) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

const crcMismatch = (pack: string, id: ObjectId, offset: number): PackFinding => ({
  type: 'pack-crc-mismatch',
  pack,
  id,
  offset,
});

/** git's `verify_pack` for one pack: `.idx` trailer, pack trailer, then every entry. */
async function verifyOnePack(
  ctx: Context,
  target: PackUnderVerification,
): Promise<EntriesResult & Pick<EntryScan, 'ids'>> {
  const { pack } = target;
  const index = await pack.index();
  const findings: FsckFinding[] = [];
  if (!(await indexChecksumHolds(ctx, index))) {
    findings.push({ type: 'pack-index-checksum-mismatch', pack: pack.name });
  }
  const scan = await scanEntries(ctx, target, index);
  if (!scan.checksumHolds) findings.push({ type: 'pack-checksum-mismatch', pack: pack.name });
  const ownBit = findings.length > 0 ? EXIT_CORRUPT : 0;
  return {
    findings: [...findings, ...scan.entries.findings],
    exitBit: ownBit | scan.entries.exitBit,
    unpackable: scan.entries.unpackable,
    badBases: scan.entries.badBases,
    ids: scan.ids,
  };
}

function tally(counts: Map<ObjectId, number>, ids: Iterable<ObjectId>): void {
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
}

/** A base another pack still serves is not corrupt as far as git's read goes. */
export function unservedBases(
  bases: ReadonlySet<ObjectId>,
  failedCopies: ReadonlyMap<ObjectId, number>,
  copies: ReadonlyArray<{ readonly id: ObjectId }>,
): ReadonlySet<ObjectId> {
  if (bases.size === 0) return bases;
  const held = new Map<ObjectId, number>();
  for (const { id } of copies) {
    if (bases.has(id)) held.set(id, (held.get(id) ?? 0) + 1);
  }
  return new Set([...bases].filter((id) => held.get(id) === failedCopies.get(id)));
}

/**
 * Verify every accessible pack of every object source, in git's source
 * order — full mode only, as git runs `verify_pack` only under `check_full`
 * and never with `--connectivity-only`. Any finding sets bit 1.
 */
export async function runVerifyPackPass(
  ctx: Context,
  opts: FsckOptions,
  catalogue: CatalogueOptions,
): Promise<VerifyPackResult> {
  if (!packAccessibilityReported(opts))
    return { findings: [], exitBit: 0, copies: [], badBases: new Set() };
  const store = await getObjectStore(ctx);
  const findings: FsckFinding[] = [];
  const copies: ReadCopy[] = [];
  const badBases = new Set<ObjectId>();
  const failedCopies = new Map<ObjectId, number>();
  let exitBit = 0;
  for (const [source, packs] of await packsInVerifyOrder(ctx, store)) {
    const attribution = attributeTo(store, source);
    for (const pack of packs) {
      const own = await verifyOnePack(ctx, { store, source, pack, catalogue });
      for (const finding of own.findings) findings.push({ ...finding, ...attribution });
      for (const id of own.ids) copies.push({ id, pack: pack.name, ...attribution });
      for (const id of own.badBases) badBases.add(id);
      tally(failedCopies, own.unpackable);
      exitBit |= own.exitBit;
    }
  }
  return { findings, exitBit, copies, badBases: unservedBases(badBases, failedCopies, copies) };
}
