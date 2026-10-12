/**
 * Property tests for normalizePathCopy.
 *
 * Lens 4 (idempotence) fits: a normalised path carries no `.`, `..` or doubled
 * separator left to collapse, so normalising it again changes nothing.
 * Lens 3 (total function) fits: any `/`-joined component list is answered with a
 * path whose components are neither `.` nor `..`, or with a refusal.
 * Lens 1 (round-trip) does not fit — normalisation forgets the spelling it collapsed.
 * Lens 2 (compositional matcher) does not fit — there is nothing to match.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { normalizePathCopy } from '../../../../src/domain/path/normalize-path-copy.js';

const NUM_RUNS = 100;
const SEPARATOR = '/';

const arbComponent = fc.oneof(
  fc.constantFrom('', '.', '..', '...'),
  fc.stringMatching(/^[a-z]{1,3}$/),
);
const arbRelativePath = fc
  .array(arbComponent, { maxLength: 8 })
  .map((components) => `./${components.join(SEPARATOR)}`);

describe('normalizePathCopy properties', () => {
  describe('Given any relative path', () => {
    describe('When a normalised result is normalised again', () => {
      it('Then it is unchanged', () => {
        // Arrange
        const sut = normalizePathCopy;

        // Act + Assert
        fc.assert(
          fc.property(arbRelativePath, (path) => {
            const once = sut(path);
            return once === undefined || sut(`./${once}`) === once;
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });

    describe('When it is normalised', () => {
      it('Then no component of the result is a dot or a parent hop', () => {
        // Arrange
        const sut = normalizePathCopy;

        // Act + Assert
        fc.assert(
          fc.property(arbRelativePath, (path) => {
            const result = sut(path);
            if (result === undefined) return true;
            return result
              .split(SEPARATOR)
              .every((component) => component !== '.' && component !== '..');
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
