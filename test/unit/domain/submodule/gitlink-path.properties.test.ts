import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
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
      const sut = submoduleGitfile;
      // Act + Assert
      fc.assert(
        fc.property(arbSafeSubmoduleName(), arbSafeSubmoduleName(), (name, path) => {
          const result = sut(name, path);
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
      const sut = submoduleCoreWorktree;
      // Act + Assert
      fc.assert(
        fc.property(arbSafeSubmoduleName(), arbSafeSubmoduleName(), (name, path) => {
          const result = sut(name, path);
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
});
