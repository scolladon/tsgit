import type { Context } from '../../../../ports/context.js';
import { getPackRegistry } from '../../../primitives/read-object.js';
import { EXIT_PACK, EXIT_PACK_REV_INDEX } from './exit-codes.js';
import type { FsckFinding, FsckOptions } from './types.js';

/**
 * Whether the pack-health pass (and the universe narrowing that rides on it)
 * runs at all. Full mode only: in `connectivityOnly` mode git still
 * enumerates a refused pack's ids under a different classification, so the
 * universe must not be narrowed there — narrowing is this predicate's job
 * too, via `enumerateObjects`'s `accessiblePacksOnly` knob.
 */
export function packPassEnabled(opts: FsckOptions): boolean {
  return opts.full !== false && opts.connectivityOnly !== true;
}

/**
 * Report packs the registry could not open (pack-open header gate) or index
 * (`.idx` parse). Takes the full `opts`, not a precomputed boolean, because
 * bit 64 — and its `pack-rev-index-unusable` finding — is **ungated**: an
 * unusable index reports at that layer in every mode, including
 * `connectivityOnly` and `full: false`, while bit 4 and its finding stay
 * behind `packPassEnabled`. Collapsing the two into one boolean would
 * silently disable the ungated term.
 */
export async function runPackHealthPass(
  ctx: Context,
  opts: FsckOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }> {
  const { unusable } = await getPackRegistry(ctx).health();
  const gated = packPassEnabled(opts);

  const findings: FsckFinding[] = [];
  let exitBit = 0;

  for (const entry of unusable) {
    const reason = 'reason' in entry.data ? entry.data.reason : entry.data.code;

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
