/**
 * Property tests for `readLooseBody`: the grammar a loose ref file is read under,
 * proven over arbitrary oids, referents and whitespace runs rather than the
 * enumerated rows of the example file.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import {
  readLooseBody,
  serializeDirectRef,
  serializeSymbolicRef,
} from '../../../../src/domain/refs/loose-ref.js';
import { arbObjectId } from '../objects/arbitraries.js';
import { arbRefName } from './arbitraries.js';

const ROUND_TRIP_NUM_RUNS = 200;
const GRAMMAR_NUM_RUNS = 100;
const HEX_LENGTHS = [40, 64] as const;
const WHITESPACE_BYTES = [' ', '\t', '\r', '\n'] as const;

const arbWhitespaceRun = (minLength: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...WHITESPACE_BYTES), { minLength, maxLength: 6 })
    .map((bytes) => bytes.join(''));

const arbNonWhitespaceByte = (): fc.Arbitrary<string> =>
  fc.constantFrom('g', 'z', '0', '-', '\v', '\f', 'é');

interface IdOfLength {
  readonly hexLength: 40 | 64;
  readonly id: ObjectId;
}

const arbIdOfLength = (): fc.Arbitrary<IdOfLength> =>
  fc
    .constantFrom(...HEX_LENGTHS)
    .chain((hexLength) => arbObjectId(hexLength).map((id): IdOfLength => ({ hexLength, id })));

const arbCaseMix = (text: string): fc.Arbitrary<string> =>
  fc
    .array(fc.boolean(), { minLength: text.length, maxLength: text.length })
    .map((flags) => [...text].map((c, i) => (flags[i] ? c.toUpperCase() : c)).join(''));

describe('readLooseBody properties', () => {
  describe('Given any serialized ref', () => {
    describe('When read back', () => {
      it('Then a direct ref returns its id with no flag', () => {
        fc.assert(
          fc.property(arbIdOfLength(), ({ hexLength, id }) => {
            // Arrange
            const content = serializeDirectRef(id);

            // Act
            const result = readLooseBody(content, hexLength);

            // Assert
            expect(result).toEqual({ kind: 'direct', id, missingNewline: false });
          }),
          { numRuns: ROUND_TRIP_NUM_RUNS },
        );
      });

      it('Then a symbolic ref returns its referent with no flag', () => {
        fc.assert(
          fc.property(arbRefName(), (name) => {
            // Arrange
            const content = serializeSymbolicRef(name);

            // Act
            const result = readLooseBody(content, 40);

            // Assert
            expect(result).toEqual({
              kind: 'symbolic',
              referent: name,
              missingNewline: false,
              trailingWhitespace: false,
            });
          }),
          { numRuns: ROUND_TRIP_NUM_RUNS },
        );
      });
    });
  });

  describe('Given any whitespace run after the keyword and at the end', () => {
    describe('When read', () => {
      it('Then the referent is the same', () => {
        fc.assert(
          fc.property(arbRefName(), arbWhitespaceRun(0), arbWhitespaceRun(0), (name, lead, end) => {
            // Arrange
            const content = `ref:${lead}${name}${end}`;

            // Act
            const result = readLooseBody(content, 40);

            // Assert
            expect(result).toMatchObject({ kind: 'symbolic', referent: name });
          }),
          { numRuns: GRAMMAR_NUM_RUNS },
        );
      });
    });
  });

  describe('Given an oid in any case mix', () => {
    describe('When read', () => {
      it('Then the id is lower case', () => {
        fc.assert(
          fc.property(
            arbIdOfLength().chain((sized) => fc.tuple(fc.constant(sized), arbCaseMix(sized.id))),
            ([{ hexLength, id }, mixed]) => {
              // Arrange
              const content = `${mixed}\n`;

              // Act
              const result = readLooseBody(content, hexLength);

              // Assert
              expect(result).toEqual({ kind: 'direct', id, missingNewline: false });
            },
          ),
          { numRuns: GRAMMAR_NUM_RUNS },
        );
      });
    });
  });

  describe('Given an oid followed by a trailer', () => {
    describe('When the trailer starts with whitespace', () => {
      it('Then the id is kept and the trailer is reported unless it is one LF', () => {
        fc.assert(
          fc.property(
            arbIdOfLength(),
            arbWhitespaceRun(1),
            fc.string(),
            ({ hexLength, id }, lead, rest) => {
              // Arrange
              const trailer = `${lead}${rest}`;

              // Act
              const result = readLooseBody(`${id}${trailer}`, hexLength);

              // Assert
              expect(result).toMatchObject({ kind: 'direct', id });
              expect('trailing' in result ? result.trailing : undefined).toBe(
                trailer === '\n' ? undefined : trailer,
              );
            },
          ),
          { numRuns: GRAMMAR_NUM_RUNS },
        );
      });
    });

    describe('When the trailer starts with any other byte', () => {
      it('Then the body is unparseable', () => {
        fc.assert(
          fc.property(
            arbIdOfLength(),
            arbNonWhitespaceByte(),
            fc.string(),
            ({ hexLength, id }, first, rest) => {
              // Arrange
              const content = `${id}${first}${rest}`;

              // Act
              const result = readLooseBody(content, hexLength);

              // Assert
              expect(result).toEqual({ kind: 'unparseable' });
            },
          ),
          { numRuns: GRAMMAR_NUM_RUNS },
        );
      });
    });
  });

  describe('Given a body that may end without a line feed', () => {
    describe('When read', () => {
      it('Then a symbolic body misses its newline exactly when its last byte is not LF', () => {
        fc.assert(
          fc.property(arbRefName(), fc.constantFrom('', '\n', ' ', '\r\n'), (name, end) => {
            // Arrange
            const content = `ref: ${name}${end}`;

            // Act
            const result = readLooseBody(content, 40);

            // Assert
            expect(result).toMatchObject({ missingNewline: !content.endsWith('\n') });
          }),
          { numRuns: GRAMMAR_NUM_RUNS },
        );
      });

      it('Then a direct body misses its newline exactly when nothing follows the oid', () => {
        fc.assert(
          fc.property(arbIdOfLength(), fc.constantFrom('', '\n'), ({ hexLength, id }, end) => {
            // Arrange
            const content = `${id}${end}`;

            // Act
            const result = readLooseBody(content, hexLength);

            // Assert
            expect(result).toMatchObject({ missingNewline: end === '' });
          }),
          { numRuns: GRAMMAR_NUM_RUNS },
        );
      });
    });
  });
});
