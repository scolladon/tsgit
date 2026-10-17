import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { indexPathOfBytes } from '../../../../src/domain/git-index/index-path-key.js';
import { wellFormed } from '../../../../src/domain/objects/encoding.js';
import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';
import {
  matchesPathspec,
  matchesUnmergedPath,
} from '../../../../src/domain/pathspec/match-pathspec.js';
import {
  matchesIndexPath,
  matchesUnmergedIndexPath,
} from '../../../../src/domain/pathspec/matching-path.js';
import { arbRawPathBytes } from '../git-index/arbitraries.js';
import { arbCandidatePath, arbGlobPattern, arbLiteralPattern } from './arbitraries.js';

const SLASH = 0x2f;

const arbSlashFreeRawBytes = fc
  .constant(null)
  .chain(() => arbRawPathBytes().filter((bytes) => !bytes.includes(SLASH)));

const arbWellFormedLiteral = fc
  .string({ unit: 'grapheme', minLength: 1, maxLength: 8 })
  .filter((body) => /^[^!:/*?[\\\0.][^/*?[\\\0]*$/u.test(body) && wellFormed(body) === body);

describe('matchesIndexPath properties', () => {
  describe('Given a UTF-8 entry and an arbitrary spec', () => {
    describe('When matchesIndexPath is called', () => {
      it('Then the verdict equals matching the entry path directly', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.array(fc.oneof(arbLiteralPattern(), arbGlobPattern()), { maxLength: 4 }),
            arbCandidatePath(),
            (patterns, path) => {
              const spec = compilePathspec(patterns);
              expect(matchesIndexPath(spec, { path })).toBe(matchesPathspec(spec, path));
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a lossy entry and a literal spec from a well-formed string', () => {
    describe('When matchesIndexPath is called', () => {
      it('Then the literal never names the lossy entry', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbSlashFreeRawBytes, arbWellFormedLiteral, (bytes, literal) => {
            const spec = compilePathspec([literal]);
            expect(matchesIndexPath(spec, indexPathOfBytes(bytes))).toBe(false);
          }),
          { numRuns: 50 },
        );
      });
    });
  });

  describe('Given a lossy entry and the star specs', () => {
    describe('When matchesIndexPath is called', () => {
      it('Then ** matches every lossy entry and * every one without a slash', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbRawPathBytes(), (bytes) => {
            const entry = indexPathOfBytes(bytes);
            expect(matchesIndexPath(compilePathspec(['**']), entry)).toBe(true);
            if (bytes.includes(SLASH)) return;
            expect(matchesIndexPath(compilePathspec(['*']), entry)).toBe(true);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

describe('matchesUnmergedIndexPath properties', () => {
  describe('Given a UTF-8 entry, an arbitrary spec and entry count', () => {
    describe('When matchesUnmergedIndexPath is called', () => {
      it('Then the verdict equals matchesUnmergedPath on the entry path', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.array(fc.oneof(arbLiteralPattern(), arbGlobPattern()), { maxLength: 4 }),
            arbCandidatePath(),
            fc.integer({ min: 1, max: 4 }),
            (patterns, path, count) => {
              const spec = compilePathspec([...patterns, '', `!${path}`]);
              expect(matchesUnmergedIndexPath(spec, { path }, count)).toBe(
                matchesUnmergedPath(spec, path, count),
              );
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
