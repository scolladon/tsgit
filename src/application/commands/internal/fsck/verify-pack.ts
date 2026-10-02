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
  readonly entries: ContentValidationResult;
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
    exitBit: (crc.length > 0 ? EXIT_PACK : 0) | unpacked.exitBit,
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
  const { trailerStart } = await pack.offsetTable();
  const offsets = entryOffsetsF64(index);
  const order = positionsByOffset(offsets);
  const starts = order.map((position) => offsets[position]!);
  const hasher = ctx.hash.createHasher();
  hasher.update(await pack.readSlice(0, starts[0] ?? trailerStart));
  const findings: FsckFinding[] = [];
  let exitBit = 0;
  for (const [rank, position] of order.entries()) {
    const offset = starts[rank]!;
    const bytes = await pack.readSlice(offset, (starts[rank + 1] ?? trailerStart) - offset);
    hasher.update(bytes);
    const id = objectIdAt(index, position);
    const own = await verifyEntry(ctx, target, bytes, {
      id,
      offset,
      crc: recordedEntryCrc(index, position),
    });
    findings.push(...own.findings);
    exitBit |= own.exitBit;
  }
  const trailer = await pack.readSlice(trailerStart, index.digestLength);
  return {
    checksumHolds: bytesEqual(await hasher.digest(), trailer),
    entries: { findings, exitBit },
  };
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
): Promise<ContentValidationResult> {
  const { pack } = target;
  const index = await pack.index();
  const findings: FsckFinding[] = [];
  if (!(await indexChecksumHolds(ctx, index))) {
    findings.push({ type: 'pack-index-checksum-mismatch', pack: pack.name });
  }
  const scan = await scanEntries(ctx, target, index);
  if (!scan.checksumHolds) findings.push({ type: 'pack-checksum-mismatch', pack: pack.name });
  const ownBit = findings.length > 0 ? EXIT_PACK : 0;
  return {
    findings: [...findings, ...scan.entries.findings],
    exitBit: ownBit | scan.entries.exitBit,
  };
}

/**
 * Verify every accessible pack of every object source, in git's source
 * order — full mode only, as git runs `verify_pack` only under `check_full`
 * and never with `--connectivity-only`. Any finding sets bit 4.
 */
export async function runVerifyPackPass(
  ctx: Context,
  opts: FsckOptions,
  catalogue: CatalogueOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }> {
  if (!packAccessibilityReported(opts)) return { findings: [], exitBit: 0 };
  const store = await getObjectStore(ctx);
  const findings: FsckFinding[] = [];
  let exitBit = 0;
  for (const source of store.sources) {
    const attribution = attributeTo(store, source);
    for (const pack of (await source.registry.health()).accessible) {
      const own = await verifyOnePack(ctx, { store, source, pack, catalogue });
      findings.push(...own.findings.map((finding) => ({ ...finding, ...attribution })));
      exitBit |= own.exitBit;
    }
  }
  return { findings, exitBit };
}
