/**
 * Properties of git's commented-lines serializer: stripping the comment prefix
 * (and the one space it adds) from every line gives back the completed input,
 * and every written line is a comment.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { commentLines } from '../../../../src/domain/merge/merge-signatures.js';

const line = fc.stringMatching(/^[\t a-z#-]{0,12}$/);
const text = fc.array(line, { minLength: 1, maxLength: 6 }).map((lines) => lines.join('\n'));

const uncomment = (commented: string): string =>
  commented
    .split(/(?<=\n)/)
    .map((written) => {
      const rest = written.slice(1);
      return rest.startsWith(' ') ? rest.slice(1) : rest;
    })
    .join('');

const completed = (input: string): string => (input.endsWith('\n') ? input : `${input}\n`);

describe('commentLines properties', () => {
  describe('Given any non-empty text', () => {
    describe('When commented then uncommented', () => {
      it('Then the completed text comes back', () => {
        // Arrange
        const sut = commentLines;

        // Act & Assert
        fc.assert(
          fc.property(
            text.filter((input) => input !== ''),
            (input) => {
              expect(uncomment(sut(input))).toBe(completed(input));
            },
          ),
        );
      });
    });

    describe('When commented', () => {
      it('Then every written line starts with the comment prefix', () => {
        // Arrange
        const sut = commentLines;

        // Act & Assert
        fc.assert(
          fc.property(text, (input) => {
            const lines = sut(input)
              .split(/(?<=\n)/)
              .filter((written) => written !== '');
            expect(lines.every((written) => written.startsWith('#'))).toBe(true);
          }),
        );
      });
    });
  });
});
