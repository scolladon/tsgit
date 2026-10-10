import { describe, expect, it } from 'vitest';
import { diffLines, diffPresplitLinesForMode } from '../../../../src/domain/diff/line-diff.js';
import { type LineKey, linesEqualUnder } from '../../../../src/domain/diff/whitespace.js';
import {
  buildBaseShowingSegments,
  buildMergeSegments,
  changesFromHunks,
  type LineChange,
  type LineModel,
  type MergeSegment,
  type SideEdit,
} from '../../../../src/domain/merge/region-merge.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const enc = (s: string): Uint8Array => encoder.encode(s);
const lines = (...values: ReadonlyArray<string>): Uint8Array[] => values.map(enc);
const text = (arr: ReadonlyArray<Uint8Array>): string => arr.map((l) => decoder.decode(l)).join('');

interface MergeArgs {
  readonly base: ReadonlyArray<Uint8Array>;
  readonly baseLength: number;
  readonly ours: SideEdit;
  readonly theirs: SideEdit;
}

// Derive the (baseLength, ours, theirs) triple a real mergeContent feeds the engine.
function argsFor(base: string, ours: string, theirs: string): MergeArgs {
  const baseBytes = enc(base);
  const oursDiff = diffLines(baseBytes, enc(ours));
  const theirsDiff = diffLines(baseBytes, enc(theirs));
  return {
    base: oursDiff.oursLines,
    baseLength: oursDiff.oursLines.length,
    ours: { lines: oursDiff.theirsLines, changes: changesFromHunks(oursDiff.hunks) },
    theirs: { lines: theirsDiff.theirsLines, changes: changesFromHunks(theirsDiff.hunks) },
  };
}

const change = (i1: number, chg1: number, i2: number, chg2: number): LineChange => ({
  i1,
  chg1,
  i2,
  chg2,
});

// Adjacent clean slices read as one run: where the engine splits a clean run is immaterial.
function render(segments: ReadonlyArray<MergeSegment>): string {
  const parts: string[] = [];
  for (const s of segments) {
    const last = parts[parts.length - 1];
    if (s.kind === 'conflict') {
      const base = s.base === undefined ? '' : `|base=${text(s.base)}`;
      parts.push(`CONFLICT[ours=${text(s.ours)}${base}|theirs=${text(s.theirs)}]`);
    } else if (last?.startsWith('CLEAN[')) {
      parts[parts.length - 1] = `${last.slice(0, -1)}${text(s.lines)}]`;
    } else {
      parts.push(`CLEAN[${text(s.lines)}]`);
    }
  }
  return parts.join('');
}

const IGNORE_ALL_SPACE: LineKey = { mode: 'all', ignoreCrAtEol: false };

// Lines compare and diff with every space ignored, as `-X ignore-all-space` merges them.
const SPACE_BLIND: LineModel = {
  linesEqual: (a, b) => linesEqualUnder(a, b, IGNORE_ALL_SPACE),
  diffSides: (ours, theirs) =>
    diffPresplitLinesForMode(ours, theirs, 'myers', { lineKey: IGNORE_ALL_SPACE }).hunks,
};

