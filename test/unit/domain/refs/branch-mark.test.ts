import { describe, expect, it } from 'vitest';
import { findBranchMark } from '../../../../src/domain/refs/branch-mark.js';

describe('findBranchMark', () => {
  describe('Given a name carrying a branch mark', () => {
    describe.each([
      ['@{u}', { branch: '', kind: 'upstream', whole: true }],
      ['@{upstream}', { branch: '', kind: 'upstream', whole: true }],
      ['@{UpStream}', { branch: '', kind: 'upstream', whole: true }],
      ['@{U}', { branch: '', kind: 'upstream', whole: true }],
      ['main@{u}', { branch: 'main', kind: 'upstream', whole: true }],
      ['feat/x@{upstream}', { branch: 'feat/x', kind: 'upstream', whole: true }],
      ['@{push}', { branch: '', kind: 'push', whole: true }],
      ['main@{PUSH}', { branch: 'main', kind: 'push', whole: true }],
      ['@{u}x', { branch: '', kind: 'upstream', whole: false }],
      ['main@{u}er}', { branch: 'main', kind: 'upstream', whole: false }],
      ['a@b@{u}', { branch: 'a@b', kind: 'upstream', whole: true }],
    ])('When %j is scanned', (name, expected) => {
      it("Then git's interpret_branch_mark reads its branch and mark", () => {
        // Arrange
        const sut = findBranchMark;

        // Act
        const result = sut(name);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a name carrying no branch mark', () => {
    describe.each([
      ['main'],
      ['main@{1}'],
      ['@{-1}'],
      ['main@{u'],
      ['a:b@{u}'],
      ['a:b@{u}@{push}'],
      ['main@{upstreams}'],
      ['@'],
      ['m@{yesterday}'],
    ])('When %j is scanned', (name) => {
      it('Then no mark is found', () => {
        // Arrange
        const sut = findBranchMark;

        // Act
        const result = sut(name);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
