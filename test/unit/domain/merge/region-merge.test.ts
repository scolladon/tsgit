import { describe, expect, it } from 'vitest';
import { diffLines } from '../../../../src/domain/diff/line-diff.js';
import {
  applyChangesToSpan,
  buildMergeSegments,
  changesFromHunks,
  type MergeSegment,
  trimCommonEdges,
} from '../../../../src/domain/merge/region-merge.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const enc = (s: string): Uint8Array => encoder.encode(s);
const lines = (...values: ReadonlyArray<string>): Uint8Array[] => values.map(enc);
const text = (arr: ReadonlyArray<Uint8Array>): string => arr.map((l) => decoder.decode(l)).join('');

// Feed the engine the same (baseLines, oursChanges, theirsChanges) triple mergeContent does.
function segmentsFor(base: string, ours: string, theirs: string): ReadonlyArray<MergeSegment> {
  const baseBytes = enc(base);
  const oursDiff = diffLines(baseBytes, enc(ours));
  const theirsDiff = diffLines(baseBytes, enc(theirs));
  return buildMergeSegments(
    oursDiff.oursLines,
    changesFromHunks(oursDiff.hunks, oursDiff.theirsLines),
    changesFromHunks(theirsDiff.hunks, theirsDiff.theirsLines),
  );
}

function render(segments: ReadonlyArray<MergeSegment>): string {
  return segments
    .map((s) =>
      s.kind === 'clean'
        ? `CLEAN[${text(s.lines)}]`
        : `CONFLICT[ours=${text(s.ours)}|theirs=${text(s.theirs)}]`,
    )
    .join('');
}

