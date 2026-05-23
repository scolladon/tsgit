/**
 * Test-file classifier (Phase 19.2, ADR-105).
 *
 * Directory-based: walks the manifest's tier list in order, returns the first
 * tier whose glob matches the path. Normalises Windows-style backslashes so
 * the audit works on `windows-latest` runners.
 */
import { minimatch } from 'minimatch';

import type { PyramidManifest, TierName } from './parse-manifest.js';

export type Classification = TierName | 'unclassified';

const normalize = (repoRelPath: string): string => repoRelPath.replace(/\\/g, '/');

export const classifyTestFile = (
  manifest: PyramidManifest,
  repoRelPath: string,
): Classification => {
  const normalised = normalize(repoRelPath);
  for (const tier of manifest.tiers) {
    if (minimatch(normalised, tier.glob)) return tier.name;
  }
  return 'unclassified';
};
