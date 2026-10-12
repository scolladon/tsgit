/**
 * Property tests for parentShorthand.
 *
 * Lens 1 (round-trip) fits: a base free of `^` suffixed with `^@`, `^!` or
 * `^-<n>` reads back as that base and form. Lens 3 (total function) is
 * covered by the same arbitrary. Lens 2 and 4 do not fit — there is nothing
 * to match and no count to keep.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parentShorthand } from '../../../../../src/application/commands/internal/rev-parse-parent-shorthand.js';

const NUM_RUNS = 200;
const arbBase = fc.stringMatching(/^[a-z0-9~:/.]{0,8}$/);
const arbParentNumber = fc.integer({ min: 1, max: 1_000 });

describe('parentShorthand properties', () => {
  describe('Given a base suffixed with ^@ or ^!', () => {
    describe('When it is read', () => {
      it('Then it yields the base and the form back', () => {
        // Arrange
        const sut = parentShorthand;

        // Act + Assert
        fc.assert(
          fc.property(arbBase, fc.constantFrom('@', '!'), (base, mark) => {
            const kind = mark === '@' ? 'parents' : 'exclude-parents';
            expect(sut(`${base}^${mark}`)).toEqual({ kind, base });
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given a base suffixed with ^-<n>', () => {
    describe('When it is read', () => {
      it('Then it yields the base and the parent number back', () => {
        // Arrange
        const sut = parentShorthand;

        // Act + Assert
        fc.assert(
          fc.property(arbBase, arbParentNumber, (base, n) => {
            expect(sut(`${base}^-${n}`)).toEqual({ kind: 'exclude-parent', base, n });
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