describe('region-merge', () => {
  describe('buildMergeSegments', () => {
    describe('Given a single overlapping change with shared context', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then one conflict region between clean context', () => {
          // Arrange / Act
          const sut = segmentsFor('a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n');

          // Assert
          expect(render(sut)).toBe('CLEAN[a\n]CONFLICT[ours=X\n|theirs=Y\n]CLEAN[c\n]');
        });
      });
    });

    describe('Given non-overlapping changes on both sides', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then all clean, both changes applied', () => {
          // Arrange / Act
          const sut = segmentsFor('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n');

          // Assert
          expect(sut.every((s) => s.kind === 'clean')).toBe(true);
          expect(render(sut)).toBe('CLEAN[A\n]CLEAN[b\nc\nd\n]CLEAN[E\n]');
        });
      });
    });

    describe('Given the conflict sides share a trailing line', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the shared trailing line is trimmed out below the conflict', () => {
          // Arrange / Act
          const sut = segmentsFor('p\nq\nr\ns\nt\n', 'p\nX\nY\nZ\nt\n', 'p\nM\nN\nZ\nt\n');

          // Assert
          expect(render(sut)).toBe(
            'CLEAN[p\n]CONFLICT[ours=X\nY\n|theirs=M\nN\n]CLEAN[Z\n]CLEAN[t\n]',
          );
        });
      });
    });

    describe('Given the conflict sides share a leading line', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the shared leading line is trimmed out above the conflict', () => {
          // Arrange / Act
          const sut = segmentsFor('1\n2\n3\n4\n5\n', '1\nP\nA\nB\n5\n', '1\nP\nC\nD\n5\n');

          // Assert
          expect(render(sut)).toBe(
            'CLEAN[1\n]CLEAN[P\n]CONFLICT[ours=A\nB\n|theirs=C\nD\n]CLEAN[5\n]',
          );
        });
      });
    });

    describe('Given the shared edge line is whitespace-only', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then it is still trimmed (no alphanumeric gate)', () => {
          // Arrange / Act
          const sut = segmentsFor('1\n2\n3\n4\n5\n', '1\nA\nB\n \n5\n', '1\nC\nD\n \n5\n');

          // Assert
          expect(render(sut)).toBe(
            'CLEAN[1\n]CONFLICT[ours=A\nB\n|theirs=C\nD\n]CLEAN[ \n]CLEAN[5\n]',
          );
        });
      });
    });

    describe('Given the conflict sides share an internal line', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the internal common line stays inside the conflict', () => {
          // Arrange / Act
          const sut = segmentsFor('1\n2\n3\n4\n5\n', '1\nA\nMID\nB\n5\n', '1\nC\nMID\nD\n5\n');

          // Assert
          expect(render(sut)).toBe(
            'CLEAN[1\n]CONFLICT[ours=A\nMID\nB\n|theirs=C\nMID\nD\n]CLEAN[5\n]',
          );
        });
      });
    });

    describe('Given two conflicts separated by exactly three common lines', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then they coalesce into one conflict with the gap duplicated on both sides', () => {
          // Arrange / Act
          const sut = segmentsFor(
            'H\nX\nm1\nm2\nm3\nY\nT\n',
            'H\nXo\nm1\nm2\nm3\nYo\nT\n',
            'H\nXt\nm1\nm2\nm3\nYt\nT\n',
          );

          // Assert
          expect(render(sut)).toBe(
            'CLEAN[H\n]CONFLICT[ours=Xo\nm1\nm2\nm3\nYo\n|theirs=Xt\nm1\nm2\nm3\nYt\n]CLEAN[T\n]',
          );
        });
      });
    });

    describe('Given two conflicts separated by four common lines', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then they stay separate with the gap clean between them', () => {
          // Arrange / Act
          const sut = segmentsFor(
            'H\nX\nm1\nm2\nm3\nm4\nY\nT\n',
            'H\nXo\nm1\nm2\nm3\nm4\nYo\nT\n',
            'H\nXt\nm1\nm2\nm3\nm4\nYt\nT\n',
          );

          // Assert
          expect(render(sut)).toBe(
            'CLEAN[H\n]CONFLICT[ours=Xo\n|theirs=Xt\n]CLEAN[m1\nm2\nm3\nm4\n]CONFLICT[ours=Yo\n|theirs=Yt\n]CLEAN[T\n]',
          );
        });
      });
    });

    describe('Given a one-sided change adjacent to a conflict', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the one-sided change stays clean and is never absorbed', () => {
          // Arrange — ours changes line 1 (one-sided) and line 3 (conflict); theirs only line 3.
          const sut = segmentsFor('H\n1\n2\n3\nT\n', 'H\nOO\n2\nXo\nT\n', 'H\n1\n2\nXt\nT\n');

          // Assert
          expect(render(sut)).toBe(
            'CLEAN[H\n]CLEAN[OO\n]CLEAN[2\n]CONFLICT[ours=Xo\n|theirs=Xt\n]CLEAN[T\n]',
          );
        });
      });
    });

    describe('Given a one-sided change between two would-be-coalescing conflicts', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the intervening change blocks coalescing', () => {
          // Arrange — ours changes A,m,B; theirs changes A,B; m is one-sided. Base gap is 3 but
          // the one-sided change sits between, so git keeps the two conflicts separate.
          const sut = segmentsFor(
            'H\nA\nx\nm\ny\nB\nT\n',
            'H\nAo\nx\nOO\ny\nBo\nT\n',
            'H\nAt\nx\nm\ny\nBt\nT\n',
          );

          // Assert
          expect(render(sut)).toBe(
            'CLEAN[H\n]CONFLICT[ours=Ao\n|theirs=At\n]CLEAN[x\n]CLEAN[OO\n]CLEAN[y\n]CONFLICT[ours=Bo\n|theirs=Bt\n]CLEAN[T\n]',
          );
        });
      });
    });

    describe('Given an empty base (add/add) with shared edges', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the differing middle conflicts and the edges are clean', () => {
          // Arrange / Act
          const sut = segmentsFor('', 'a\nb\nc\n', 'a\nX\nc\n');

          // Assert
          expect(render(sut)).toBe('CLEAN[a\n]CONFLICT[ours=b\n|theirs=X\n]CLEAN[c\n]');
        });
      });
    });

    describe('Given both sides insert different content at the same base position', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then a zero-length conflict region forms', () => {
          // Arrange / Act
          const sut = segmentsFor('a\nb\n', 'a\nO1\nO2\nb\n', 'a\nT1\nT2\nb\n');

          // Assert
          expect(render(sut)).toBe('CLEAN[a\n]CONFLICT[ours=O1\nO2\n|theirs=T1\nT2\n]CLEAN[b\n]');
        });
      });
    });

    describe('Given both sides make the identical change plus a one-sided extra', () => {
      describe('When buildMergeSegments runs', () => {
        it('Then the twin is deduped and stays clean', () => {
          // Arrange / Act
          const sut = segmentsFor('a\nb\nc\nd\ne\n', 'X\nb\nc\nd\ne\n', 'X\nb\nc\nd\nY\n');

          // Assert
          expect(sut.every((s) => s.kind === 'clean')).toBe(true);
          expect(render(sut)).toBe('CLEAN[X\n]CLEAN[b\nc\nd\n]CLEAN[Y\n]');
        });
      });
    });
  });

  describe('applyChangesToSpan', () => {
    describe('Given a span with one replacement and a base gap', () => {
      describe('When applyChangesToSpan runs', () => {
        it('Then base lines fill the untouched gap around the replacement', () => {
          // Arrange
          const base = lines('a\n', 'b\n', 'c\n', 'd\n', 'e\n');

          // Act — replace [1,2) with [X], keep base[2], replace [3,4) with [Y]
          const sut = applyChangesToSpan(base, 1, 4, [
            { baseStart: 1, baseEnd: 2, replacement: lines('X\n') },
            { baseStart: 3, baseEnd: 4, replacement: lines('Y\n') },
          ]);

          // Assert
          expect(text(sut)).toBe('X\nc\nY\n');
        });
      });
    });
  });

  describe('trimCommonEdges', () => {
    describe('Given sides sharing a prefix and a suffix', () => {
      describe('When trimCommonEdges runs', () => {
        it('Then prefix and suffix are split out and the middles differ', () => {
          // Arrange / Act
          const sut = trimCommonEdges(
            lines('p\n', 'A\n', 'B\n', 's\n'),
            lines('p\n', 'C\n', 'D\n', 's\n'),
          );

          // Assert
          expect(text(sut.prefix)).toBe('p\n');
          expect(text(sut.oursMid)).toBe('A\nB\n');
          expect(text(sut.theirsMid)).toBe('C\nD\n');
          expect(text(sut.suffix)).toBe('s\n');
        });
      });
    });

    describe('Given prefix and suffix would otherwise overlap', () => {
      describe('When trimCommonEdges runs', () => {
        it('Then the shorter side is not double-counted', () => {
          // Arrange — ours [A,B,A], theirs [A,A]; A is a common prefix AND suffix.
          const sut = trimCommonEdges(lines('A\n', 'B\n', 'A\n'), lines('A\n', 'A\n'));

          // Assert — one A as prefix, one A as suffix, middles carry the rest
          expect(text(sut.prefix)).toBe('A\n');
          expect(text(sut.oursMid)).toBe('B\n');
          expect(text(sut.theirsMid)).toBe('');
          expect(text(sut.suffix)).toBe('A\n');
        });
      });
    });
  });
});
