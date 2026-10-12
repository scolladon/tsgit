import type { Context } from '../../../../ports/context.js';
import { getObjectStore, type ObjectSource } from '../../../primitives/object-store.js';
import { faultReason, type UnusablePack } from '../../../primitives/pack-registry.js';
import { EXIT_PACK, EXIT_PACK_REV_INDEX } from './exit-codes.js';
import { attributeTo } from './source-attribution.js';
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
  const store = await getObjectStore(ctx);
  const findings: FsckFinding[] = [];
  let exitBit = 0;
  for (const source of store.sources) {
    const attribution = attributeTo(store, source);
    exitBit |= await reportSourcePacks(source, opts, attribution, findings);
  }
  return { findings, exitBit };
}

async function reportSourcePacks(
  source: ObjectSource,
  opts: FsckOptions,
  attribution: { readonly objectsDir?: string },
  findings: FsckFinding[],
): Promise<number> {
  const gated = packAccessibilityReported(opts);
  const unusable = gated
    ? (await source.registry.health()).unusable
    : await source.registry.indexFaults();
  const report = { gated, attribution, findings };
  return unusable.reduce((exitBit, entry) => exitBit | reportUnusablePack(entry, report), 0);
}

/** Where one source's unusable packs are reported, and whether accessibility is. */
interface UnusablePackReport {
  readonly gated: boolean;
  readonly attribution: { readonly objectsDir?: string };
  readonly findings: FsckFinding[];
}

/** Report one unusable pack: its accessibility when gated, its `.rev` when its index failed. */
function reportUnusablePack(entry: UnusablePack, report: UnusablePackReport): number {
  const { attribution, findings } = report;
  const reason = faultReason(entry.data);
  let exitBit = 0;
  if (report.gated) {
    findings.push({
      type: entry.layer === 'index' ? 'pack-index-unusable' : 'pack-inaccessible',
      pack: entry.name,
      reason,
      ...attribution,
    });
    exitBit |= EXIT_PACK;
  }
  if (entry.layer === 'index') {
    findings.push({ type: 'pack-rev-index-unusable', pack: entry.name, reason, ...attribution });
    exitBit |= EXIT_PACK_REV_INDEX;
  }
  return exitBit;
}
