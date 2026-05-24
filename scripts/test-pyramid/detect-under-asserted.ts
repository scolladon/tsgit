/**
 * Under-asserted unit scanner.
 *
 * For every non-skipped `it(...)` / `test(...)` block in unit files, counts
 * the assertion calls in the body and emits a finding when the count is
 * below the manifest's `minAssertionsPerTest`. The block scanner itself
 * lives in `./scan-it-blocks.ts` so other detectors share the same parser.
 */
import { classifyTestFile } from './classify-test-file.ts';
import type { PyramidManifest } from './parse-manifest.ts';
import { scanItBlocks } from './scan-it-blocks.ts';
import type { SourceFile } from './types.ts';

export interface UnderAssertedFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
}

// Identifier `expect…` or `assert…` followed immediately by `(`, `<`, or `.`.
// Matches `expect(`, `expectFoo(`, `expect.soft(`, `expectTypeOf<T>(`,
// `expectTypeOf<Promise<T>>()`, `assertRefspecInvalid(`, `assert.equal(`.
// Does not match `expected`, `assertion`, or other adjacent identifiers.
const ASSERTION_RE = /\b(?:expect|assert)[a-zA-Z]*[(<.]/g;

const countAssertions = (body: string): number => {
  let count = 0;
  for (const _hit of body.matchAll(ASSERTION_RE)) count += 1;
  return count;
};

export const detectUnderAsserted = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<UnderAssertedFinding> => {
  const heuristic = manifest.heuristics.underAssertedUnit;
  const findings: UnderAssertedFinding[] = [];
  for (const file of files) {
    if (classifyTestFile(manifest, file.path) !== heuristic.tier) continue;
    const blocks = scanItBlocks(file.source);
    for (const block of blocks) {
      if (block.isSkipped) continue;
      if (countAssertions(block.body) < heuristic.minAssertionsPerTest) {
        findings.push({ path: file.path, line: block.line, title: block.title });
      }
    }
  }
  findings.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
  return findings;
};
