import type { Context } from '../../../../ports/context.js';
import type { MidxFault } from '../../../primitives/internal/midx-source.js';
import { faultReason } from '../../../primitives/pack-registry.js';
import { getPackRegistry } from '../../../primitives/read-object.js';
import { EXIT_MULTI_PACK_INDEX } from './exit-codes.js';
import type { FsckFinding, FsckOptions } from './types.js';

// The only two `MidxCheck` members a load-time parse never settles: the
// registry's own OOFF/LOFF decode defers them to the first entry that needs
// them. A fault carrying either check inside `MidxHealth.faults` can only
// have arrived from the entry-resolution walk this pass's `midxHealth()`
// call runs, never from the load-time discard `loadMidxSet` records — those
// are structurally Tier-B only. Finding one is how this pass recognises "the
// walk hit a contained Tier-A fault" without a dedicated boolean.
function isContainedMidxFault(fault: MidxFault): boolean {
  const { data } = fault;
  return (
    data.code === 'INVALID_MULTI_PACK_INDEX' &&
    (data.check === 'pack-int-id' || data.check === 'large-offset')
  );
}

/**
 * Report the multi-pack-index's own accessibility and integrity, mirroring
 * `runPackHealthPass` structurally. **`opts` is taken for symmetry and this
 * pass ignores it**: bit 32 fires identically under default,
 * `connectivityOnly`, `full: false` and `strict` — the ungated shape bit 64
 * already has, not the gated shape bit 4 has. tsgit has no config key
 * equivalent to git's one gate on this pass, so it is unconditional.
 *
 * A load-time Tier-A multi-pack-index fault never reaches this pass at all:
 * `enumerateObjects` awaits the same generation before this pass runs, so
 * `fsck` has already rejected by the time control would get here. Only a
 * fault reached decoding one specific entry (§ the contained walk fault) is
 * caught anywhere in this design, and it is caught inside `midxHealth()`,
 * not here — this pass only reads the verdict it already settled.
 */
export async function runMidxHealthPass(
  ctx: Context,
  _opts: FsckOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }> {
  const registry = getPackRegistry(ctx);
  const health = await registry.midxHealth();

  const findings: FsckFinding[] = [];
  let exitBit = 0;

  const containedFault = health.faults.find(isContainedMidxFault);
  if (health.artefact === undefined && health.flatFilePresent) {
    // The flat file exists but nothing usable survived — its own discard
    // fault is always faults[0] here: the flat candidate is tried, and
    // recorded, before the chain ever is.
    const flatFault = health.faults[0]!;
    findings.push({
      type: 'midx-unusable',
      artefact: flatFault.artefact,
      reason: faultReason(flatFault.data),
    });
    exitBit |= EXIT_MULTI_PACK_INDEX;
  } else if (containedFault !== undefined) {
    findings.push({
      type: 'midx-unusable',
      artefact: containedFault.artefact,
      reason: faultReason(containedFault.data),
    });
    exitBit |= EXIT_MULTI_PACK_INDEX;
  }

  if (health.artefact !== undefined) {
    if (health.checksumOk === false) {
      findings.push({ type: 'midx-checksum-mismatch', artefact: health.artefact });
      exitBit |= EXIT_MULTI_PACK_INDEX;
    }
    for (const unresolved of health.unresolvedPacks) {
      findings.push({ type: 'midx-pack-unresolved', artefact: health.artefact, ...unresolved });
      exitBit |= EXIT_MULTI_PACK_INDEX;
    }
    for (const id of health.unresolvedEntries) {
      findings.push({ type: 'midx-entry-unresolved', artefact: health.artefact, id });
      exitBit |= EXIT_MULTI_PACK_INDEX;
    }
  }

  return { findings, exitBit };
}
