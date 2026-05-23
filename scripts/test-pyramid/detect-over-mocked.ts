/**
 * Over-mocked integration scanner (Phase 19.2, ADR-107).
 *
 * Pure: takes pre-read file contents (caller owns I/O). Filters to the tier
 * configured on the heuristic, counts manifest-regex matches per file, returns
 * findings sorted by path.
 */
import { classifyTestFile } from './classify-test-file.ts';
import type { PyramidManifest } from './parse-manifest.ts';

export interface SourceFile {
  readonly path: string;
  readonly source: string;
}

export interface OverMockedFinding {
  readonly path: string;
  readonly hits: number;
}

const countMatches = (source: string, regex: RegExp): number => {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const fresh = new RegExp(regex.source, flags);
  let count = 0;
  for (const _match of source.matchAll(fresh)) count += 1;
  return count;
};

export const detectOverMocked = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<OverMockedFinding> => {
  const heuristic = manifest.heuristics.overMockedIntegration;
  const findings: OverMockedFinding[] = [];
  for (const file of files) {
    if (classifyTestFile(manifest, file.path) !== heuristic.tier) continue;
    const hits = countMatches(file.source, heuristic.compiledRegex);
    if (hits > heuristic.threshold) findings.push({ path: file.path, hits });
  }
  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return findings;
};
