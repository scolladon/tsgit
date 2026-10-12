import { describe, expect, it } from 'vitest';
import type { FileSystem } from '../../../src/ports/file-system.js';
import { createWorktreeFs } from '../../../src/repository/worktree-fs.js';

const LAYOUT_ROOTS = ['/repo', '/common'] as const;

const recordingConfine = () => {
  const calls: ReadonlyArray<string>[] = [];
  const confine = (roots: ReadonlyArray<string>): FileSystem => {
    calls.push(roots);
    return { roots } as unknown as FileSystem;
  };
  return { calls, confine };
};

describe('createWorktreeFs', () => {
  describe('Given one worktree path', () => {
    describe('When its fs is asked for', () => {
      it('Then it confines to that path followed by the layout roots', () => {
        // Arrange
        const { calls, confine } = recordingConfine();
        const sut = createWorktreeFs;

        // Act
        sut(LAYOUT_ROOTS, confine)('/outside/wt');

        // Assert
        expect(calls).toEqual([['/outside/wt', '/repo', '/common']]);
      });
    });
  });

  describe('Given two worktree paths', () => {
    describe('When their fs is asked for', () => {
      it('Then it confines to both paths followed by the layout roots', () => {
        // Arrange
        const { calls, confine } = recordingConfine();
        const sut = createWorktreeFs;

        // Act
        sut(LAYOUT_ROOTS, confine)(['/a', '/b']);

        // Assert
        expect(calls).toEqual([['/a', '/b', '/repo', '/common']]);
      });
    });
  });

  describe('Given a worktree fs already built', () => {
    describe('When the same path is asked for again', () => {
      it('Then it hands back the first one without confining again', () => {
        // Arrange
        const { calls, confine } = recordingConfine();
        const sut = createWorktreeFs;
        const worktreeFs = sut(LAYOUT_ROOTS, confine);
        const first = worktreeFs('/wt');

        // Act
        const result = worktreeFs('/wt');

        // Assert
        expect(result).toBe(first);
        expect(calls).toHaveLength(1);
      });
    });

    describe('When a different path is asked for', () => {
      it('Then it confines a fresh one', () => {
        // Arrange
        const { calls, confine } = recordingConfine();
        const sut = createWorktreeFs;
        const worktreeFs = sut(LAYOUT_ROOTS, confine);
        const first = worktreeFs('/wt');

        // Act
        const result = worktreeFs('/wt2');

        // Assert
        expect(result).not.toBe(first);
        expect(calls).toHaveLength(2);
      });
    });
  });

  describe('Given paths whose plain concatenation collides', () => {
    describe('When both are asked for', () => {
      it('Then each gets its own fs', () => {
        // Arrange
        const { confine } = recordingConfine();
        const sut = createWorktreeFs;
        const worktreeFs = sut([], confine);
        const first = worktreeFs(['/a', '/b']);

        // Act
        const result = worktreeFs('/a/b');

        // Assert
        expect(result).not.toBe(first);
      });
    });
  });
});
