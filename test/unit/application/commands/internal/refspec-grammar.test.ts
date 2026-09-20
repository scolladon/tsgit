import { describe, expect, it } from 'vitest';
import {
  isValidFetchRefspec,
  isValidPushRefspec,
} from '../../../../../src/application/commands/internal/refspec-grammar.js';

describe('application/commands/internal/refspec-grammar', () => {
  describe('isValidFetchRefspec', () => {
    describe('Given a source whose first byte decides whether it is a ref name', () => {
      describe('When isValidFetchRefspec runs', () => {
        it.each([
          {
            spec: 'x:refs/heads/y',
            expected: true,
            label: 'a one-level source is accepted',
          },
          {
            spec: '.x:refs/heads/y',
            expected: false,
            label: 'the same source opening with a dot is refused',
          },
          {
            spec: '+.x:refs/heads/y',
            expected: false,
            label: 'the force marker is stripped, leaving the dot to refuse the source',
          },
          {
            spec: '+refs/heads/main:refs/remotes/o/main',
            expected: true,
            label: 'the force marker is stripped from a source that is a ref name',
          },
        ])('Then $label', ({ spec, expected }) => {
          // Arrange
          const sut = isValidFetchRefspec;

          // Act
          const result = sut(spec);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });

    describe('Given a negative refspec, whose lone source is always a pattern side', () => {
      describe('When isValidFetchRefspec runs', () => {
        it.each([
          {
            spec: '^refs/heads/*',
            expected: true,
            label: 'one star is accepted',
          },
          {
            spec: '^refs/heads/**',
            expected: false,
            label: 'a second star is refused',
          },
        ])('Then $label', ({ spec, expected }) => {
          // Arrange
          const sut = isValidFetchRefspec;

          // Act
          const result = sut(spec);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  describe('isValidPushRefspec', () => {
    describe('Given a wildcard source, the one shape push checks', () => {
      describe('When isValidPushRefspec runs', () => {
        it.each([
          {
            spec: 'refs/heads/a*:refs/remotes/o/*',
            expected: true,
            label: 'a source that is a ref name around its star is accepted',
          },
          {
            spec: 'refs/heads/.x*:refs/remotes/o/*',
            expected: false,
            label:
              'a source component opening with a dot is refused although the destination is a valid pattern',
          },
        ])('Then $label', ({ spec, expected }) => {
          // Arrange
          const sut = isValidPushRefspec;

          // Act
          const result = sut(spec);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });
});
