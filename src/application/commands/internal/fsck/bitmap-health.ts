import { bytesEqual } from '../../../../domain/objects/encoding.js';
import type { Context } from '../../../../ports/context.js';
import type { ArtefactLoad } from '../../../primitives/internal/pack-artefact-source.js';
import { getObjectStore, type ObjectSource } from '../../../primitives/object-store.js';
import { EXIT_BITMAP } from './exit-codes.js';
import { attributeTo } from './source-attribution.js';
import type { FsckFinding, FsckOptions } from './types.js';

/**
 * Verifies a bitmap's trailing digest against the bytes that precede it —
 * this pass's ENTIRE obligation. Git's own bitmap obligation is the same
 * single comparison, so parsing the container here would make tsgit
 * *stricter* than git, itself a divergence.
 *
 * `len < digestLength` is treated as a mismatch, never a negative
 * `subarray` bound: a zero-length file and a file a few bytes short of one
 * digest both score this bit under git, so the length guard runs first and
 * produces the mismatch directly.
 */
async function verifyBitmapTrailer(ctx: Context, bytes: Uint8Array): Promise<boolean> {
  const digestLength = ctx.hashConfig.digestLength;
  if (bytes.length < digestLength) return false;
  const bodyEnd = bytes.length - digestLength;
  const digest = await ctx.hash.hash(bytes.subarray(0, bodyEnd));
  return bytesEqual(digest, bytes.subarray(bodyEnd));
}

type Attribution = { readonly objectsDir?: string };

/** Returns a `bitmap-checksum-mismatch` finding when `load` is usable but its
 *  trailer disagrees; a non-`usable` load (absent/unreadable/refused) is
 *  silent, same as every other artefact's degradation posture here. */
async function checkBitmapLoad(
  ctx: Context,
  attribution: Attribution,
  artefact: string,
  load: ArtefactLoad<Uint8Array>,
): Promise<ReadonlyArray<FsckFinding>> {
  if (load.kind !== 'usable') return [];
  if (await verifyBitmapTrailer(ctx, load.bytes)) return [];
  return [{ type: 'bitmap-checksum-mismatch', artefact, ...attribution }];
}

async function midxBitmapFindings(
  ctx: Context,
  source: ObjectSource,
  attribution: Attribution,
): Promise<ReadonlyArray<FsckFinding>> {
  const midxBitmap = await source.registry.midxBitmap();
  if (midxBitmap === undefined) return [];
  return checkBitmapLoad(ctx, attribution, midxBitmap.artefact, midxBitmap);
}

async function packBitmapFindings(
  ctx: Context,
  source: ObjectSource,
  attribution: Attribution,
): Promise<ReadonlyArray<FsckFinding>> {
  const findings: FsckFinding[] = [];
  for (const pack of await source.registry.all()) {
    const load = await pack.bitmapBytes();
    findings.push(...(await checkBitmapLoad(ctx, attribution, `${pack.name}.bitmap`, load)));
  }
  return findings;
}

/**
 * Report a pack's, or the in-use multi-pack-index's, bitmap purely by
 * trailing checksum — never by parsing the container (no header parse, no
 * version gate, no flag gate, no stream walk). Runs after
 * `runMidxHealthPass` (`fsck.ts`), which is what settles the in-use midx
 * layer's identity the second step needs.
 *
 * Follows git's `verify_bitmap_files` order: every source's midx bitmap,
 * then every source's pack bitmaps.
 *
 * `opts` is taken for symmetry and ignored: bit 128 fires identically in
 * every mode, and the midx arm below is unconditional — tsgit declines
 * git's `core.multiPackIndex` gate on this pass as a deliberate divergence.
 */
export async function runBitmapHealthPass(
  ctx: Context,
  _opts: FsckOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }> {
  const store = await getObjectStore(ctx);
  const findings: FsckFinding[] = [];
  for (const arm of [midxBitmapFindings, packBitmapFindings]) {
    for (const source of store.sources) {
      findings.push(...(await arm(ctx, source, attributeTo(store, source))));
    }
  }
  return { findings, exitBit: findings.length > 0 ? EXIT_BITMAP : 0 };
}
