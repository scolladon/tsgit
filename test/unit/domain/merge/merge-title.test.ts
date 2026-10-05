import { describe, expect, it } from 'vitest';

import { mergeTitle } from '../../../../src/domain/merge/merge-title.js';

describe('mergeTitle', () => {
  describe('Given one local head of each kind', () => {
    describe.each([
      ["branch 'feat' of .", "Merge branch 'feat'"],
      ["tag 'v1' of .", "Merge tag 'v1'"],
      ["remote-tracking branch 'origin/feat' of .", "Merge remote-tracking branch 'origin/feat'"],
      ["commit 'abc1234'", "Merge commit 'abc1234'"],
    ])('When titled from %s', (description, expected) => {
      it('Then it reads as git names it', () => {
        // Arrange
        const sut = mergeTitle;

        // Act
        const result = sut([description], undefined);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a destination that is not suppressed', () => {
    describe('When titled', () => {
      it('Then it names the branch merged into', () => {
        // Arrange
        const sut = mergeTitle;

        // Act
        const result = sut(["branch 'feat' of ."], 'topic');

        // Assert
        expect(result).toBe("Merge branch 'feat' into topic");
      });
    });
  });

  describe('Given heads fetched from a remote url', () => {
    describe('When titled', () => {
      it('Then each kind is joined and the url follows', () => {
        // Arrange
        const sut = mergeTitle;
        const heads = [
          "branch 'a' of ../peer",
          "branch 'b' of ../peer",
          "branch 'c' of ../peer",
          "tag 'v1' of ../peer",
          "'refs/x/y' of ../peer",
          "remote-tracking branch 'o/z' of ../peer",
        ];

        // Act
        const result = sut(heads, undefined);

        // Assert
        expect(result).toBe(
          "Merge branches 'a', 'b' and 'c', remote-tracking branch 'o/z', tag 'v1', commit 'refs/x/y' of ../peer",
        );
      });
    });
  });

  describe('Given heads from two sources', () => {
    describe('When titled', () => {
      it('Then the sources are separated by a semicolon', () => {
        // Arrange
        const sut = mergeTitle;

        // Act
        const result = sut(["branch 'a' of ../one", "tag 'b' of ../two", "tag 'c' of ../two"], 'x');

        // Assert
        expect(result).toBe("Merge branch 'a' of ../one; tags 'b' and 'c' of ../two into x");
      });
    });
  });

  describe("Given a remote's HEAD pulled alone", () => {
    describe('When titled', () => {
      it('Then the title is the url itself', () => {
        // Arrange
        const sut = mergeTitle;

        // Act
        const result = sut(['https://remote.example/r'], undefined);

        // Assert
        expect(result).toBe('Merge https://remote.example/r');
      });
    });
  });

  describe("Given a remote's HEAD pulled with a branch of the same url", () => {
    describe('When titled', () => {
      it('Then HEAD leads the named heads', () => {
        // Arrange
        const sut = mergeTitle;

        // Act
        const result = sut(['../peer', "branch 'b' of ../peer"], undefined);

        // Assert
        expect(result).toBe("Merge HEAD, branch 'b' of ../peer");
      });
    });
  });
});
