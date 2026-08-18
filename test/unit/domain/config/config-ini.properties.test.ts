/**
 * Property test for the config tokeniser — a total function over the config
 * grammar (lens 3): on any printable-ASCII input it either tokenises or
 * refuses with the grammar's own structured parse error, never anything
 * else. The example file pins the literal token shapes; this proves the
 * totality the examples cannot enumerate.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { tokenizeConfig } from '../../../../src/domain/config/config-ini.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { arbConfigTextChar } from './arbitraries.js';

const TOTALITY_NUM_RUNS = 100;

// 4 KiB — each generated char is one code unit, so maxLength doubles as the byte cap.
const MAX_CONFIG_TEXT_LENGTH = 4096;

describe('tokenizeConfig properties', () => {
  describe('Given arbitrary printable-ASCII config text up to 4 KiB', () => {
    describe('When tokenizeConfig runs', () => {
      it('Then it returns tokens or throws CONFIG_PARSE_ERROR — never any other failure', () => {
        // Arrange
        const sut = tokenizeConfig;

        // Act & Assert
        fc.assert(
          fc.property(
            fc.string({ unit: arbConfigTextChar(), maxLength: MAX_CONFIG_TEXT_LENGTH }),
            (text) => {
              try {
                const result = sut(text, '/repo/.git/config');
                expect(Array.isArray(result)).toBe(true);
              } catch (err) {
                expect(err).toBeInstanceOf(TsgitError);
                expect((err as TsgitError).data.code).toBe('CONFIG_PARSE_ERROR');
              }
            },
          ),
          { numRuns: TOTALITY_NUM_RUNS },
        );
      });
    });
  });
});