describe('region-merge', () => {
  describe('buildMergeSegments', () => {
    describe('Given a single overlapping change with shared context', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then one conflict region between clean context', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor('a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n');

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe('CLEAN[a\n]CONFLICT[ours=X\n|theirs=Y\n]CLEAN[c\n]');
        });
      });
    });

    describe('Given non-overlapping changes on both sides', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then all clean, both changes applied', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor(
            'a\nb\nc\nd\ne\n',
            'A\nb\nc\nd\ne\n',
            'a\nb\nc\nd\nE\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(result.every((s) => s.kind === 'clean')).toBe(true);
          expect(render(result)).toBe('CLEAN[A\nb\nc\nd\nE\n]');
        });
      });
    });

    describe('Given the conflict sides share a trailing line', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the shared trailing line is trimmed out below the conflict', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor(
            'p\nq\nr\ns\nt\n',
            'p\nX\nY\nZ\nt\n',
            'p\nM\nN\nZ\nt\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe('CLEAN[p\n]CONFLICT[ours=X\nY\n|theirs=M\nN\n]CLEAN[Z\nt\n]');
        });
      });
    });

    describe('Given the conflict sides share a leading line', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the shared leading line is trimmed out above the conflict', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor(
            '1\n2\n3\n4\n5\n',
            '1\nP\nA\nB\n5\n',
            '1\nP\nC\nD\n5\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe('CLEAN[1\nP\n]CONFLICT[ours=A\nB\n|theirs=C\nD\n]CLEAN[5\n]');
        });
      });
    });

    describe('Given the shared edge line is whitespace-only', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then it is still trimmed (no alphanumeric gate)', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor(
            '1\n2\n3\n4\n5\n',
            '1\nA\nB\n \n5\n',
            '1\nC\nD\n \n5\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe('CLEAN[1\n]CONFLICT[ours=A\nB\n|theirs=C\nD\n]CLEAN[ \n5\n]');
        });
      });
    });

    describe('Given the conflict sides share an internal line', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the internal common line stays inside the conflict', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor(
            '1\n2\n3\n4\n5\n',
            '1\nA\nMID\nB\n5\n',
            '1\nC\nMID\nD\n5\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe(
            'CLEAN[1\n]CONFLICT[ours=A\nMID\nB\n|theirs=C\nMID\nD\n]CLEAN[5\n]',
          );
        });
      });
    });

    describe('Given two conflicts separated by exactly three common lines', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then they coalesce into one conflict with the gap duplicated on both sides', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor(
            'H\nX\nm1\nm2\nm3\nY\nT\n',
            'H\nXo\nm1\nm2\nm3\nYo\nT\n',
            'H\nXt\nm1\nm2\nm3\nYt\nT\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe(
            'CLEAN[H\n]CONFLICT[ours=Xo\nm1\nm2\nm3\nYo\n|theirs=Xt\nm1\nm2\nm3\nYt\n]CLEAN[T\n]',
          );
        });
      });
    });

    describe('Given two conflicts separated by four common lines', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then they stay separate with the gap clean between them', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor(
            'H\nX\nm1\nm2\nm3\nm4\nY\nT\n',
            'H\nXo\nm1\nm2\nm3\nm4\nYo\nT\n',
            'H\nXt\nm1\nm2\nm3\nm4\nYt\nT\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe(
            'CLEAN[H\n]CONFLICT[ours=Xo\n|theirs=Xt\n]CLEAN[m1\nm2\nm3\nm4\n]CONFLICT[ours=Yo\n|theirs=Yt\n]CLEAN[T\n]',
          );
        });
      });
    });

    describe('Given the conflict sides share an internal run of four lines', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the run splits the conflict in two around a clean run', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor(
            '1\n2\n3\n',
            '1\nA\nm1\nm2\nm3\nm4\nB\n3\n',
            '1\nC\nm1\nm2\nm3\nm4\nD\n3\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe(
            'CLEAN[1\n]CONFLICT[ours=A\n|theirs=C\n]CLEAN[m1\nm2\nm3\nm4\n]CONFLICT[ours=B\n|theirs=D\n]CLEAN[3\n]',
          );
        });
      });
    });

    describe('Given two conflicts one base line apart whose shared edges widen the gap to four', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then they stay separate', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor(
            'H\nX\nm\nY\nT\n',
            'H\nXo\nc1\nc2\nc3\nm\nYo\nT\n',
            'H\nXt\nc1\nc2\nc3\nm\nYt\nT\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe(
            'CLEAN[H\n]CONFLICT[ours=Xo\n|theirs=Xt\n]CLEAN[c1\nc2\nc3\nm\n]CONFLICT[ours=Yo\n|theirs=Yt\n]CLEAN[T\n]',
          );
        });
      });
    });

    describe('Given overlapping changes that rebuild identical sides', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the region resolves clean to ours and blocks coalescing across it', () => {
          // Arrange
          const ours: SideEdit = {
            lines: lines('O1\n', '2\n', 'X\n', '4\n', 'Y\n', '6\n', 'O7\n'),
            changes: [
              change(0, 1, 0, 1),
              change(2, 1, 2, 1),
              change(4, 1, 4, 1),
              change(6, 1, 6, 1),
            ],
          };
          const theirs: SideEdit = {
            lines: lines('T1\n', '2\n', 'X\n', '4\n', 'Y\n', '6\n', 'T7\n'),
            changes: [change(0, 1, 0, 1), change(2, 3, 2, 3), change(6, 1, 6, 1)],
          };

          // Act
          const result = buildMergeSegments(7, ours, theirs);

          // Assert
          expect(render(result)).toBe(
            'CONFLICT[ours=O1\n|theirs=T1\n]CLEAN[2\nX\n4\nY\n6\n]CONFLICT[ours=O7\n|theirs=T7\n]',
          );
        });
      });
    });

    describe('Given an identical change on both sides between two conflicts three lines apart', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the conflicts coalesce across it', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor(
            'H\nX\nm\nY\nn\nZ\nT\n',
            'H\nXo\nm\nW\nn\nZo\nT\n',
            'H\nXt\nm\nW\nn\nZt\nT\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe(
            'CLEAN[H\n]CONFLICT[ours=Xo\nm\nW\nn\nZo\n|theirs=Xt\nm\nW\nn\nZt\n]CLEAN[T\n]',
          );
        });
      });
    });

    describe('Given a one-sided change adjacent to a conflict', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the one-sided change stays clean and is never absorbed', () => {
          // Arrange — ours changes line 1 (one-sided) and line 3 (conflict); theirs only line 3.
          const { baseLength, ours, theirs } = argsFor(
            'H\n1\n2\n3\nT\n',
            'H\nOO\n2\nXo\nT\n',
            'H\n1\n2\nXt\nT\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe('CLEAN[H\nOO\n2\n]CONFLICT[ours=Xo\n|theirs=Xt\n]CLEAN[T\n]');
        });
      });
    });

    describe('Given a one-sided change between two would-be-coalescing conflicts', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the intervening change blocks coalescing', () => {
          // Arrange — ours changes A,m,B; theirs changes A,B; m is one-sided. Base gap is 3 but
          // the one-sided change sits between, so git keeps the two conflicts separate.
          const { baseLength, ours, theirs } = argsFor(
            'H\nA\nx\nm\ny\nB\nT\n',
            'H\nAo\nx\nOO\ny\nBo\nT\n',
            'H\nAt\nx\nm\ny\nBt\nT\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe(
            'CLEAN[H\n]CONFLICT[ours=Ao\n|theirs=At\n]CLEAN[x\nOO\ny\n]CONFLICT[ours=Bo\n|theirs=Bt\n]CLEAN[T\n]',
          );
        });
      });
    });

    describe('Given an empty base (add/add) with shared edges', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the differing middle conflicts and the edges are clean', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor('', 'a\nb\nc\n', 'a\nX\nc\n');

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe('CLEAN[a\n]CONFLICT[ours=b\n|theirs=X\n]CLEAN[c\n]');
        });
      });
    });

    describe('Given both sides insert different content at the same base position', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then a zero-length conflict region forms', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor(
            'a\nb\n',
            'a\nO1\nO2\nb\n',
            'a\nT1\nT2\nb\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe(
            'CLEAN[a\n]CONFLICT[ours=O1\nO2\n|theirs=T1\nT2\n]CLEAN[b\n]',
          );
        });
      });
    });

    describe('Given both sides make the identical change plus a one-sided extra', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the twin is deduped and stays clean', () => {
          // Arrange
          const { baseLength, ours, theirs } = argsFor(
            'a\nb\nc\nd\ne\n',
            'X\nb\nc\nd\ne\n',
            'X\nb\nc\nd\nY\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(result.every((s) => s.kind === 'clean')).toBe(true);
          expect(render(result)).toBe('CLEAN[X\nb\nc\nd\nY\n]');
        });
      });
    });

    describe('Given a wide ours change overlapping a narrow theirs change', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the conflict span covers the wider change end', () => {
          // Arrange — ours edits [1,4) (3 lines); theirs edits only [2,3). The group span must
          // extend to ours' end (4), not shrink to theirs' end (3).
          const { baseLength, ours, theirs } = argsFor(
            'a\nb\nc\nd\ne\n',
            'a\nX\nX\nX\ne\n',
            'a\nb\nY\nd\ne\n',
          );

          // Act
          const result = buildMergeSegments(baseLength, ours, theirs);

          // Assert
          expect(render(result)).toBe(
            'CLEAN[a\n]CONFLICT[ours=X\nX\nX\n|theirs=b\nY\nd\n]CLEAN[e\n]',
          );
        });
      });
    });

    describe('Given a later-sorted overlapping change ends past the running group end', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the group span grows to cover the wider later change', () => {
          // Arrange — ours edits [1,3); theirs edits [2,5), which sorts after ours yet
          // ends wider. The running group end must extend from 3 to 5 to cover theirs,
          // otherwise d/e leak out of the conflict into a trailing clean run.
          const ours: SideEdit = {
            lines: lines('a\n', 'X\n', 'd\n', 'e\n', 'f\n'),
            changes: [change(1, 2, 1, 1)],
          };
          const theirs: SideEdit = {
            lines: lines('a\n', 'b\n', 'Y\n', 'f\n'),
            changes: [change(2, 3, 2, 1)],
          };

          // Act
          const result = buildMergeSegments(6, ours, theirs);

          // Assert
          expect(render(result)).toBe('CLEAN[a\n]CONFLICT[ours=X\nd\ne\n|theirs=b\nY\n]CLEAN[f\n]');
        });
      });
    });

    describe.each([
      {
        given: 'ours rewrites both lines and theirs deletes the second',
        base: 'c\nb\n',
        ours: 'b\ne\n',
        theirs: 'c\n',
        expected: 'CONFLICT[ours=b\ne\n|theirs=c\n]',
      },
      {
        given: 'ours appends a line after the one theirs deletes',
        base: 'a\nc\n',
        ours: 'a\nc\nc\n',
        theirs: 'a\n',
        expected: 'CLEAN[a\n]CONFLICT[ours=c\nc\n|theirs=]',
      },
    ])('Given $given', ({ base, ours, theirs, expected }) => {
      describe('When buildMergeSegments runs', () => {
        it('Then it conflicts as git merge-file does', () => {
          // Arrange
          const sut = buildMergeSegments;
          const args = argsFor(base, ours, theirs);

          // Act
          const result = sut(args.baseLength, args.ours, args.theirs);

          // Assert
          expect(render(result)).toBe(expected);
        });
      });
    });

    describe('Given a region both sides rebuild identically from differently shaped changes', () => {
      describe('When buildMergeSegments runs between two conflicts three lines apart', () => {
        it('Then the region still keeps the two conflicts apart', () => {
          // Arrange — ours deletes b3; theirs rewrites b2,b3 into b2: the sides agree on [2,4).
          const ours: SideEdit = {
            lines: lines('O0\n', 'k1\n', 'b2\n', 'k4\n', 'O5\n'),
            changes: [change(0, 1, 0, 1), change(3, 1, 3, 0), change(5, 1, 4, 1)],
          };
          const theirs: SideEdit = {
            lines: lines('T0\n', 'k1\n', 'b2\n', 'k4\n', 'T5\n'),
            changes: [change(0, 1, 0, 1), change(2, 2, 2, 1), change(5, 1, 4, 1)],
          };
          const sut = buildMergeSegments;

          // Act
          const result = sut(6, ours, theirs);

          // Assert
          expect(render(result)).toBe(
            'CONFLICT[ours=O0\n|theirs=T0\n]CLEAN[k1\nb2\nk4\n]CONFLICT[ours=O5\n|theirs=T5\n]',
          );
        });
      });
    });

    describe('Given a region both sides rebuild equal only under the line model', () => {
      describe('When buildMergeSegments runs', () => {
        it("Then the region keeps ours' bytes", () => {
          // Arrange — ours deletes b2; theirs rewrites b1,b2 into a spaced b1.
          const ours: SideEdit = {
            lines: lines('k0\n', 'b1\n', 'k3\n'),
            changes: [change(2, 1, 2, 0)],
          };
          const theirs: SideEdit = {
            lines: lines('k0\n', 'b1 \n', 'k3\n'),
            changes: [change(1, 2, 1, 1)],
          };

          const sut = buildMergeSegments;

          // Act
          const result = sut(4, ours, theirs, SPACE_BLIND);

          // Assert
          expect(render(result)).toBe('CLEAN[k0\nb1\nk3\n]');
        });
      });
    });

    describe('Given ours changed only whitespace the line model ignores', () => {
      describe('When buildMergeSegments runs', () => {
        it("Then the merge is theirs verbatim, as git's whitespace-blind merge is", () => {
          // Arrange
          const ours: SideEdit = { lines: lines('a \n', 'b\n'), changes: [] };
          const theirs: SideEdit = { lines: lines('a\n', 'B\n'), changes: [change(1, 1, 1, 1)] };

          const sut = buildMergeSegments;

          // Act
          const result = sut(2, ours, theirs, SPACE_BLIND);

          // Assert
          expect(render(result)).toBe('CLEAN[a\nB\n]');
        });
      });
    });
  });

  describe('buildBaseShowingSegments', () => {
    describe.each([
      {
        given: 'ours deletes the line theirs prefixes',
        style: 'diff3' as const,
        base: 'b\n',
        ours: '',
        theirs: 'c\nb\n',
        expected: 'CONFLICT[ours=|base=b\n|theirs=c\nb\n]',
      },
      {
        given: 'ours deletes a line theirs inserts before, after a shared line',
        style: 'diff3' as const,
        base: 'c\nc\nb\n',
        ours: 'c\nb\n',
        theirs: 'c\ne\nc\nb\n',
        expected: 'CLEAN[c\n]CONFLICT[ours=|base=c\n|theirs=e\nc\n]CLEAN[b\n]',
      },
      {
        given: 'ours deletes the line before an insertion of theirs',
        style: 'diff3' as const,
        base: 'e\ne\ne\n',
        ours: 'e\ne\n',
        theirs: 'e\ne\ne\nd\n',
        expected: 'CLEAN[e\ne\n]CONFLICT[ours=|base=e\n|theirs=e\nd\n]',
      },
      {
        given: 'ours rewrites both lines and theirs deletes the second',
        style: 'zdiff3' as const,
        base: 'c\nb\n',
        ours: 'b\ne\n',
        theirs: 'c\n',
        expected: 'CONFLICT[ours=b\ne\n|base=c\nb\n|theirs=c\n]',
      },
      {
        given: 'both sides append the same line and theirs also prefixes one',
        style: 'zdiff3' as const,
        base: 'c\n',
        ours: 'c\nb\n',
        theirs: 'e\nc\nb\n',
        expected: 'CLEAN[e\nc\nb\n]',
      },
      {
        given: 'ours deletes the line theirs replaces',
        style: 'zdiff3' as const,
        base: 'c\n',
        ours: '',
        theirs: 'd\n',
        expected: 'CONFLICT[ours=|base=c\n|theirs=d\n]',
      },
      {
        given: 'theirs deletes the line ours replaces',
        style: 'zdiff3' as const,
        base: 'c\n',
        ours: 'a\n',
        theirs: '',
        expected: 'CONFLICT[ours=a\n|base=c\n|theirs=]',
      },
    ])('Given $given', ({ style, base, ours, theirs, expected }) => {
      describe(`When buildBaseShowingSegments runs in ${style} style`, () => {
        it('Then it conflicts as git merge-file does', () => {
          // Arrange
          const sut = buildBaseShowingSegments;
          const args = argsFor(base, ours, theirs);

          // Act
          const result = sut(args.base, args.ours, args.theirs, { style });

          // Assert
          expect(render(result)).toBe(expected);
        });
      });
    });

    describe('Given theirs changed a line only in whitespace the line model ignores', () => {
      describe('When buildBaseShowingSegments runs in zdiff3 style', () => {
        it("Then theirs' one-sided change keeps its own bytes", () => {
          // Arrange
          const ours: SideEdit = {
            lines: lines('k0\n', 'b1\n', 'k2\n', 'O3\n'),
            changes: [change(3, 1, 3, 1)],
          };
          const theirs: SideEdit = {
            lines: lines('k0\n', 'b1 \n', 'k2\n', 'b3\n'),
            changes: [change(1, 1, 1, 1)],
          };
          const base = lines('k0\n', 'b1\n', 'k2\n', 'b3\n');

          const sut = buildBaseShowingSegments;

          // Act
          const result = sut(base, ours, theirs, {
            style: 'zdiff3',
            model: SPACE_BLIND,
          });

          // Assert
          expect(render(result)).toBe('CLEAN[k0\nb1 \nk2\nO3\n]');
        });
      });
    });

    describe('Given ours changed only whitespace the line model ignores', () => {
      describe('When buildBaseShowingSegments runs', () => {
        it("Then the merge is theirs verbatim, as git's whitespace-blind merge is", () => {
          // Arrange
          const ours: SideEdit = { lines: lines('a \n', 'b\n'), changes: [] };
          const theirs: SideEdit = { lines: lines('a\n', 'B\n'), changes: [change(1, 1, 1, 1)] };

          const sut = buildBaseShowingSegments;

          // Act
          const result = sut(lines('a\n', 'b\n'), ours, theirs, {
            style: 'diff3',
            model: SPACE_BLIND,
          });

          // Assert
          expect(render(result)).toBe('CLEAN[a\nB\n]');
        });
      });
    });
  });
});
