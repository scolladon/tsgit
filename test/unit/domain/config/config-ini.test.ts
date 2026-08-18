import { describe, expect, it } from 'vitest';

import { parseGitBoolean, tokenizeConfig } from '../../../../src/domain/config/config-ini.js';
import { TsgitError } from '../../../../src/domain/error.js';

describe('config-ini', () => {
  describe('tokenizeConfig', () => {
    describe('Given a well-formed `[section "sub"]` header followed by an entry', () => {
      describe('When tokenized', () => {
        it('Then it produces the header and entry tokens with correct line and hasComment', () => {
          // Arrange
          const sut = tokenizeConfig;

          // Act
          const result = sut('[section "sub"]\n  key = value\n');

          // Assert
          expect(result).toEqual([
            { kind: 'header', section: 'section', subsection: 'sub', line: 0, hasComment: false },
            { kind: 'entry', key: 'key', value: 'value', startLine: 1, endLine: 2 },
          ]);
        });
      });
    });

    describe('Given a chained header whose second span is an unterminated quoted subsection', () => {
      describe('When tokenized', () => {
        it('Then it throws CONFIG_PARSE_ERROR carrying the partial name', () => {
          // Arrange
          const sut = tokenizeConfig;

          // Act + Assert
          try {
            sut('[a][b "x\n');
            expect.unreachable('tokenizeConfig must refuse an unterminated quoted subsection');
          } catch (err) {
            if (!(err instanceof TsgitError)) throw err;
            expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
            if (err.data.code === 'CONFIG_PARSE_ERROR') {
              expect(err.data.line).toBe(1);
              expect(err.data.partialSectionName).toBe('b.x');
            }
          }
        });
      });
    });

    describe('Given a chained header whose second span has a space inside a plain section name', () => {
      describe('When tokenized', () => {
        it('Then it throws CONFIG_PARSE_ERROR with no partial name', () => {
          // Arrange
          const sut = tokenizeConfig;

          // Act + Assert
          try {
            sut('[a][b c]\n');
            expect.unreachable('tokenizeConfig must refuse a spaced plain section name');
          } catch (err) {
            if (!(err instanceof TsgitError)) throw err;
            expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
            if (err.data.code === 'CONFIG_PARSE_ERROR') {
              expect(err.data.line).toBe(1);
              expect(err.data.partialSectionName).toBeUndefined();
            }
          }
        });
      });
    });
  });

  describe('parseGitBoolean', () => {
    describe('Given a valueless key (null)', () => {
      describe('When parsed', () => {
        it('Then it is ok with value true', () => {
          // Arrange
          const sut = parseGitBoolean;

          // Act
          const result = sut(null);

          // Assert
          expect(result).toEqual({ ok: true, value: true });
        });
      });
    });

    describe('Given a word outside the boolean and integer grammars', () => {
      describe('When parsed', () => {
        it('Then it is not ok', () => {
          // Arrange
          const sut = parseGitBoolean;

          // Act
          const result = sut('banana');

          // Assert
          expect(result).toEqual({ ok: false });
        });
      });
    });
  });
});
