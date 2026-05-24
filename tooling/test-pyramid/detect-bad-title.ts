/**
 * GWT-title detector.
 *
 * For each non-skipped `it(...)` / `test(...)` block in unit files, validates
 * the literal title against the manifest's `gwtTitle.compiledRegex`. Tests
 * with no literal title (arrow-only `it(() => {})`) are reported as
 * `reason: 'missing'`; mismatched titles surface as `reason: 'malformed'`.
 *
 * Skipped blocks (`.skip` / `.todo` / `.fails`) are still validated: an
 * expressive title matters even when the test isn't running. The exception
 * stays inside the under-asserted detector, where skipped tests are
 * exempted from the assertion-count rule.
 */
import { classifyTestFile } from './classify-test-file.ts';
import type { PyramidManifest } from './parse-manifest.ts';
import { scanItBlocks } from './scan-it-blocks.ts';
import type { SourceFile } from './types.ts';

export type BadTitleReason = 'missing' | 'malformed';

export interface BadTitleFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly reason: BadTitleReason;
}

const sortFindings = (
  findings: ReadonlyArray<BadTitleFinding>,
): ReadonlyArray<BadTitleFinding> =>
  [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });

export const detectBadTitle = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<BadTitleFinding> => {
  const heuristic = manifest.heuristics.gwtTitle;
  // `gwtTitle.compiledRegex` is parsed without the `g` flag so `.test()` is
  // stateless across calls (see parse-manifest's `compileRegex`).
  const pattern = heuristic.compiledRegex;
  const findings: BadTitleFinding[] = [];
  for (const file of files) {
    if (classifyTestFile(manifest, file.path) !== heuristic.tier) continue;
    const blocks = scanItBlocks(file.source);
    for (const block of blocks) {
      if (block.title.length === 0) {
        findings.push({
          path: file.path,
          line: block.line,
          title: '<missing>',
          reason: 'missing',
        });
        continue;
      }
      if (!pattern.test(block.title)) {
        findings.push({
          path: file.path,
          line: block.line,
          title: block.title,
          reason: 'malformed',
        });
      }
    }
  }
  return sortFindings(findings);
};
