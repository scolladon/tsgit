/**
 * Cross-tool interop — differential check of the histogram and patience line
 * matchers against real git. fast-check draws line sequences from a small
 * alphabet (repeats force the anchoring choices both algorithms make, blank
 * and indented lines feed the indent heuristic), git diffs them with
 * `--no-index -U0`, and the `@@` ranges git prints must equal the change
 * groups tsgit's line diff computes for the same algorithm.
 *
 * @proves
 *   surface: diff.lineDiff
 *   bucket:  cross-tool-interop
 *   unique:  histogram and patience pick git's change groups on arbitrary small-alphabet inputs, not only on hand-picked rows
 *   interopSurface: diff
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DiffAlgorithm,
  diffPresplitLinesForMode,
  type LineHunk,
  splitLines,
} from '../../src/domain/diff/line-diff.js';
import { GIT_AVAILABLE, tryRunGitWithExit } from './interop-helpers.js';

const ALPHABET = ['a', 'b', 'c', '', '  a', '}'] as const;
const MAX_LINES = 12;
const NUM_RUNS = 100;
const ROW_TIMEOUT = 120_000;

const encoder = new TextEncoder();

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'tsgit-xdiff-differential-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const linesArbitrary = fc.array(fc.constantFrom(...ALPHABET), { maxLength: MAX_LINES });

const textOf = (lines: ReadonlyArray<string>): string => lines.map((line) => `${line}\n`).join('');

/** git's `xdl_format_hunk_hdr`: an empty side names the line before it, a one-line side drops `,1`. */
const rangeOf = (start: number, length: number): string => {
  if (length === 0) return `${start},0`;
  if (length === 1) return `${start + 1}`;
  return `${start + 1},${length}`;
};

interface ChangeGroup {
  readonly oldStart: number;
  readonly oldLength: number;
  readonly newStart: number;
  readonly newLength: number;
}

const lengthOf = (hunk: LineHunk): ChangeGroup => ({
  oldStart: hunk.oursStart,
  oldLength: hunk.oursEnd - hunk.oursStart,
  newStart: hunk.theirsStart,
  newLength: hunk.theirsEnd - hunk.theirsStart,
});

const joined = (group: ChangeGroup, hunk: LineHunk): ChangeGroup => ({
  ...group,
  oldLength: group.oldLength + hunk.oursEnd - hunk.oursStart,
  newLength: group.newLength + hunk.theirsEnd - hunk.theirsStart,
});

/** Adjacent non-common hunks form one `-U0` hunk; a common run between them splits it. */
const changeGroups = (hunks: ReadonlyArray<LineHunk>): ReadonlyArray<ChangeGroup> => {
  const groups: ChangeGroup[] = [];
  let open: ChangeGroup | undefined;
  for (const hunk of hunks) {
    if (hunk.kind === 'common') {
      if (open !== undefined) groups.push(open);
      open = undefined;
    } else {
      open = open === undefined ? lengthOf(hunk) : joined(open, hunk);
    }
  }
  if (open !== undefined) groups.push(open);
  return groups;
};

const headersOf = (hunks: ReadonlyArray<LineHunk>): ReadonlyArray<string> =>
  changeGroups(hunks).map(
    (group) =>
      `@@ -${rangeOf(group.oldStart, group.oldLength)} +${rangeOf(group.newStart, group.newLength)} @@`,
  );

const linesOf = (lines: ReadonlyArray<string>): ReadonlyArray<Uint8Array> =>
  splitLines(encoder.encode(textOf(lines)));

const gitHeaders = (
  oldLines: ReadonlyArray<string>,
  newLines: ReadonlyArray<string>,
  algorithm: DiffAlgorithm,
): ReadonlyArray<string> => {
  const oldPath = path.join(root, 'old.txt');
  const newPath = path.join(root, 'new.txt');
  writeFileSync(oldPath, textOf(oldLines));
  writeFileSync(newPath, textOf(newLines));
  const { stdout } = tryRunGitWithExit([
    '-c',
    'diff.indentHeuristic=true',
    'diff',
    '--no-ext-diff',
    '--no-index',
    `--${algorithm}`,
    '-U0',
    oldPath,
    newPath,
  ]);
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('@@'))
    .map((line) => line.replace(/^(@@ -\S+ \+\S+ @@).*$/, '$1'));
};

describe.skipIf(!GIT_AVAILABLE)('interop — histogram and patience change groups', () => {
  describe.each([{ algorithm: 'histogram' as const }, { algorithm: 'patience' as const }])(
    'Given arbitrary small-alphabet line sequences diffed with $algorithm',
    ({ algorithm }) => {
      describe('When git and tsgit each diff them with no context', () => {
        it(
          'Then tsgit reports the hunk ranges git prints',
          () => {
            fc.assert(
              fc.property(linesArbitrary, linesArbitrary, (oldLines, newLines) => {
                // Arrange
                const sut = diffPresplitLinesForMode;
                const expected = gitHeaders(oldLines, newLines, algorithm);

                // Act
                const result = sut(linesOf(oldLines), linesOf(newLines), algorithm);

                // Assert
                expect(headersOf(result.hunks)).toEqual(expected);
              }),
              { numRuns: NUM_RUNS },
            );
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});
