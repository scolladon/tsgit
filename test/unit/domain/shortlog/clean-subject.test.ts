import { describe, expect, it } from 'vitest';
import { cleanShortlogSubject } from '../../../../src/domain/shortlog/clean-subject.js';

describe('cleanShortlogSubject', () => {
  describe('Given a raw commit subject', () => {
    describe('When cleaned', () => {
      it.each([
        {
          input: 'a normal subject',
          expected: 'a normal subject',
          label: 'a plain single-line subject is returned verbatim',
        },
        {
          input: 'Add\nfeature\n\nbody',
          expected: 'Add feature',
          label: 'a multi-line subject paragraph is folded with a single space',
        },
        { input: '\n\n  x', expected: 'x', label: 'leading blank lines are skipped' },
        { input: '[PATCH] x', expected: 'x', label: 'a "[PATCH]" prefix is stripped' },
        {
          input: '  [PATCH] x',
          expected: 'x',
          label:
            'leading whitespace before "[PATCH]" is trimmed first so the prefix is still stripped',
        },
        {
          input: '[PATCH v2] x',
          expected: 'x',
          label: 'a "[PATCH v2]" prefix strips the whole bracket',
        },
        {
          input: '[PATCHwork] y] z',
          expected: 'y] z',
          label:
            'a "[PATCH...]" prefix with a later bracket strips through the first close bracket only',
        },
        {
          input: '[PATCHv2]x] w',
          expected: 'x] w',
          label: '"[PATCHv2]" immediately followed by content strips to the first close bracket',
        },
        {
          input: '[BUGFIX] x',
          expected: '[BUGFIX] x',
          label: 'a non-PATCH bracketed prefix is left untouched',
        },
        {
          input: '[patch] x',
          expected: '[patch] x',
          label: 'a lowercase "[patch]" prefix is left untouched (case-sensitive)',
        },
        {
          input: '[PATCH no-close',
          expected: '[PATCH no-close',
          label: 'a "[PATCH" prefix with no closing bracket is left untouched',
        },
        {
          input: '[PATCH]\n\nbody',
          expected: '',
          label: '"[PATCH]" then a blank line then a body leaves the subject empty (body excluded)',
        },
        {
          input: '[PATCH]\nbody',
          expected: 'body',
          label: '"[PATCH]" then a single newline then a body folds the body into the subject',
        },
        {
          input: '[PATCH]   \n  next',
          expected: 'next',
          label:
            '"[PATCH]" with trailing spaces then an indented next line strips the prefix and intervening whitespace',
        },
        {
          input: '[PATCH]',
          expected: '',
          label: 'a bare "[PATCH]" with no content leaves the subject empty',
        },
        { input: '', expected: '', label: 'an empty message leaves the subject empty' },
      ])('Then $label', ({ input, expected }) => {
        // Arrange
        const sut = cleanShortlogSubject;

        // Act
        const result = sut(input);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
