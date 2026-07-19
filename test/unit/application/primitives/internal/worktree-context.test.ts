import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { deriveWorktreeContext } from '../../../../../src/application/primitives/internal/worktree-context.js';

describe('deriveWorktreeContext', () => {
  describe('Given a parent Context and a linked worktree id + path', () => {
    describe('When deriveWorktreeContext runs', () => {
      it('Then the child gitDir is the admin dir and commonDir is the parent gitdir', () => {
        // Arrange
        const parent = createMemoryContext();

        // Act
        const sut = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(sut.layout.gitDir).toBe(`${parent.layout.gitDir}/worktrees/wt`);
        expect(sut.layout.commonDir).toBe(parent.layout.gitDir);
        expect(sut.layout.workDir).toBe('/abs/wt');
        expect(sut.layout.bare).toBe(false);
        expect(sut.cwd).toBe('/abs/wt');
      });
    });
  });

  describe('Given a parent Context exposing a worktreeFs capability', () => {
    describe('When deriveWorktreeContext runs', () => {
      it('Then the child fs is the worktree-confined fs for that path', () => {
        // Arrange
        const base = createMemoryContext();
        const marker = { marker: true } as never;
        const calls: Array<string | ReadonlyArray<string>> = [];
        const parent = {
          ...base,
          worktreeFs: (p: string | ReadonlyArray<string>) => {
            calls.push(p);
            return marker;
          },
        };

        // Act
        const sut = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(sut.fs).toBe(marker);
        expect(calls).toEqual(['/abs/wt']);
      });
    });
  });

  describe('Given a parent Context with no worktreeFs capability', () => {
    describe('When deriveWorktreeContext runs', () => {
      it('Then the child fs falls back to the parent fs', () => {
        // Arrange
        const parent = createMemoryContext();

        // Act
        const sut = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(sut.fs).toBe(parent.fs);
      });
    });
  });

  describe('Given a parent Context carrying promisor, hooks and command', () => {
    describe('When deriveWorktreeContext runs', () => {
      it('Then the child drops promisor, hooks and command', () => {
        // Arrange
        const base = createMemoryContext();
        const parent = {
          ...base,
          promisor: { fetch: async () => undefined },
          hooks: {},
          command: { run: async () => ({ exitCode: 0 }) },
        } as never;

        // Act
        const sut = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(sut.promisor).toBeUndefined();
        expect(sut.hooks).toBeUndefined();
        expect(sut.command).toBeUndefined();
      });
    });
  });

  describe('Given a parent Context whose layout carries a homeDir', () => {
    describe('When deriveWorktreeContext runs', () => {
      it('Then the child layout carries the same homeDir value', () => {
        // Arrange
        const parent = createMemoryContext({ homeDir: '/home/user' });

        // Act
        const sut = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(Object.hasOwn(sut.layout, 'homeDir')).toBe(true);
        expect(sut.layout.homeDir).toBe('/home/user');
      });
    });
  });

  describe('Given a parent Context whose layout omits homeDir', () => {
    describe('When deriveWorktreeContext runs', () => {
      it('Then the child layout omits the homeDir key entirely', () => {
        // Arrange
        const parent = createMemoryContext();

        // Act
        const sut = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(Object.hasOwn(sut.layout, 'homeDir')).toBe(false);
        expect(sut.layout.homeDir).toBeUndefined();
      });
    });
  });
});
