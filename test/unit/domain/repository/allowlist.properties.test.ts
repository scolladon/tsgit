/**
 * Property tests for `isAllowlisted` — a compositional matcher reducing an
 * array of entries to a verdict (lens 2) and a total function over a small
 * grammar (lens 3). Example tests in the sibling file pin the literal grammar
 * rows; these properties prove the grammar holds beyond the enumerated
 * examples.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isAllowlisted } from '../../../../src/domain/repository/allowlist.js';
import {
  arbAllowlistEntries,
  arbPathWithoutTrailingSlash,
  arbPrintableAsciiString,
} from './arbitraries.js';

const TOTALITY_NUM_RUNS = 100;
const IDENTITY_NUM_RUNS = 200;
const MONOTONE_NUM_RUNS = 200;
const WILDCARD_NUM_RUNS = 200;
const PREFIX_NUM_RUNS = 100;

describe('isAllowlisted properties', () => {
  describe('Given an arbitrary repository path and an arbitrary entries array', () => {
    describe('When isAllowlisted runs', () => {
      it('Then it never throws', () => {
        // Arrange
        const sut = isAllowlisted;

        // Act & Assert
        fc.assert(
          fc.property(arbPrintableAsciiString(), arbAllowlistEntries(), (path, entries) => {
            expect(() => sut(path, entries)).not.toThrow();
          }),
          { numRuns: TOTALITY_NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary repository path and an empty entries array', () => {
    describe('When isAllowlisted runs', () => {
      it('Then it always returns false', () => {
        // Arrange
        const sut = isAllowlisted;

        // Act & Assert
        fc.assert(
          fc.property(arbPrintableAsciiString(), (path) => {
            expect(sut(path, [])).toBe(false);
          }),
          { numRuns: IDENTITY_NUM_RUNS },
        );
      });
    });
  });

  describe('Given a path, an entries array, and one more entry appended to it', () => {
    describe('When isAllowlisted runs on both arrays', () => {
      it('Then a true verdict never turns false — there is no negation in this grammar', () => {
        // Arrange
        const sut = isAllowlisted;

        // Act & Assert
        fc.assert(
          fc.property(
            arbPrintableAsciiString(),
            arbAllowlistEntries(),
            arbPrintableAsciiString(),
            (path, entries, extra) => {
              const before = sut(path, entries);
              const after = sut(path, [...entries, extra]);
              expect(!before || after).toBe(true);
            },
          ),
          { numRuns: MONOTONE_NUM_RUNS },
        );
      });
    });
  });

  describe("Given an entries array containing the wildcard entry '*'", () => {
    describe('When isAllowlisted runs for an arbitrary path', () => {
      it('Then it always returns true, whatever else the array contains', () => {
        // Arrange
        const sut = isAllowlisted;

        // Act & Assert
        fc.assert(
          fc.property(arbPrintableAsciiString(), arbAllowlistEntries(), (path, rest) => {
            expect(sut(path, [...rest, '*'])).toBe(true);
          }),
          { numRuns: WILDCARD_NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary path and a prefix q with no trailing slash', () => {
    describe('When isAllowlisted runs with a single q/* entry', () => {
      it('Then a true verdict implies the path starts with q plus a slash', () => {
        // Arrange
        const sut = isAllowlisted;

        // Act & Assert
        fc.assert(
          fc.property(arbPrintableAsciiString(), arbPathWithoutTrailingSlash(), (path, q) => {
            const matched = sut(path, [`${q}/*`]);
            expect(!matched || path.startsWith(`${q}/`)).toBe(true);
          }),
          { numRuns: PREFIX_NUM_RUNS },
        );
      });
    });
  });
});
