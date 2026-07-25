/**
 * Sut-binds-result detector (Axis 1, forward enforcement).
 *
 * Flags the seeding anti-pattern `const sut = <bareCall>(…)` where `sut`
 * binds a *call result* rather than the unit under test (ADR-506 Decision F).
 * Allows `const sut = new X(…)` (object-under-test construction), a bare
 * reference `const sut = obj.method` (no invocation), and any call whose
 * callee is in the manifest's factory allowlist — `this`-carrying factories
 * (`openRepository`, `createX`, …) and stream/operator factories (`map`,
 * `filter`, `take`, …) that legitimately return the object under test.
 *
 * Best-effort and heuristic by design: a dotted/member call (`a.b(…)`) is
 * out of scope for this bare-call check — see ADR-506 §"Harness extension".
 * Two further best-effort false-negatives (also out of scope, same reason):
 * a generic-call `const sut = compute<T>(x)` and a paren-wrapped
 * `const sut = (compute(x))` are not flagged.
 */
import { classifyTestFile } from './classify-test-file.ts';
import type { PyramidManifest, SutBindsResultHeuristic } from './parse-manifest.ts';
import { type ItBlock, scanItBlocks } from './scan-it-blocks.ts';
import type { SourceFile } from './types.ts';

export interface SutBindsResultFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly callee: string;
}

// Group 1: `new` keyword (construction — always allowed).
// Group 2: the leading identifier (the callee, for a bare call).
// Group 3: a trailing dot-chain (non-empty means a dotted/member access).
// Group 4: an opening paren immediately following — present means a call.
const SUT_BINDING_RE =
  /\bconst\s+sut\b\s*=\s*(?:await\s+)?(new\s+)?([A-Za-z_$][A-Za-z0-9_$]*)((?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*(\()?/g;

const sortFindings = (
  findings: ReadonlyArray<SutBindsResultFinding>,
): ReadonlyArray<SutBindsResultFinding> =>
  [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });

const isFlaggedBareCall = (match: RegExpMatchArray, allowlist: ReadonlySet<string>): boolean => {
  const isConstruction = match[1] !== undefined;
  const callee = match[2];
  const dottedChain = match[3] ?? '';
  const isCall = match[4] !== undefined;
  if (isConstruction || !isCall || dottedChain.length > 0 || callee === undefined) return false;
  return !allowlist.has(callee);
};

const findingsInBlock = (
  file: SourceFile,
  block: ItBlock,
  allowlist: ReadonlySet<string>,
): ReadonlyArray<SutBindsResultFinding> => {
  if (block.isSkipped) return [];
  const findings: SutBindsResultFinding[] = [];
  for (const match of block.body.matchAll(SUT_BINDING_RE)) {
    if (!isFlaggedBareCall(match, allowlist)) continue;
    const callee = match[2];
    if (callee === undefined) continue;
    findings.push({ path: file.path, line: block.line, title: block.title, callee });
  }
  return findings;
};

const findingsInFile = (
  manifest: PyramidManifest,
  heuristic: SutBindsResultHeuristic,
  allowlist: ReadonlySet<string>,
  file: SourceFile,
): ReadonlyArray<SutBindsResultFinding> => {
  if (!heuristic.tiers.includes(classifyTestFile(manifest, file.path))) return [];
  return scanItBlocks(file.source).flatMap((block) => findingsInBlock(file, block, allowlist));
};

export const detectSutBindsResult = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<SutBindsResultFinding> => {
  const heuristic = manifest.heuristics.sutBindsResult;
  const allowlist = new Set(heuristic.allowlist);
  const findings = files.flatMap((file) => findingsInFile(manifest, heuristic, allowlist, file));
  return sortFindings(findings);
};
