import { describe, expect, it } from 'vitest';

import { indexPathRulesOf } from '../../../../../src/application/primitives/internal/index-path-rules.js';
import {
  posixIndexPathRules,
  windowsIndexPathRules,
} from '../../../../../src/domain/git-index/path-validator.js';

describe('indexPathRulesOf', () => {
  describe.each([
    {
      title: 'a host declaring Windows syntax',
      host: { windowsPathSyntax: true },
      expected: windowsIndexPathRules,
    },
    {
      title: 'a host declaring POSIX syntax',
      host: { windowsPathSyntax: false },
      expected: posixIndexPathRules,
    },
    { title: 'a host declaring nothing', host: {}, expected: posixIndexPathRules },
  ])('Given $title', ({ host, expected }) => {
    describe('When its index path rules are chosen', () => {
      it('Then they are the rules of the git build the host emulates', () => {
        // Arrange
        const sut = indexPathRulesOf;

        // Act
        const result = sut(host);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
