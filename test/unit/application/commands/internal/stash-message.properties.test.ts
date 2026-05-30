import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { subjectOf } from '../../../../../src/application/commands/internal/stash-message.js';

// Only `subjectOf` carries a non-trivial invariant (it is a first-line
// decoder). The `wip`/`on`/`index`/`untracked` builders are pure template
// interpolation with no algebraic structure — a "never throws" property over
// them would be a tautology, so per the project's property-testing guidance
// they are covered by example tests only.
describe('subjectOf — properties', () => {
  describe('Given an arbitrary commit message', () => {
    describe('When the subject is extracted', () => {
      it('Then the result never contains a newline', () => {
        // Arrange
        const sut = subjectOf;

        // Act + Assert
        fc.assert(
          fc.property(fc.string(), (message) => {
            expect(sut(message).includes('\n')).toBe(false);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary newline-free message', () => {
    describe('When the subject is extracted', () => {
      it('Then the message is returned verbatim', () => {
        // Arrange
        const sut = subjectOf;

        // Act + Assert
        fc.assert(
          fc.property(
            fc.string().filter((s) => !s.includes('\n')),
            (message) => {
              expect(sut(message)).toBe(message);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
