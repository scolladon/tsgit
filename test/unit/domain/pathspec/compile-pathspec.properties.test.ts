import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FilePath } from '../../../../src/domain/objects/index.js';
import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';
import { arbCandidatePath, arbGlobPattern, arbLiteralPattern } from './arbitraries.js';

describe('compile-pathspec properties', () => {
  describe('Given an arbitrary mix of literal and glob patterns', () => {
    describe('When compilePathspec is called', () => {
      it('Then it returns one entry per input and every entry has a callable matcher', () => {
        // Arrange + Act + Assert
        const arbPattern = fc.oneof(arbLiteralPattern(), arbGlobPattern());
        const arbPatterns = fc.array(arbPattern, { minLength: 0, maxLength: 6 });
        fc.assert(
          fc.property(arbPatterns, arbCandidatePath(), (patterns, path) => {
            const sut = compilePathspec(patterns);
            expect(sut).toHaveLength(patterns.length);
            for (const entry of sut) {
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
            const sut = compilePathspec([literal])[0];
            const descendant = FilePath.from(`${literal}/${child}`);
            expect(sut?.isLiteral).toBe(true);
            expect(sut?.compiled.test(descendant)).toBe(true);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
