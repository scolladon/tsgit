import { bytesEqual } from '../../../../domain/objects/encoding.js';
import { type PackRevIndex, revIndexPositionAt } from '../../../../domain/storage/index.js';
import type { Context } from '../../../../ports/context.js';
import { packPositionMap } from '../../../primitives/internal/pack-positions.js';
import { faultReason, type RegisteredPack } from '../../../primitives/pack-registry.js';
import { getPackRegistry } from '../../../primitives/read-object.js';
import { EXIT_PACK_REV_INDEX } from './exit-codes.js';
import type { FsckFinding, FsckOptions } from './types.js';

const REASON_REV_INDEX_CHECKSUM = 'invalid checksum';

/**
 * Verifies the trailer with the REPOSITORY's own hash algorithm
 * (`ctx.hashConfig`), never the artefact's own `hashId` field — canonical
 * git accepts a `.rev` whose `hashId` disagrees with the repository's hash
 * width, so checking against `hashId` would refuse files git reads. This is
 * the opposite of the multi-pack-index trailer rule, where the artefact's
 * own declared algorithm IS what gets hashed.
 */
async function verifyRevIndexTrailer(ctx: Context, rev: PackRevIndex): Promise<boolean> {
  const bodyEnd = rev._bytes.length - ctx.hashConfig.digestLength;
  const digest = await ctx.hash.hash(rev._bytes.subarray(0, bodyEnd));
  return bytesEqual(digest, rev._bytes.subarray(bodyEnd));
}

/** Loop-drain into the shared `findings` array — never a spread, which would
 *  overflow the call stack for a repo-sized mismatch count. Returns whether
 *  any position mismatched, for the caller's exit-bit fold. */
function verifyRevIndexBody(
  findings: FsckFinding[],
  pack: string,
  rev: PackRevIndex,
  expected: Uint32Array,
): boolean {
  let mismatched = false;
  for (let position = 0; position < rev.objectCount; position += 1) {
    const stored = revIndexPositionAt(rev, position);
    const wanted = expected[position]!;
    if (stored === wanted) continue;
    findings.push({
      type: 'pack-rev-index-position-mismatch',
      pack,
      position,
      expected: wanted,
      stored,
    });
    mismatched = true;
  }
  return mismatched;
}

/** Steps 2 (digest) and 3 (body) both run even when the digest disagrees —
 *  git reports the checksum fault and still walks the body. */
async function verifyRevIndexUsable(
  ctx: Context,
  findings: FsckFinding[],
  pack: RegisteredPack,
  rev: PackRevIndex,
): Promise<boolean> {
  const checksumOk = await verifyRevIndexTrailer(ctx, rev);
  if (!checksumOk) {
    findings.push({
      type: 'pack-rev-index-invalid',
      pack: pack.name,
      reason: REASON_REV_INDEX_CHECKSUM,
    });
  }
  const expected = packPositionMap(await pack.index());
  const bodyMismatched = verifyRevIndexBody(findings, pack.name, rev, expected);
  return !checksumOk || bodyMismatched;
}

async function checkOnePack(
  ctx: Context,
  findings: FsckFinding[],
  pack: RegisteredPack,
): Promise<boolean> {
  const load = await pack.revIndex();
  if (load.kind === 'absent' || load.kind === 'unreadable') return false;
  if (load.kind === 'refused') {
    findings.push({
      type: 'pack-rev-index-invalid',
      pack: pack.name,
      reason: faultReason(load.data),
    });
    return true;
  }
  return verifyRevIndexUsable(ctx, findings, pack, load.value);
}

/**
 * Report a pack's `.rev` reverse index against the same universe
 * `runPackHealthPass` reports the pack layer for: `registry.all()`, the
 * packs the scan admitted, never narrowed by pack-open accessibility. A
 * pack whose `.idx` never loaded is never a member of that set, so its
 * `.rev` — usable or not — is never inspected here: canonical git never
 * derives a reverse index from an index it could not load either, which is
 * exactly why the two causes of bit 64 never double-report for one pack.
 * `opts` is taken for symmetry with the other health passes and ignored:
 * this term is ungated, running identically in every mode.
 */
export async function runRevIndexHealthPass(
  ctx: Context,
  _opts: FsckOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }> {
  const registry = getPackRegistry(ctx);
  const packs = await registry.all();

  const findings: FsckFinding[] = [];
  let exitBit = 0;
  for (const pack of packs) {
    if (!pack.hasRevIndex) continue;
    if (await checkOnePack(ctx, findings, pack)) exitBit = EXIT_PACK_REV_INDEX;
  }

  return { findings, exitBit };
}
