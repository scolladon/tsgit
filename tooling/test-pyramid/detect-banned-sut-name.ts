/**
 * SUT-naming detector.
 *
 * For each non-skipped `it(...)` / `test(...)` block in unit files, flags any
 * `const | let | var` declaration whose binding identifier matches one of the
 * manifest's banned synonyms. The convention (CLAUDE.md, ADR-110) is that
 * the system-under-test variable is named `sut`; this detector catches
 * obvious aliases that slip in.
 *
 * Destructured forms (`const { subject } = …`) are out of scope by design
 * — see ADR-110 §Consequences.
 */
import { classifyTestFile } from './classify-test-file.ts';
import type { PyramidManifest } from './parse-manifest.ts';
import { scanItBlocks } from './scan-it-blocks.ts';
import type { SourceFile } from './types.ts';

export interface BannedSutFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly alias: string;
}

const sortFindings = (
  findings: ReadonlyArray<BannedSutFinding>,
): ReadonlyArray<BannedSutFinding> =>
  [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });

const buildDetector = (aliases: ReadonlyArray<string>): RegExp =>
  new RegExp(`\\b(?:const|let|var)\\s+(${aliases.join('|')})\\b`, 'g');

export const detectBannedSutName = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<BannedSutFinding> => {
  const heuristic = manifest.heuristics.sutNaming;
  const detector = buildDetector(heuristic.banned);
  const findings: BannedSutFinding[] = [];
  for (const file of files) {
    if (classifyTestFile(manifest, file.path) !== heuristic.tier) continue;
    const blocks = scanItBlocks(file.source);
    for (const block of blocks) {
      if (block.isSkipped) continue;
      const iter = block.body.matchAll(detector);
      const first = iter.next();
      if (first.done === true) continue;
      const alias = first.value[1];
      if (alias === undefined) continue;
      findings.push({
        path: file.path,
        line: block.line,
        title: block.title,
        alias,
      });
    }
  }
  return sortFindings(findings);
};
