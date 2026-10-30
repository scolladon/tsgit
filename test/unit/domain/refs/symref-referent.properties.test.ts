import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isOutsideRefsNamespace,
  isRootRefName,
  isValidSymrefReferent,
} from '../../../../src/domain/refs/symref-referent.js';

const COMPONENT = fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/);
const ROOT_CHARS = fc.stringMatching(/^[A-Z_-]{0,8}$/);
const PSEUDOREFS = ['FETCH_HEAD', 'MERGE_HEAD'];

describe('Given any safe two-component name under refs/', () => {
  describe('When isValidSymrefReferent runs', () => {
    it('Then the referent is valid', () => {
      // Arrange
      const sut = isValidSymrefReferent;

      // Act + Assert
      fc.assert(
        fc.property(COMPONENT, COMPONENT, (a, b) => {
          expect(sut(`refs/${a}/${b}`)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given any root-ref characters ending in _HEAD that is not a pseudoref', () => {
  describe('When isRootRefName runs', () => {
    it('Then the name is a root ref', () => {
      // Arrange
      const sut = isRootRefName;

      // Act + Assert
      fc.assert(
        fc.property(ROOT_CHARS, (stem) => {
          const name = `${stem}_HEAD`;
          fc.pre(!PSEUDOREFS.includes(name));
          expect(sut(name)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given any referent', () => {
  describe('When isOutsideRefsNamespace runs', () => {
    it('Then it holds exactly when the referent is neither a root ref nor under refs/', () => {
      // Arrange
      const sut = isOutsideRefsNamespace;

      // Act + Assert
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string(),
            ROOT_CHARS,
            COMPONENT.map((c) => `refs/${c}`),
          ),
          (r) => {
            expect(sut(r)).toBe(!isRootRefName(r) && !r.startsWith('refs/'));
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
