import { posix } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  relativePathBetween,
  submoduleCoreWorktree,
  submoduleGitfile,
} from '../../../../src/domain/submodule/gitlink-path.js';
import { isUnsafeSubmoduleName } from '../../../../src/domain/submodule/name.js';
import { arbSafeSubmoduleName } from './arbitraries.js';

const RUNS = 200;

describe('Given an arbitrary safe submodule name and path', () => {
  describe('When deriving the worktree gitfile', () => {
    it('Then the `../` run equals the path segment depth and the tail is the name', () => {
      // Arrange
      fc.assert(
        fc.property(arbSafeSubmoduleName(), arbSafeSubmoduleName(), (name, path) => {
          // Act
          const result = submoduleGitfile(name, path);

          // Assert
          const expectedDepth = path.split('/').length;
          expect(result).toBe(`gitdir: ${'../'.repeat(expectedDepth)}.git/modules/${name}`);
        }),
        { numRuns: RUNS },
      );
    });
  });

  describe('When deriving the module core.worktree', () => {
    it('Then the `../` run equals 2 + the name segment depth and the tail is the path', () => {
      // Arrange
      fc.assert(
        fc.property(arbSafeSubmoduleName(), arbSafeSubmoduleName(), (name, path) => {
          // Act
          const result = submoduleCoreWorktree(name, path);

          // Assert
          const expectedDepth = 2 + name.split('/').length;
          expect(result).toBe(`${'../'.repeat(expectedDepth)}${path}`);
        }),
        { numRuns: RUNS },
      );
    });
  });

  describe('When either function runs over any safe name/path', () => {
    it('Then it is total — a non-empty string is always returned', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbSafeSubmoduleName(), arbSafeSubmoduleName(), (name, path) => {
          expect(isUnsafeSubmoduleName(name)).toBe(false);
          expect(submoduleGitfile(name, path).length).toBeGreaterThan(0);
          expect(submoduleCoreWorktree(name, path).length).toBeGreaterThan(0);
        }),
        { numRuns: RUNS },
      );
    });
  });

  describe('When deriving the relative path between two absolute directories', () => {
    it('Then joining it onto the origin and normalising lands on the target', () => {
      // Arrange
      const segments = fc.array(fc.constantFrom('a', 'b', 'c', 'wt'), {
        minLength: 1,
        maxLength: 5,
      });
      fc.assert(
        fc.property(segments, segments, (fromSegments, toSegments) => {
          const from = `/${fromSegments.join('/')}`;
          const to = `/${toSegments.join('/')}`;

          // Act
          const result = relativePathBetween(from, to);

          // Assert
          expect(posix.normalize(posix.join(from, result))).toBe(to);
        }),
        { numRuns: RUNS },
      );
    });
  });
});
