import { bytesEqual } from '../../../../domain/objects/encoding.js';
import type { Context } from '../../../../ports/context.js';
import type { ArtefactLoad } from '../../../primitives/internal/pack-artefact-source.js';
import { getPackRegistry } from '../../../primitives/read-object.js';
import { EXIT_BITMAP } from './exit-codes.js';
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

/** Pushes a `bitmap-checksum-mismatch` finding when `load` is usable but its
 *  trailer disagrees; a non-`usable` load (absent/unreadable/refused) is
 *  silent, same as every other artefact's degradation posture here. Returns
 *  whether a finding was pushed, for the caller's exit-bit fold. */
async function checkBitmapLoad(
  ctx: Context,
  findings: FsckFinding[],
  artefact: string,
  load: ArtefactLoad<Uint8Array>,
): Promise<boolean> {
  if (load.kind !== 'usable') return false;
  if (await verifyBitmapTrailer(ctx, load.bytes)) return false;
  findings.push({ type: 'bitmap-checksum-mismatch', artefact });
  return true;
}

/**
 * Report a pack's, or the in-use multi-pack-index's, bitmap purely by
 * trailing checksum — never by parsing the container (no header parse, no
 * version gate, no flag gate, no stream walk). Runs after
 * `runMidxHealthPass` (`fsck.ts`), which is what settles the in-use midx
 * layer's identity the second step needs.
 *
 * `opts` is taken for symmetry and ignored: bit 128 fires identically in
 * every mode, and the midx arm below is unconditional — tsgit declines
 * git's `core.multiPackIndex` gate on this pass as a deliberate divergence.
 */
export async function runBitmapHealthPass(
  ctx: Context,
  _opts: FsckOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }> {
  const registry = getPackRegistry(ctx);
  const packs = await registry.all();

  const findings: FsckFinding[] = [];
  let exitBit = 0;

  for (const pack of packs) {
    if (!pack.hasBitmap) continue;
    const load = await pack.bitmapBytes();
    if (await checkBitmapLoad(ctx, findings, `${pack.name}.bitmap`, load)) exitBit = EXIT_BITMAP;
  }

  const midxBitmap = await registry.midxBitmap();
  if (midxBitmap !== undefined) {
    const mismatched = await checkBitmapLoad(ctx, findings, midxBitmap.artefact, midxBitmap);
    if (mismatched) exitBit = EXIT_BITMAP;
  }

  return { findings, exitBit };
}
