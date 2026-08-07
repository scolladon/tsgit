import type { Context } from '../../../../ports/context.js';
import { faultReason } from '../../../primitives/pack-registry.js';
import { getPackRegistry } from '../../../primitives/read-object.js';
import { EXIT_PACK, EXIT_PACK_REV_INDEX } from './exit-codes.js';
import type { FsckFinding, FsckOptions } from './types.js';

/**
 * Whether the pack-ACCESSIBILITY half reports: bit 4, its two finding
 * variants, and the universe narrowing that rides on it (via
 * `enumerateObjects`'s `accessiblePacksOnly` knob). Full mode only: in
 * `connectivityOnly` mode git still enumerates a refused pack's ids under a
 * different classification, so the universe must not be narrowed there. The
 * pass itself always runs — the rev-index term is ungated.
 */
export function packAccessibilityReported(opts: FsckOptions): boolean {
  return opts.full !== false && opts.connectivityOnly !== true;
}

/**
 * Report packs the registry could not open (pack-open header gate) or index
 * (`.idx` parse). Takes the full `opts`, not a precomputed boolean, because
 * bit 64 — and its `pack-rev-index-unusable` finding — is **ungated**: an
 * unusable index reports at that layer in every mode, including
 * `connectivityOnly` and `full: false`, while bit 4 and its findings stay
 * behind `packAccessibilityReported`. The ungated term consumes only the
 * scan layer's skip records, so the header probe behind `health()` runs only
 * when the bit-4 report can consume it — `connectivityOnly` / `full: false`
 * never open a pack.
 */
export async function runPackHealthPass(
  ctx: Context,
  opts: FsckOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }> {
  const registry = getPackRegistry(ctx);
  const gated = packAccessibilityReported(opts);
  const unusable = gated ? (await registry.health()).unusable : await registry.indexFaults();

  const findings: FsckFinding[] = [];
  let exitBit = 0;

  for (const entry of unusable) {
    const reason = faultReason(entry.data);

    if (gated) {
      findings.push({
        type: entry.layer === 'index' ? 'pack-index-unusable' : 'pack-inaccessible',
        pack: entry.name,
        reason,
      });
      exitBit |= EXIT_PACK;
    }

    if (entry.layer === 'index') {
      findings.push({ type: 'pack-rev-index-unusable', pack: entry.name, reason });
      exitBit |= EXIT_PACK_REV_INDEX;
    }
  }

  return { findings, exitBit };
}
