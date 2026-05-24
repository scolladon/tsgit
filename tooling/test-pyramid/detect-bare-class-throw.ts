/**
 * Bare-class `.toThrow(Class)` detector.
 *
 * For each non-skipped `it(...)` / `test(...)` block in unit files, flags
 * `.toThrow(Identifier)` / `.toThrowError(Identifier)` where `Identifier`
 * starts with an uppercase letter (PascalCase) and is the *only* argument.
 * The fix (ADR-111, CLAUDE.md mutation-resistant patterns) is to assert on
 * error data instead — e.g. `.toThrow(expect.objectContaining({ data: { … }}))`.
 *
 * Skipped blocks are exempted because their bodies are often placeholders.
 */
import { classifyTestFile } from './classify-test-file.ts';
import type { PyramidManifest } from './parse-manifest.ts';
import { scanItBlocks } from './scan-it-blocks.ts';
import type { SourceFile } from './types.ts';

export interface BareClassThrowFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly identifier: string;
}

const sortFindings = (
  findings: ReadonlyArray<BareClassThrowFinding>,
): ReadonlyArray<BareClassThrowFinding> =>
  [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });

export const detectBareClassThrow = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<BareClassThrowFinding> => {
  const heuristic = manifest.heuristics.bareClassToThrow;
  const detector = new RegExp(heuristic.regex, 'g');
  const findings: BareClassThrowFinding[] = [];
  for (const file of files) {
    if (classifyTestFile(manifest, file.path) !== heuristic.tier) continue;
    const blocks = scanItBlocks(file.source);
    for (const block of blocks) {
      if (block.isSkipped) continue;
      const iter = block.body.matchAll(detector);
      const first = iter.next();
      if (first.done === true) continue;
      const identifier = first.value[1];
      if (identifier === undefined) continue;
      findings.push({
        path: file.path,
        line: block.line,
        title: block.title,
        identifier,
      });
    }
  }
  return sortFindings(findings);
};
