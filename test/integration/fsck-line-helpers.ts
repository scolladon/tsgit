/**
 * Rebuilds of `git fsck`'s stdout lines from tsgit's structured findings, shared by the
 * fsck interop suites so each compares git's output against the same reconstruction.
 */
import type { FsckFinding } from '../../src/application/commands/fsck.js';

const MISSING_LINE = /^missing (\w+) ([0-9a-f]{40})$/;

/** git fsck's stdout line for a missing object. */
export const missingLine = (objectType: string, id: string): string =>
  `missing ${objectType} ${id}`;

/** git's `missing <type> <oid>` lines, rebuilt from tsgit's `missing` findings, sorted. */
export const missingLinesOf = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<string> =>
  findings.flatMap((f) => (f.type === 'missing' ? [missingLine(f.objectType, f.id)] : [])).sort();

/** The `missing <type> <oid>` lines of git fsck's stdout, sorted. */
export const gitMissingLines = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split('\n')
    .filter((line) => MISSING_LINE.test(line))
    .sort();
