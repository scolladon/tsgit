import { describe, expect, it } from 'vitest';
import { ancestorSpelling } from '../../../../src/domain/merge/ancestor-spelling.js';

describe('ancestorSpelling', () => {
  describe.each([
    ['side^', { branch: 'side', early: true }],
    ['side^^', { branch: 'side', early: true }],
    ['side~', { branch: 'side', early: true }],
    ['side~2', { branch: 'side', early: true }],
    ['side~10', { branch: 'side', early: true }],
    ['side~0', { branch: 'side', early: false }],
    ['side~00', { branch: 'side', early: false }],
    ['a~b~3', { branch: 'a~b', early: true }],
    ['side', undefined],
    ['side^0', undefined],
    ['side~x', undefined],
    ['side~2^0', undefined],
    ['123', undefined],
  ])('Given the revision %s, When it is read as an ancestor spelling', (name, expected) => {
    it('Then it reads the branch git merge_name names', () => {
      // Arrange
      const sut = ancestorSpelling;

      // Act
      const result = sut(name);

      // Assert
      expect(result).toEqual(expected);
    });
  });
});
