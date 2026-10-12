/**
 * Property tests for parseExpression.
 *
 * Lens 3 (total function) fits: over an alphabet dense in the grammar's own
 * operators (`~ ^ { } @ : /` and digits), every expression either parses to a
 * known shape or is refused with REVPARSE_UNRESOLVED naming it — never a raw
 * TypeError or RangeError. Lenses 1, 2 and 4 do not fit: there is no
 * serializer to round-trip, nothing is matched, and no feature is counted.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseExpression } from '../../../../../src/application/commands/internal/rev-parse-grammar.js';
import { TsgitError } from '../../../../../src/domain/error.js';

const NUM_RUNS = 200;
const OPERATOR_CHARS = [...'~^{}@:/-. '];
const NAME_CHARS = [...'019aHEAD', ...'commit', ...'tree', ...'blob', ...'object', ...'upstream'];
const GRAMMAR_CHARS = [...OPERATOR_CHARS, ...NAME_CHARS];
const EXPRESSION_KINDS = ['ref-or-hex', 'index-stage', 'message-search', 'tree-path'];

const arbExpression = fc
  .array(fc.constantFrom(...GRAMMAR_CHARS), { maxLength: 16 })
  .map((chars) => chars.join(''));

/** The parse's value, or what it threw. */
const outcomeOf = (run: () => unknown): unknown => {
  try {
    return run();
  } catch (error) {
    return error;
  }
};

describe('parseExpression properties', () => {
  describe('Given an arbitrary expression over the grammar alphabet', () => {
    describe('When it is parsed', () => {
      it('Then it yields a known expression or refuses it with REVPARSE_UNRESOLVED', () => {
        fc.assert(
          fc.property(arbExpression, (raw) => {
            // Arrange
            const sut = parseExpression;

            // Act
            const result = outcomeOf(() => sut(raw));

            // Assert
            if (result instanceof TsgitError) {
              expect(result.data).toEqual({ code: 'REVPARSE_UNRESOLVED', expression: raw });
            } else {
              expect(EXPRESSION_KINDS).toContain((result as { readonly kind: string }).kind);
            }
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
