import { bytesEqual } from '../../../../domain/objects/encoding.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import {
  crc32,
  entryOffsetsF64,
  objectIdAt,
  type PackIndex,
  recordedEntryCrc,
} from '../../../../domain/storage/index.js';
import type { Context } from '../../../../ports/context.js';
import { getObjectStore } from '../../../primitives/object-store.js';
import type { RegisteredPack } from '../../../primitives/pack-registry.js';
import { EXIT_PACK } from './exit-codes.js';
import { packAccessibilityReported } from './pack-health.js';
import { attributeTo } from './source-attribution.js';
import type { FsckFinding, FsckOptions } from './types.js';

type PackFinding = Extract<
  FsckFinding,
  { type: 'pack-index-checksum-mismatch' | 'pack-checksum-mismatch' | 'pack-crc-mismatch' }
>;

/** Index positions ordered by the pack offset each entry starts at. */
function positionsByOffset(offsets: Float64Array): ReadonlyArray<number> {
  return Array.from(offsets.keys()).sort((left, right) => offsets[left]! - offsets[right]!);
}

async function indexChecksumHolds(ctx: Context, index: PackIndex): Promise<boolean> {
  const bodyEnd = index._bytes.length - index.digestLength;
  const digest = await ctx.hash.hash(index._bytes.subarray(0, bodyEnd));
  return bytesEqual(digest, index._bytes.subarray(bodyEnd));
}

interface EntryScan {
  readonly checksumHolds: boolean;
  readonly crcMismatches: ReadonlyArray<PackFinding>;
}

/**
 * One sequential read of the pack: the bytes before the first entry, then
 * every entry in offset order — hashed for the trailer check and CRC'd
 * against the `.idx` on the way, so the pack is read exactly once.
 */
async function scanEntries(
  ctx: Context,
  pack: RegisteredPack,
  index: PackIndex,
): Promise<EntryScan> {
  const { trailerStart } = await pack.offsetTable();
  const offsets = entryOffsetsF64(index);
  const order = positionsByOffset(offsets);
  const starts = order.map((position) => offsets[position]!);
  const hasher = ctx.hash.createHasher();
  hasher.update(await pack.readSlice(0, starts[0] ?? trailerStart));
  const crcMismatches: PackFinding[] = [];
  for (const [rank, position] of order.entries()) {
    const start = starts[rank]!;
    const bytes = await pack.readSlice(start, (starts[rank + 1] ?? trailerStart) - start);
    hasher.update(bytes);
    if (crc32(bytes) === recordedEntryCrc(index, position)) continue;
    crcMismatches.push(crcMismatch(pack.name, objectIdAt(index, position), start));
  }
  const trailer = await pack.readSlice(trailerStart, index.digestLength);
  return { checksumHolds: bytesEqual(await hasher.digest(), trailer), crcMismatches };
}

const crcMismatch = (pack: string, id: ObjectId, offset: number): PackFinding => ({
  type: 'pack-crc-mismatch',
  pack,
  id,
  offset,
});

/** git's `verify_pack` for one pack: `.idx` trailer, pack trailer, then per-entry CRC. */
async function verifyOnePack(ctx: Context, pack: RegisteredPack): Promise<PackFinding[]> {
  const index = await pack.index();
  const findings: PackFinding[] = [];
  if (!(await indexChecksumHolds(ctx, index))) {
    findings.push({ type: 'pack-index-checksum-mismatch', pack: pack.name });
  }
  const scan = await scanEntries(ctx, pack, index);
  if (!scan.checksumHolds) findings.push({ type: 'pack-checksum-mismatch', pack: pack.name });
  return [...findings, ...scan.crcMismatches];
}

/**
 * Verify every accessible pack of every object source, in git's source
 * order — full mode only, as git runs `verify_pack` only under `check_full`
 * and never with `--connectivity-only`. Any finding sets bit 4.
 */
export async function runVerifyPackPass(
  ctx: Context,
  opts: FsckOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }> {
  if (!packAccessibilityReported(opts)) return { findings: [], exitBit: 0 };
  const store = await getObjectStore(ctx);
  const findings: FsckFinding[] = [];
  for (const source of store.sources) {
    const attribution = attributeTo(store, source);
    for (const pack of (await source.registry.health()).accessible) {
      const own = await verifyOnePack(ctx, pack);
      findings.push(...own.map((finding) => ({ ...finding, ...attribution })));
    }
  }
  return { findings, exitBit: findings.length > 0 ? EXIT_PACK : 0 };
}
