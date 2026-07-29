/**
 * Property tests for `parseGitfilePointer`/`parseCommondir`: round-trip
 * through the real `worktreeGitfile` serializer and totality over arbitrary
 * printable-ASCII content.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { worktreeGitfile } from '../../../../src/domain/worktree/admin-files.js';
import { parseCommondir, parseGitfilePointer } from '../../../../src/domain/worktree/gitfile.js';
import { arbPathValue, arbPrintableAsciiContent } from './arbitraries.js';

const ROUND_TRIP_NUM_RUNS = 200;
const TOTALITY_NUM_RUNS = 100;

describe('gitfile/commondir parser properties', () => {
  describe('Given an arbitrary path with no CR/LF, serialized through worktreeGitfile', () => {
    describe('When parseGitfilePointer parses the newline-terminated serialized form', () => {
      it('Then it round-trips to the original path', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbPathValue(), (path) => {
            const result = parseGitfilePointer(`${worktreeGitfile(path)}\n`);

            return result.kind === 'ok' && result.path === path;
          }),
          { numRuns: ROUND_TRIP_NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary commondir value with no CR/LF', () => {
    describe('When parseCommondir parses its newline-terminated serialized form', () => {
      it('Then it round-trips to the original value', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbPathValue(), (value) => {
            const result = parseCommondir(`${value}\n`);

            return result.kind === 'ok' && result.path === value;
          }),
          { numRuns: ROUND_TRIP_NUM_RUNS },
        );
      });
    });
  });

  describe('Given arbitrary printable-ASCII gitfile content', () => {
    describe('When parseGitfilePointer parses it', () => {
      it('Then it always returns a variant instead of throwing', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbPrintableAsciiContent(), (content) => {
            const result = parseGitfilePointer(content);

            return (
              result.kind === 'ok' || result.kind === 'invalid-format' || result.kind === 'no-path'
            );
          }),
          { numRuns: TOTALITY_NUM_RUNS },
        );
      });
    });
  });
});
