import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  posixGitPathSyntax,
  windowsGitPathSyntax,
} from '../../../../../src/application/primitives/internal/git-path-syntax.js';

const ROUND_TRIP_RUNS = 200;
const INVARIANT_RUNS = 100;

const arbPath = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom('/', '\\', ':', 'C', 'x', '.', 'é', '?'), { maxLength: 12 })
    .map((chars) => chars.join(''));

const syntaxes = [
  { name: 'posix', syntax: posixGitPathSyntax, separators: /\// },
  { name: 'windows', syntax: windowsGitPathSyntax, separators: /[\\/]/ },
] as const;

describe.each(syntaxes)('$name git path syntax properties', ({ syntax, separators }) => {
  describe('Given an arbitrary path', () => {
    describe('When splitRoot', () => {
      it('Then the root and the rest rebuild the path once the root separators are restored', () => {
        fc.assert(
          fc.property(arbPath(), (path) => {
            // Arrange
            const sut = syntax.splitRoot;

            // Act
            const { root, rest } = sut(path);

            // Assert
            expect(root).toBe(path.slice(0, root.length).replace(/\\/g, '/'));
            expect(rest).toBe(path.slice(root.length));
          }),
          { numRuns: ROUND_TRIP_RUNS },
        );
      });

      it('Then a rooted path is absolute', () => {
        fc.assert(
          fc.property(arbPath(), (path) => {
            // Arrange
            const sut = syntax;

            // Act
            const { root } = sut.splitRoot(path);

            // Assert
            expect(root === '' || sut.isAbsolute(path)).toBe(true);
          }),
          { numRuns: INVARIANT_RUNS },
        );
      });
    });

    describe('When components', () => {
      it('Then every name is separator-free and only a trailing separator yields a final empty one', () => {
        fc.assert(
          fc.property(arbPath(), (path) => {
            // Arrange
            const sut = syntax.components;

            // Act
            const names = sut(path);

            // Assert
            const trailing = path !== '' && separators.test(path.slice(-1));
            const named = trailing ? names.slice(0, -1) : names;
            expect(named.every((name) => name !== '' && !separators.test(name))).toBe(true);
            expect(trailing ? names.at(-1) : '').toBe('');
            expect(names.join('')).toBe(path.split(separators).join(''));
          }),
          { numRuns: INVARIANT_RUNS },
        );
      });
    });
  });
});
