/**
 * AAA-marker detector.
 *
 * For each non-skipped `it(...)` / `test(...)` block in unit files, asserts
 * that the body contains every line-anchored AAA marker required by the
 * manifest (`heuristics.aaaBody.required` — by default `Arrange` + `Assert`).
 *
 * Detection regex: `(?:^|\n)\s*\/\/\s*(Arrange|Act|Assert)\b`. Markers must
 * appear at the start of a line (modulo leading whitespace) — inline
 * `expect(x) // Assert` and markers inside string literals don't satisfy the
 * rule. Case-sensitive: `// arrange` is not honoured (see ADR-112).
 *
 * Skipped blocks (`.skip` / `.todo` / `.fails`) are exempted — their bodies
 * are often empty placeholders.
 */
import { classifyTestFile } from './classify-test-file.ts';
import type { AaaMarker, PyramidManifest } from './parse-manifest.ts';
import { scanItBlocks } from './scan-it-blocks.ts';
import type { SourceFile } from './types.ts';

export interface MissingAaaFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly missing: ReadonlyArray<AaaMarker>;
}

const MARKER_PATTERNS: Readonly<Record<AaaMarker, RegExp>> = {
  Arrange: /(?:^|\n)\s*\/\/\s*Arrange\b/,
  Act: /(?:^|\n)\s*\/\/\s*Act\b/,
  Assert: /(?:^|\n)\s*\/\/\s*Assert\b/,
};

const sortFindings = (
  findings: ReadonlyArray<MissingAaaFinding>,
): ReadonlyArray<MissingAaaFinding> =>
  [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });

export const detectMissingAaa = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<MissingAaaFinding> => {
  const heuristic = manifest.heuristics.aaaBody;
  const findings: MissingAaaFinding[] = [];
  for (const file of files) {
    if (classifyTestFile(manifest, file.path) !== heuristic.tier) continue;
    const blocks = scanItBlocks(file.source);
    for (const block of blocks) {
      if (block.isSkipped) continue;
      const missing = heuristic.required.filter(
        (marker) => !MARKER_PATTERNS[marker].test(block.body),
      );
      if (missing.length === 0) continue;
      findings.push({
        path: file.path,
        line: block.line,
        title: block.title,
        missing,
      });
    }
  }
  return sortFindings(findings);
};
