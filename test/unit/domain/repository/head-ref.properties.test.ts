/**
 * Property tests for `isValidHeadContent` — a total function over an
 * algebraic grammar (lens 3) and a matcher over the hash-width alternative
 * (lens 2). Example tests in the sibling file pin the literal grammar rows;
 * these properties prove the grammar holds beyond the enumerated examples.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isValidHeadContent } from '../../../../src/domain/repository/head-ref.js';
import { arbHexWithLength, arbPrintableAsciiChar, arbRefsPrefixedRefname } from './arbitraries.js';

const TOTALITY_NUM_RUNS = 100;
const REFNAME_NUM_RUNS = 200;
const HASH_WIDTH_NUM_RUNS = 200;

// 4 KiB — each generated char is one code unit, so maxLength doubles as the byte cap.
const MAX_HEAD_CONTENT_LENGTH = 4096;

describe('isValidHeadContent properties', () => {
  describe('Given arbitrary printable-ASCII content up to 4 KiB', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it never throws', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act & Assert
        fc.assert(
          fc.property(
            fc.string({ unit: arbPrintableAsciiChar(), maxLength: MAX_HEAD_CONTENT_LENGTH }),
            (content) => {
              expect(() => sut(content)).not.toThrow();
            },
          ),
          { numRuns: TOTALITY_NUM_RUNS },
        );
      });
    });
  });

  describe('Given "ref: " followed by an arbitrary refname beginning refs/', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act & Assert
        fc.assert(
          fc.property(arbRefsPrefixedRefname(), (refname) => {
            expect(sut(`ref: ${refname}`)).toBe(true);
          }),
          { numRuns: REFNAME_NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary-length hex string', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true iff the length is 40 or 64', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act & Assert
        fc.assert(
          fc.property(arbHexWithLength(), ({ length, hex }) => {
            expect(sut(hex)).toBe(length === 40 || length === 64);
          }),
          { numRuns: HASH_WIDTH_NUM_RUNS },
        );
      });
    });
  });
});
