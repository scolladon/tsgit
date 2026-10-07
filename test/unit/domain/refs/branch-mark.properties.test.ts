/**
 * Properties of git's branch-mark scan: any branch spelling followed by any
 * casing of a mark reads back as that branch and mark, whole only when the
 * mark ends the name.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findBranchMark } from '../../../../src/domain/refs/branch-mark.js';

const branch = fc.stringMatching(/^[a-z0-9/._-]{0,12}$/);
const mark = fc.constantFrom(
  ['@{upstream}', 'upstream'] as const,
  ['@{u}', 'upstream'] as const,
  ['@{push}', 'push'] as const,
);
const casing = fc.array(fc.boolean(), { minLength: 11, maxLength: 11 });
const withCasing = (text: string, upper: ReadonlyArray<boolean>): string =>
  [...text].map((char, at) => (upper[at] === true ? char.toUpperCase() : char)).join('');

describe('findBranchMark properties', () => {
  describe('Given any branch and any casing of a mark', () => {
    describe('When the mark ends the name', () => {
      it('Then the branch and mark read back whole', () => {
        // Arrange
        const sut = findBranchMark;

        // Act & Assert
        fc.assert(
          fc.property(branch, mark, casing, (name, [suffix, kind], upper) => {
            const result = sut(`${name}${withCasing(suffix, upper)}`);
            expect(result).toEqual({ branch: name, kind, whole: true });
          }),
        );
      });
    });

    describe('When text follows the mark', () => {
      it('Then the mark is found but not whole', () => {
        // Arrange
        const sut = findBranchMark;

        // Act & Assert
        fc.assert(
          fc.property(branch, mark, fc.stringMatching(/^[a-z]{1,4}$/), (name, [suffix], tail) => {
            const result = sut(`${name}${suffix}${tail}`);
            expect(result?.whole).toBe(false);
          }),
        );
      });
    });
  });
});
