import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { looksLikePathspec } from '../../../../src/domain/pathspec/index.js';

const PLAIN = fc.stringMatching(/^[a-z0-9~^/.@{}-]*$/);
const GLOB = fc.constantFrom('*', '?', '[');

describe('looks-like-pathspec properties', () => {
  describe('Given an argument with no glob character and no long-form magic', () => {
    describe('When looksLikePathspec reads it', () => {
      it('Then it never reads as a pathspec', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(PLAIN, (arg) => {
            expect(looksLikePathspec(arg)).toBe(false);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a plain argument with a glob character placed in it', () => {
    describe('When looksLikePathspec reads it bare and escaped', () => {
      it('Then only the bare glob reads as a pathspec', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(PLAIN, GLOB, PLAIN, (head, glob, tail) => {
            expect(looksLikePathspec(`${head}${glob}${tail}`)).toBe(true);
            expect(looksLikePathspec(`${head}\\${glob}${tail}`)).toBe(false);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
