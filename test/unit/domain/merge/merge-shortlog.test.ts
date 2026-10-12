import { describe, expect, it } from 'vitest';
import { formatShortlog, shortlogOrigin } from '../../../../src/domain/merge/merge-shortlog.js';

describe('shortlogOrigin', () => {
  describe.each([
    ["branch 'feat' of .", 'feat', true],
    ["branch 'feat' (early part) of .", "'feat' (early part)", true],
    ["tag 'v1' of .", "tag 'v1'", false],
    ["remote-tracking branch 'origin/feat' of .", 'origin/feat', false],
    ["commit 'abc1234'", "commit 'abc1234'", false],
    ["branch 'main' of https://h/r.git", "'main' of https://h/r.git", false],
    ["tag 'v1' of https://h/r.git", "tag 'v1' of https://h/r.git", false],
    ['https://h/r.git', 'https://h/r.git', false],
    ["'quoted'", 'quoted', false],
    ["other 'x' of https://h/r.git", 'https://h/r.git', false],
    ["other 'x' of '.'", '.', false],
    ["'", "'", false],
  ])('Given the head description %s', (description, name, localBranch) => {
    describe('When its shortlog origin is taken', () => {
      it("Then it is named as git's handle_line names it", () => {
        // Arrange
        const sut = shortlogOrigin;

        // Act
        const result = sut(description);

        // Assert
        expect(result).toEqual({ name, localBranch });
      });
    });
  });
});

describe('formatShortlog', () => {
  describe('Given fewer commits than the limit', () => {
    describe('When formatted', () => {
      it('Then every subject is listed under the bare name', () => {
        // Arrange
        const sut = formatShortlog;

        // Act
        const result = sut({ name: 'feat', count: 2, subjects: ['two', 'one'] }, 20);

        // Assert
        expect(result).toBe('\n* feat:\n  two\n  one\n');
      });
    });
  });

  describe('Given exactly as many commits as the limit', () => {
    describe('When formatted', () => {
      it('Then the count is not shown and nothing is elided', () => {
        // Arrange
        const sut = formatShortlog;

        // Act
        const result = sut({ name: 'feat', count: 2, subjects: ['two', 'one'] }, 2);

        // Assert
        expect(result).toBe('\n* feat:\n  two\n  one\n');
      });
    });
  });

  describe('Given more commits than the limit', () => {
    describe('When formatted', () => {
      it('Then the count is shown and the subject past the limit is elided', () => {
        // Arrange
        const sut = formatShortlog;

        // Act
        const result = sut({ name: 'feat', count: 5, subjects: ['c', 'b'] }, 1);

        // Assert
        expect(result).toBe('\n* feat: (5 commits)\n  c\n  ...\n');
      });
    });
  });

  describe.each([
    ['a two-line description', 'line1\nline2', '  : line1\n  : line2\n'],
    ['a description ending in a newline', 'x\n', '  : x\n'],
    ['an empty description', '', ''],
  ])('Given %s', (_label, description, lines) => {
    describe('When formatted', () => {
      it('Then each description line precedes the subjects', () => {
        // Arrange
        const sut = formatShortlog;

        // Act
        const result = sut({ name: 'feat', count: 1, subjects: ['one'], description }, 20);

        // Assert
        expect(result).toBe(`\n* feat:\n${lines}  one\n`);
      });
    });
  });
});
