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
        const result = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(result.layout.gitDir).toBe(`${parent.layout.gitDir}/worktrees/wt`);
        expect(result.layout.commonDir).toBe(parent.layout.gitDir);
        expect(result.layout.workDir).toBe('/abs/wt');
        expect(result.layout.bare).toBe(false);
        expect(result.cwd).toBe('/abs/wt');
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
        const result = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(result.fs).toBe(marker);
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
        const result = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(result.fs).toBe(parent.fs);
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
        const result = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(result.promisor).toBeUndefined();
        expect(result.hooks).toBeUndefined();
        expect(result.command).toBeUndefined();
      });
    });
  });

  describe('Given a parent Context whose layout carries a homeDir', () => {
    describe('When deriveWorktreeContext runs', () => {
      it('Then the child layout carries the same homeDir value', () => {
        // Arrange
        const parent = createMemoryContext({ homeDir: '/home/user' });

        // Act
        const result = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(Object.hasOwn(result.layout, 'homeDir')).toBe(true);
        expect(result.layout.homeDir).toBe('/home/user');
      });
    });
  });

  describe('Given a parent Context whose layout omits homeDir', () => {
    describe('When deriveWorktreeContext runs', () => {
      it('Then the child layout omits the homeDir key entirely', () => {
        // Arrange
        const parent = createMemoryContext();

        // Act
        const result = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(Object.hasOwn(result.layout, 'homeDir')).toBe(false);
        expect(result.layout.homeDir).toBeUndefined();
      });
    });
  });
});

describe('deriveWorktreeContext — the acceptance verdicts', () => {
  describe('Given a parent layout the acceptance tier refused', () => {
    describe('When the child context is derived', () => {
      it('Then all four verdict fields survive the derivation', async () => {
        // Arrange — the verdicts are properties of the REPOSITORY, not of the
        // entry point. A child that dropped them would read as accepted and
        // re-open the config of a repository the gate refused, which is the
        // fail-open shape the tier audit exists to fence.
        const base = createMemoryContext();
        const parent = {
          ...base,
          layout: {
            ...base.layout,
            untrusted: true as const,
            implicitBare: true as const,
            foreignPath: '/foreign/gitdir',
            formatRefusal: { kind: 'version' as const, version: 99 },
          },
        };

        // Act
        const result = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect(result.layout.untrusted).toBe(true);
        expect(result.layout.implicitBare).toBe(true);
        expect(result.layout.foreignPath).toBe('/foreign/gitdir');
        expect(result.layout.formatRefusal).toStrictEqual({ kind: 'version', version: 99 });
      });
    });
  });

  describe('Given a parent layout the acceptance tier accepted', () => {
    describe('When the child context is derived', () => {
      it('Then no verdict key is present at all, not merely undefined', async () => {
        // Arrange — present-only-when-present: an `undefined`-valued key would
        // read as a verdict that was computed and came back empty.
        const parent = createMemoryContext();

        // Act
        const result = deriveWorktreeContext(parent, 'wt', '/abs/wt');

        // Assert
        expect('untrusted' in result.layout).toBe(false);
        expect('implicitBare' in result.layout).toBe(false);
        expect('foreignPath' in result.layout).toBe(false);
        expect('formatRefusal' in result.layout).toBe(false);
      });
    });
  });
});
