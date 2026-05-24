/**
 * GWT describe/it-split detector.
 *
 * Validates the describe→it hierarchy for every non-skipped (or skipped)
 * unit `it()`/`test()` block. Given and When live on `describe()`
 * ancestors; Then lives on the `it()` leaf. See ADR-117 / ADR-118.
 *
 * Joins `scanItBlocks` records to `scanDescribeBlocks` records via
 * source-offset containment — no AST, no shared structural model.
 */
import { classifyTestFile } from './classify-test-file.ts';
import type { PyramidManifest } from './parse-manifest.ts';
import {
  type DescribeBlock,
  scanDescribeBlocks,
} from './scan-describe-blocks.ts';
import { type ItBlock, scanItBlocks } from './scan-it-blocks.ts';
import type { SourceFile } from './types.ts';

export type BadTitleReason =
  | 'missing'
  | 'then-missing'
  | 'when-missing'
  | 'given-missing'
  | 'nested-gwt'
  | 'legacy-it-gwt';

export interface BadTitleFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
  // GWT-bearing describe ancestors, closest-first. Empty for legacy-it-gwt
  // findings (the leaf already contains the full Given/When/Then sequence).
  readonly ancestors: ReadonlyArray<string>;
  readonly reason: BadTitleReason;
}

const sortFindings = (
  findings: ReadonlyArray<BadTitleFinding>,
): ReadonlyArray<BadTitleFinding> =>
  [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });

const findGwtAncestors = (
  it: ItBlock,
  describes: ReadonlyArray<DescribeBlock>,
  isGwtTitle: (title: string) => boolean,
): ReadonlyArray<string> => {
  const enclosing = describes.filter(
    (d) => d.openIdx < it.openIdx && it.openIdx < d.closeIdx,
  );
  enclosing.sort((a, b) => b.openIdx - a.openIdx); // closest-first
  return enclosing.filter((d) => isGwtTitle(d.title)).map((d) => d.title);
};

const classifyAncestors = (
  ancestors: ReadonlyArray<string>,
  gwt: PyramidManifest['heuristics']['gwtTitle'],
): BadTitleReason | null => {
  if (ancestors.length === 0) return 'when-missing';

  if (ancestors.length === 1) {
    const only = ancestors[0]!;
    if (gwt.describeCombinedRe.test(only)) return null;
    if (gwt.describeWhenRe.test(only)) return 'given-missing';
    if (gwt.describeGivenRe.test(only)) return 'when-missing';
    return 'when-missing';
  }

  if (ancestors.length === 2) {
    const inner = ancestors[0]!;
    const outer = ancestors[1]!;
    if (gwt.describeWhenRe.test(inner) && gwt.describeGivenRe.test(outer)) return null;
    return 'nested-gwt';
  }

  return 'nested-gwt';
};

export const detectBadTitle = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<BadTitleFinding> => {
  const gwt = manifest.heuristics.gwtTitle;
  const findings: BadTitleFinding[] = [];
  const isGwtTitle = (title: string): boolean =>
    gwt.describeGivenRe.test(title) ||
    gwt.describeWhenRe.test(title) ||
    gwt.describeCombinedRe.test(title);

  for (const file of files) {
    if (classifyTestFile(manifest, file.path) !== gwt.tier) continue;
    const its = scanItBlocks(file.source);
    if (its.length === 0) continue;
    const describes = scanDescribeBlocks(file.source);

    for (const it of its) {
      if (it.title.length === 0) {
        findings.push({
          path: file.path,
          line: it.line,
          title: '<missing>',
          ancestors: [],
          reason: 'missing',
        });
        continue;
      }

      if (!gwt.itThenRe.test(it.title)) {
        if (gwt.legacyItGwtRe.test(it.title)) {
          findings.push({
            path: file.path,
            line: it.line,
            title: it.title,
            ancestors: [],
            reason: 'legacy-it-gwt',
          });
        } else {
          findings.push({
            path: file.path,
            line: it.line,
            title: it.title,
            ancestors: findGwtAncestors(it, describes, isGwtTitle),
            reason: 'then-missing',
          });
        }
        continue;
      }

      const ancestors = findGwtAncestors(it, describes, isGwtTitle);
      const reason = classifyAncestors(ancestors, gwt);
      if (reason !== null) {
        findings.push({
          path: file.path,
          line: it.line,
          title: it.title,
          ancestors,
          reason,
        });
      }
    }
  }
  return sortFindings(findings);
};
