/**
 * Tier counter.
 *
 * Pure: walks the classified paths, totals per-tier file counts, computes
 * shares (one decimal place), tags each tier with its warn-band status.
 */
import { classifyTestFile } from './classify-test-file.ts';
import type { PyramidManifest, TierName } from './parse-manifest.ts';

export type TierStatus = 'ok' | 'warn-below' | 'warn-above';

export interface TierTally {
  readonly tier: TierName;
  readonly fileCount: number;
  readonly sharePct: number;
  readonly target: number;
  readonly warnBelow: number;
  readonly warnAbove: number | null;
  readonly status: TierStatus;
}

export interface TallyResult {
  readonly tiers: ReadonlyArray<TierTally>;
  readonly unclassified: ReadonlyArray<string>;
  readonly totalClassified: number;
}

const roundOne = (value: number): number => Math.round(value * 10) / 10;

const statusFor = (
  share: number,
  warnBelow: number,
  warnAbove: number | null,
): TierStatus => {
  if (share < warnBelow) return 'warn-below';
  if (warnAbove !== null && share > warnAbove) return 'warn-above';
  return 'ok';
};

export const tallyTierFiles = (
  manifest: PyramidManifest,
  paths: ReadonlyArray<string>,
): TallyResult => {
  const perTier = new Map<TierName, number>();
  const unclassified: string[] = [];
  let totalClassified = 0;

  for (const tier of manifest.tiers) perTier.set(tier.name, 0);

  for (const repoRelPath of paths) {
    const tier = classifyTestFile(manifest, repoRelPath);
    if (tier === 'unclassified') {
      unclassified.push(repoRelPath);
      continue;
    }
    perTier.set(tier, (perTier.get(tier) ?? 0) + 1);
    totalClassified += 1;
  }

  const tiers: TierTally[] = manifest.tiers.map((definition) => {
    const fileCount = perTier.get(definition.name) ?? 0;
    const sharePct = totalClassified === 0 ? 0 : roundOne((fileCount / totalClassified) * 100);
    return {
      tier: definition.name,
      fileCount,
      sharePct,
      target: definition.target,
      warnBelow: definition.warnBelow,
      warnAbove: definition.warnAbove,
      status: statusFor(sharePct, definition.warnBelow, definition.warnAbove),
    };
  });

  return { tiers, unclassified, totalClassified };
};
