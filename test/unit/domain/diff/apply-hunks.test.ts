import { describe, expect, it } from 'vitest';
import { applyDiffOnto } from '../../../../src/domain/diff/apply-hunks.js';
import { decode, encode } from '../../../../src/domain/objects/encoding.js';

const lines = (...rows: ReadonlyArray<string>): Uint8Array => encode(`${rows.join('\n')}\n`);
const numbered = (count: number): ReadonlyArray<string> =>
  Array.from({ length: count }, (_, i) => `l${i + 1}`);
const TEN_LINES = lines(...numbered(10));
const withLine = (rows: ReadonlyArray<string>, at: number, value: string): ReadonlyArray<string> =>
  rows.map((row, i) => (i === at - 1 ? value : row));

describe('applyDiffOnto', () => {
  describe('Given a base, a one-line edit and the base itself as current', () => {
    describe('When applied', () => {
      it('Then the result is the edited bytes', () => {
        // Arrange
        const sut = applyDiffOnto;
        const target = lines(...withLine(numbered(10), 6, 'L6'));

        // Act
        const result = sut({ base: TEN_LINES, target, current: TEN_LINES });

        // Assert
        expect(decode(result as Uint8Array)).toBe(decode(target));
      });
    });
  });

  describe('Given a current whose context line differs from the base', () => {
    describe('When applied', () => {
      it('Then the result is undefined', () => {
        // Arrange
        const sut = applyDiffOnto;
        const target = lines(...withLine(numbered(10), 6, 'L6'));
        const current = lines(...withLine(numbered(10), 5, 'other'));

        // Act
        const result = sut({ base: TEN_LINES, target, current });

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a current with two lines added above the base', () => {
    describe('When the edit sits in the middle', () => {
      it('Then the hunk is found two lines further down', () => {
        // Arrange
        const sut = applyDiffOnto;
        const target = lines(...withLine(numbered(10), 6, 'L6'));
        const current = lines('top1', 'top2', ...numbered(10));

        // Act
        const result = sut({ base: TEN_LINES, target, current });

        // Assert
        expect(decode(result as Uint8Array)).toBe(
          decode(lines('top1', 'top2', ...withLine(numbered(10), 6, 'L6'))),
        );
      });
    });
  });

  describe('Given a periodic base with one line added on top of current', () => {
    describe('When two offsets match equally', () => {
      it('Then the later position is taken before the earlier one', () => {
        // Arrange
        const sut = applyDiffOnto;
        const periodic = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 'x' : 'y'));
        const base = lines(...periodic);
        const target = lines(...withLine(periodic, 6, 'Y'));
        const current = lines('top', ...periodic);

        // Act
        const result = sut({ base, target, current });

        // Assert
        expect(decode(result as Uint8Array)).toBe(
          decode(lines(...withLine(['top', ...periodic], 7, 'Y'))),
        );
      });
    });
  });

  describe('Given a hunk anchored at the first line', () => {
    describe('When current has two lines added above', () => {
      it('Then the result is undefined', () => {
        // Arrange
        const sut = applyDiffOnto;
        const target = lines(...withLine(numbered(10), 2, 'L2'));
        const current = lines('top1', 'top2', ...numbered(10));

        // Act
        const result = sut({ base: TEN_LINES, target, current });

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a hunk without trailing context', () => {
    describe('When current has a line appended', () => {
      it('Then the result is undefined', () => {
        // Arrange
        const sut = applyDiffOnto;
        const target = lines(...withLine(numbered(10), 10, 'L10'));
        const current = lines(...numbered(10), 'extra');

        // Act
        const result = sut({ base: TEN_LINES, target, current });

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given two far-apart hunks of which the first inserts three lines', () => {
    describe('When applied onto the base itself', () => {
      it('Then the second hunk is found in place', () => {
        // Arrange
        const sut = applyDiffOnto;
        const rows = numbered(20);
        const base = lines(...rows);
        const edited = withLine(rows, 18, 'L18');
        const target = lines(
          ...edited.flatMap((row, i) => (i === 2 ? [row, 'a', 'b', 'c'] : [row])),
        );

        // Act
        const result = sut({ base, target, current: base });

        // Assert
        expect(decode(result as Uint8Array)).toBe(decode(target));
      });
    });
  });

  describe('Given an empty base and a non-empty current', () => {
    describe('When a first line is added', () => {
      it('Then the result is undefined', () => {
        // Arrange
        const sut = applyDiffOnto;

        // Act
        const result = sut({ base: new Uint8Array(0), target: lines('a'), current: lines('x') });

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a base without a final newline that the target terminates', () => {
    describe('When applied onto the base itself', () => {
      it('Then the result is the terminated target', () => {
        // Arrange
        const sut = applyDiffOnto;
        const base = encode('a\nb');
        const target = encode('a\nb\n');

        // Act
        const result = sut({ base, target, current: base });

        // Assert
        expect(decode(result as Uint8Array)).toBe('a\nb\n');
      });
    });
  });

  describe('Given a base equal to the target', () => {
    describe('When applied onto a different current', () => {
      it('Then the current is returned as is', () => {
        // Arrange
        const sut = applyDiffOnto;
        const current = lines('other', 'bytes');

        // Act
        const result = sut({ base: TEN_LINES, target: TEN_LINES, current });

        // Assert
        expect(decode(result as Uint8Array)).toBe(decode(current));
      });
    });
  });
});
