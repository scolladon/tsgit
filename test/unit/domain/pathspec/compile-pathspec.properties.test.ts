import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeEscaped } from '../../../../src/domain/objects/encoding.js';
import { FilePath } from '../../../../src/domain/objects/index.js';
import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';
import { MATCH_LEVEL, verbatimLevel } from '../../../../src/domain/pathspec/wildcard.js';
import { compileRefGlobBytes } from '../../../../src/domain/refs/ref-glob.js';
import {
  arbCandidatePath,
  arbEscapedPath,
  arbGlobBody,
  arbGlobPattern,
  arbLiteralPattern,
  arbOneStarBody,
} from './arbitraries.js';

const notNegated = (body: string): boolean => !body.startsWith('!');

const dialectOracle = (body: string, path: string): boolean =>
  verbatimLevel(body, path) !== MATCH_LEVEL.NONE || compileRefGlobBytes(body)(encodeEscaped(path));

describe('compile-pathspec properties', () => {
  describe('Given an arbitrary mix of literal and glob patterns', () => {
    describe('When compilePathspec is called', () => {
      it('Then it returns one entry per input and every entry has a callable matcher', () => {
        // Arrange + Act + Assert
        const arbPattern = fc.oneof(arbLiteralPattern(), arbGlobPattern());
        const arbPatterns = fc.array(arbPattern, { minLength: 0, maxLength: 6 });
        fc.assert(
          fc.property(arbPatterns, arbCandidatePath(), (patterns, path) => {
            const result = compilePathspec(patterns);
            expect(result).toHaveLength(patterns.length);
            for (const entry of result) {
              expect(typeof entry.compiled.test(path)).toBe('boolean');
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary literal pattern L', () => {
    describe('When matched against a descendant path L/<segment>', () => {
      it('Then the literal entry matches (literal-as-directory semantics)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbLiteralPattern(), arbLiteralPattern(), (literal, child) => {
            const result = compilePathspec([literal])[0];
            const descendant = FilePath.from(`${literal}/${child}`);
            expect(result?.isLiteral).toBe(true);
            expect(result?.compiled.test(descendant)).toBe(true);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given arbitrary glob bodies (totality)', () => {
    describe('When compilePathspec is called', () => {
      it('Then it returns one entry per input and every test returns a boolean for escape-view paths', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.array(arbGlobBody(), { maxLength: 4 }),
            arbEscapedPath(),
            (bodies, path) => {
              const result = compilePathspec(bodies);
              expect(result).toHaveLength(bodies.length);
              for (const entry of result) {
                expect(typeof entry.compiled.test(path)).toBe('boolean');
              }
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe.each([
    { shape: 'one-star', arbBody: arbOneStarBody },
    { shape: 'general', arbBody: arbGlobBody },
  ])('Given an arbitrary $shape body (fast path equals the byte DP)', ({ arbBody }) => {
    describe('When testing an arbitrary escape-view path', () => {
      it('Then the verdict equals verbatim-or-wildmatch over the path bytes', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbBody().filter(notNegated), arbEscapedPath(), (body, path) => {
            const sut = compilePathspec;
            const expected = dialectOracle(body, path);
            expect(sut([body])[0]?.compiled.test(path)).toBe(expected);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary non-empty body not ending in "/" (verbatim invariant)', () => {
    describe('When testing the body and a descendant of it', () => {
      it('Then both match', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbGlobBody().filter((body) => notNegated(body) && body !== '' && !body.endsWith('/')),
            arbLiteralPattern(),
            (body, segment) => {
              const sut = compilePathspec;
              const compiled = sut([body])[0]?.compiled;
              expect(compiled?.test(body)).toBe(true);
              expect(compiled?.test(`${body}/${segment}`)).toBe(true);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
