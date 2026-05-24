/**
 * Empty AAA-section detector (ADRs 114–116).
 *
 * For each non-skipped `it(...)` / `test(...)` block in unit files, walks
 * the AAA markers that are *present* (Arrange / Act / Assert) and flags
 * any marker whose section underneath contains no statement-bearing line.
 *
 * A *statement-bearing line* is a non-empty line whose first
 * non-whitespace character is **not** `//` (line comment), **not** `/*`
 * (block-comment opener), and **not** a closing bracket (`}`, `)`, `]`).
 * Empty lines, comment-only lines, and lines that exist only to close a
 * prior construct do not count toward section content.
 *
 * Only markers that exist in the body are checked — the rule is
 * orthogonal to `aaaBody` (ADR-112), which enforces marker *presence*.
 * If `// Act` is absent, no Act-section check fires; if `// Act` is
 * written but its section is empty, that's a finding.
 *
 * Compound marker lines (`// Arrange + Act`) count as a single marker
 * line for section accounting; the *first* marker name appearing on the
 * line owns any emitted finding for the section underneath.
 */
import { classifyTestFile } from './classify-test-file.ts';
import type { AaaMarker, PyramidManifest } from './parse-manifest.ts';
import { scanItBlocks } from './scan-it-blocks.ts';
import type { SourceFile } from './types.ts';

export interface EmptyAaaSectionFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly marker: AaaMarker;
}

interface MarkerHit {
  readonly bodyLineIndex: number;
  readonly markers: ReadonlyArray<AaaMarker>;
}

const MARKER_NAMES: ReadonlyArray<AaaMarker> = ['Arrange', 'Act', 'Assert'];
const MARKER_ORDER: Readonly<Record<AaaMarker, number>> = {
  Arrange: 0,
  Act: 1,
  Assert: 2,
};
const MARKER_LINE_RE = /^[ \t]*\/\/[^\n]*$/;
const MARKER_WORD_RE: Readonly<Record<AaaMarker, RegExp>> = {
  Arrange: /\bArrange\b/,
  Act: /\bAct\b/,
  Assert: /\bAssert\b/,
};

const detectMarkersOnLine = (line: string): ReadonlyArray<AaaMarker> => {
  if (!MARKER_LINE_RE.test(line)) return [];
  const hits: Array<{ name: AaaMarker; index: number }> = [];
  for (const name of MARKER_NAMES) {
    const idx = line.search(MARKER_WORD_RE[name]);
    if (idx >= 0) hits.push({ name, index: idx });
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map((h) => h.name);
};

const collectMarkerHits = (bodyLines: ReadonlyArray<string>): ReadonlyArray<MarkerHit> => {
  const hits: MarkerHit[] = [];
  for (let i = 0; i < bodyLines.length; i += 1) {
    const markers = detectMarkersOnLine(bodyLines[i] ?? '');
    if (markers.length > 0) hits.push({ bodyLineIndex: i, markers });
  }
  return hits;
};

const isStatementBearingLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('//')) return false;
  if (trimmed.startsWith('/*')) return false;
  if (trimmed.startsWith('*')) return false;
  const head = trimmed[0];
  if (head === '}' || head === ')' || head === ']') return false;
  return true;
};

const sectionHasStatement = (
  bodyLines: ReadonlyArray<string>,
  fromExclusive: number,
  toExclusive: number,
): boolean => {
  for (let i = fromExclusive + 1; i < toExclusive; i += 1) {
    if (isStatementBearingLine(bodyLines[i] ?? '')) return true;
  }
  return false;
};

const sortFindings = (
  findings: ReadonlyArray<EmptyAaaSectionFinding>,
): ReadonlyArray<EmptyAaaSectionFinding> =>
  [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return MARKER_ORDER[a.marker] - MARKER_ORDER[b.marker];
  });

export const detectEmptyAaaSection = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<EmptyAaaSectionFinding> => {
  const heuristic = manifest.heuristics.emptyAaaSection;
  const findings: EmptyAaaSectionFinding[] = [];
  for (const file of files) {
    if (classifyTestFile(manifest, file.path) !== heuristic.tier) continue;
    const blocks = scanItBlocks(file.source);
    for (const block of blocks) {
      if (block.isSkipped) continue;
      const bodyLines = block.body.split('\n');
      const hits = collectMarkerHits(bodyLines);
      // One iteration per marker line — compound lines own a single section
      // (the names sharing the line accumulate into `hit.markers`; only the
      // textually first name is the reporting owner per ADR-115).
      for (let h = 0; h < hits.length; h += 1) {
        const hit = hits[h]!;
        const next = hits[h + 1];
        const sectionEndExclusive = next === undefined ? bodyLines.length : next.bodyLineIndex;
        if (sectionHasStatement(bodyLines, hit.bodyLineIndex, sectionEndExclusive)) continue;
        const marker = hit.markers[0]!;
        findings.push({
          path: file.path,
          line: block.line + hit.bodyLineIndex,
          title: block.title,
          marker,
        });
      }
    }
  }
  return sortFindings(findings);
};
