/**
 * Property tests for `readLooseBody`: the grammar a loose ref file is read under,
 * proven over arbitrary oids, referents and whitespace runs rather than the
 * enumerated rows of the example file.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  readLooseBody,
  serializeDirectRef,
  serializeSymbolicRef,
} from '../../../../src/domain/refs/loose-ref.js';
import { arbObjectId } from '../objects/arbitraries.js';
import { arbRefName } from './arbitraries.js';

const ROUND_TRIP_NUM_RUNS = 200;
const GRAMMAR_NUM_RUNS = 100;
const WHITESPACE_BYTES = [' ', '\t', '\r', '\n'] as const;

const arbWhitespaceRun = (minLength: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...WHITESPACE_BYTES), { minLength, maxLength: 6 })
    .map((bytes) => bytes.join(''));

const arbNonWhitespaceByte = (): fc.Arbitrary<string> =>
  fc.constantFrom('g', 'z', '0', '-', '\v', '\f', 'é');

const arbCaseMix = (text: string): fc.Arbitrary<string> =>
  fc
    .array(fc.boolean(), { minLength: text.length, maxLength: text.length })
    .map((flags) => [...text].map((c, i) => (flags[i] ? c.toUpperCase() : c)).join(''));

describe('readLooseBody properties', () => {
  describe('Given any serialized ref', () => {
    describe('When read back', () => {
      it('Then a direct ref returns its id with no flag', () => {
        fc.assert(
          fc.property(arbObjectId(40), (id) => {
            // Arrange
            const content = serializeDirectRef(id);

            // Act
            const result = readLooseBody(content, 40);

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
            arbObjectId(40).chain((id) => fc.tuple(fc.constant(id), arbCaseMix(id))),
            ([id, mixed]) => {
              // Arrange
              const content = `${mixed}\n`;

              // Act
              const result = readLooseBody(content, 40);

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
          fc.property(arbObjectId(40), arbWhitespaceRun(1), fc.string(), (id, lead, rest) => {
            // Arrange
            const trailer = `${lead}${rest}`;

            // Act
            const result = readLooseBody(`${id}${trailer}`, 40);

            // Assert
            expect(result).toMatchObject({ kind: 'direct', id });
            expect('trailing' in result ? result.trailing : undefined).toBe(
              trailer === '\n' ? undefined : trailer,
            );
          }),
          { numRuns: GRAMMAR_NUM_RUNS },
        );
      });
    });

    describe('When the trailer starts with any other byte', () => {
      it('Then the body is unparseable', () => {
        fc.assert(
          fc.property(arbObjectId(40), arbNonWhitespaceByte(), fc.string(), (id, first, rest) => {
            // Arrange
            const content = `${id}${first}${rest}`;

            // Act
            const result = readLooseBody(content, 40);

            // Assert
            expect(result).toEqual({ kind: 'unparseable' });
          }),
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
          fc.property(arbObjectId(40), fc.constantFrom('', '\n'), (id, end) => {
            // Arrange
            const content = `${id}${end}`;

            // Act
            const result = readLooseBody(content, 40);

            // Assert
            expect(result).toMatchObject({ missingNewline: end === '' });
          }),
          { numRuns: GRAMMAR_NUM_RUNS },
        );
      });
    });
  });
});
