import { describe, expect, it } from 'vitest';
import {
  atomicWriteRef,
  withLockFile,
} from '../../../../src/application/primitives/atomic-write.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { buildSeededContext } from './fixtures.js';

describe('atomicWriteRef', () => {
  describe('Given refPath and content', () => {
    describe('When atomicWriteRef succeeds', () => {
      it('Then refPath contains content and lockPath is gone', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const refPath = '/repo/.git/refs/heads/feature';
        const bytes = new TextEncoder().encode(`${'a'.repeat(40)}\n`);

        // Act
        await atomicWriteRef(ctx, 'refs/heads/feature' as never, refPath, bytes);

        // Assert
        expect(await ctx.fs.exists(refPath)).toBe(true);
        expect(await ctx.fs.exists(`${refPath}.lock`)).toBe(false);
      });
    });
  });

  describe('Given a pre-existing lock file', () => {
    describe('When atomicWriteRef is called', () => {
      it('Then throws REF_LOCKED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const refPath = '/repo/.git/refs/heads/busy';
        await ctx.fs.write(`${refPath}.lock`, new Uint8Array([0]));

        // Act
        let caught: unknown;
        try {
          await atomicWriteRef(ctx, 'refs/heads/busy' as never, refPath, new Uint8Array([1]));
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REF_LOCKED');
      });
    });
  });

  describe('Given writeExclusive throws a non-FILE_EXISTS TsgitError', () => {
    describe('When atomicWriteRef is called', () => {
      it('Then propagates the original error (not REF_LOCKED)', async () => {
        // Arrange
        // Kills the `error instanceof TsgitError && code === FILE_EXISTS` mutants:
        // under a `true` mutation, ANY error becomes REF_LOCKED.
        const ctx = await buildSeededContext();
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            writeExclusive: async () => {
              throw new TsgitError({ code: 'PERMISSION_DENIED', path: '/x' });
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await atomicWriteRef(
            wrapped,
            'refs/heads/x' as never,
            '/repo/.git/refs/heads/x',
            new Uint8Array([1]),
          );
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given writeExclusive throws a plain Error (not TsgitError)', () => {
    describe('When atomicWriteRef is called', () => {
      it('Then propagates the plain Error (not REF_LOCKED)', async () => {
        // Arrange
        // Kills the `error instanceof TsgitError` mutant: under a `true` mutation,
        // a plain Error would be misclassified as REF_LOCKED.
        const ctx = await buildSeededContext();
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            writeExclusive: async () => {
              throw new Error('disk full');
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await atomicWriteRef(
            wrapped,
            'refs/heads/y' as never,
            '/repo/.git/refs/heads/y',
            new Uint8Array([1]),
          );
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).not.toBeInstanceOf(TsgitError);
        expect((caught as Error).message).toBe('disk full');
      });
    });
  });

  describe('Given rename fails and lock cleanup (rm) succeeds', () => {
    describe('When atomicWriteRef is called', () => {
      it('Then propagates the rename error after removing the lock', async () => {
        // Arrange — rename throws; rm succeeds so the catch falls through to
        // `throw error`. Kills the L28/L32 BlockStatement mutants (emptying the
        // catch body / inner try body would lose the rethrow and the rm call).
        const ctx = await buildSeededContext();
        const renameError = new TsgitError({ code: 'PERMISSION_DENIED', path: '/repo' });
        let rmCalled = false;
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rename: async () => {
              throw renameError;
            },
            rm: async (p: string) => {
              rmCalled = true;
              return ctx.fs.rm(p);
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await atomicWriteRef(
            wrapped,
            'refs/heads/r' as never,
            '/repo/.git/refs/heads/r',
            new Uint8Array([1]),
          );
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — the lock was cleaned up and the original rename error surfaced.
        expect(rmCalled).toBe(true);
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        expect(await wrapped.fs.exists('/repo/.git/refs/heads/r.lock')).toBe(false);
      });
    });
  });

  describe('Given rename fails and rm throws FILE_NOT_FOUND', () => {
    describe('When atomicWriteRef is called', () => {
      it('Then swallows the rm error and propagates the rename error', async () => {
        // Arrange — rm throws FILE_NOT_FOUND: the `!isFileNotFound` guard must
        // NOT rethrow rmError, so the original rename error propagates instead.
        // Kills L35 BooleanLiteral/ConditionalExpression and the L46 `===`/`&&`
        // mutants on the FILE_NOT_FOUND-true branch.
        const ctx = await buildSeededContext();
        const renameError = new TsgitError({ code: 'PERMISSION_DENIED', path: '/repo' });
        const rmError = new TsgitError({ code: 'FILE_NOT_FOUND', path: '/repo/x.lock' });
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rename: async () => {
              throw renameError;
            },
            rm: async () => {
              throw rmError;
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await atomicWriteRef(
            wrapped,
            'refs/heads/s' as never,
            '/repo/.git/refs/heads/s',
            new Uint8Array([1]),
          );
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — the rename error wins; the swallowed FILE_NOT_FOUND is gone.
        expect(caught).toBe(renameError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given rename fails and rm throws a non-FILE_NOT_FOUND TsgitError', () => {
    describe('When atomicWriteRef is called', () => {
      it('Then propagates the rm error', async () => {
        // Arrange — rm throws PERMISSION_DENIED: `isFileNotFound` returns false
        // (instanceof true, code !== FILE_NOT_FOUND), so `!isFileNotFound` is
        // true and rmError is rethrown. Kills the L35 ConditionalExpression
        // `false` mutant and the L46 EqualityOperator `!==` mutant.
        const ctx = await buildSeededContext();
        const rmError = new TsgitError({ code: 'PERMISSION_DENIED', path: '/repo/t.lock' });
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rename: async () => {
              throw new TsgitError({ code: 'NOT_A_DIRECTORY', path: '/repo/t' });
            },
            rm: async () => {
              throw rmError;
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await atomicWriteRef(
            wrapped,
            'refs/heads/t' as never,
            '/repo/.git/refs/heads/t',
            new Uint8Array([1]),
          );
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — the rm error propagates, not the rename error.
        expect(caught).toBe(rmError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given rename fails and rm throws a plain Error (not TsgitError)', () => {
    describe('When atomicWriteRef is called', () => {
      it('Then propagates the plain rm error', async () => {
        // Arrange — rm throws a plain Error: `isFileNotFound` returns false via
        // the `instanceof TsgitError` operand, so `!isFileNotFound` rethrows it.
        // Kills the L46 `&&` ConditionalExpression mutants on the instanceof side.
        const ctx = await buildSeededContext();
        const rmError = new Error('rm exploded');
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rename: async () => {
              throw new TsgitError({ code: 'NOT_A_DIRECTORY', path: '/repo/u' });
            },
            rm: async () => {
              throw rmError;
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await atomicWriteRef(
            wrapped,
            'refs/heads/u' as never,
            '/repo/.git/refs/heads/u',
            new Uint8Array([1]),
          );
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — the plain rm error propagates.
        expect(caught).toBe(rmError);
        expect((caught as Error).message).toBe('rm exploded');
      });
    });
  });
});

describe('withLockFile', () => {
  const onLocked = (lockPath: string): TsgitError =>
    new TsgitError({ code: 'RESOURCE_LOCKED', resource: 'ref', path: lockPath });

  describe('Given a held lock', () => {
    describe('When withLockFile is called', () => {
      it('Then it refuses through onLocked with the lock path and runs the body zero times', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const path = '/repo/.git/packed-refs';
        await ctx.fs.write(`${path}.lock`, new Uint8Array(0));
        let bodyCalls = 0;

        // Act
        let caught: unknown;
        try {
          await withLockFile(ctx, path, onLocked, async () => {
            bodyCalls += 1;
          });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('RESOURCE_LOCKED');
        if ((caught as TsgitError).data.code === 'RESOURCE_LOCKED') {
          expect((caught as TsgitError).data).toMatchObject({ path: `${path}.lock` });
        }
        expect(bodyCalls).toBe(0);
      });
    });
  });

  describe('Given a body that commits', () => {
    describe('When withLockFile is called', () => {
      it('Then path holds the committed content and no lock remains', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const path = '/repo/.git/packed-refs';
        const content = new TextEncoder().encode('committed content');

        // Act
        await withLockFile(ctx, path, onLocked, async (commit) => {
          await commit(content);
        });

        // Assert
        expect(await ctx.fs.readUtf8(path)).toBe('committed content');
        expect(await ctx.fs.exists(`${path}.lock`)).toBe(false);
      });
    });
  });

  describe('Given a body that never calls commit', () => {
    describe('When withLockFile is called', () => {
      it('Then path is left untouched and no lock remains', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const path = '/repo/.git/packed-refs';
        await ctx.fs.writeUtf8(path, 'original\n');

        // Act
        await withLockFile(ctx, path, onLocked, async () => {
          // deliberately does not call commit
        });

        // Assert
        expect(await ctx.fs.readUtf8(path)).toBe('original\n');
        expect(await ctx.fs.exists(`${path}.lock`)).toBe(false);
      });
    });
  });

  describe('Given a body that throws before committing', () => {
    describe('When withLockFile is called', () => {
      it("Then it removes the lock and rethrows the body's error", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const path = '/repo/.git/packed-refs';
        const bodyError = new Error('body exploded');

        // Act
        let caught: unknown;
        try {
          await withLockFile(ctx, path, onLocked, async () => {
            throw bodyError;
          });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(bodyError);
        expect(await ctx.fs.exists(`${path}.lock`)).toBe(false);
        expect(await ctx.fs.exists(path)).toBe(false);
      });
    });
  });

  describe('Given the commit rename fails', () => {
    describe('When withLockFile is called', () => {
      it('Then it removes the lock and rethrows the rename error', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const path = '/repo/.git/packed-refs';
        const renameError = new TsgitError({ code: 'PERMISSION_DENIED', path });
        const originalRename = ctx.fs.rename.bind(ctx.fs);
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rename: async (from: string, to: string) => {
              if (to === path) throw renameError;
              return originalRename(from, to);
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await withLockFile(wrapped, path, onLocked, async (commit) => {
            await commit(new TextEncoder().encode('x'));
          });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(renameError);
        expect(await wrapped.fs.exists(`${path}.lock`)).toBe(false);
        expect(await wrapped.fs.exists(path)).toBe(false);
      });
    });
  });
});
