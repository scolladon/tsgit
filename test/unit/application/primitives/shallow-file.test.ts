/**
 * Unit tests for the `.git/shallow` reader/writer primitive.
 *
 * The primitive is a thin filesystem helper. Tests probe:
 *  - missing file → empty set
 *  - happy round-trip with multiple oids
 *  - canonical line endings + sort order
 *  - lock-rename atomicity
 *  - empty resulting set → file deleted
 */
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { readShallow, updateShallow } from '../../../../src/application/primitives/shallow-file.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';

const OID_A = ObjectId.from('a'.repeat(40));
const OID_B = ObjectId.from('b'.repeat(40));
const OID_C = ObjectId.from('c'.repeat(40));

describe('shallow-file', () => {
  describe('readShallow', () => {
    describe('Given no .git/shallow file', () => {
      describe('When read', () => {
        it('Then returns an empty Set', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);

          // Act
          const sut = await readShallow(ctx);

          // Assert
          expect(sut.size).toBe(0);
        });
      });
    });

    describe('Given a .git/shallow with two oids', () => {
      describe('When read', () => {
        it('Then returns a Set of size 2', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n${OID_B}\n`);

          // Act
          const sut = await readShallow(ctx);

          // Assert
          expect(sut.size).toBe(2);
          expect(sut.has(OID_A)).toBe(true);
          expect(sut.has(OID_B)).toBe(true);
        });
      });
    });

    describe('Given a .git/shallow with only a trailing newline', () => {
      describe('When read', () => {
        it('Then returns an empty Set', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, '\n');

          // Act
          const sut = await readShallow(ctx);

          // Assert
          expect(sut.size).toBe(0);
        });
      });
    });

    describe('Given a .git/shallow with whitespace between oids', () => {
      describe('When read', () => {
        it('Then ignores blank lines', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n\n${OID_B}\n`);

          // Act
          const sut = await readShallow(ctx);

          // Assert
          expect(sut.size).toBe(2);
        });
      });
    });

    describe('Given a .git/shallow with malformed lines (non-oid)', () => {
      describe('When read', () => {
        it('Then skips them silently', async () => {
          // Arrange — kill the `if (!isShallowOid(trimmed)) continue` survivor.
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `not-an-oid\n${OID_A}\nzzz\n`);

          // Act
          const sut = await readShallow(ctx);

          // Assert
          expect(sut.size).toBe(1);
          expect(sut.has(OID_A)).toBe(true);
        });
      });
    });

    describe('Given readUtf8 throws a non-FILE_NOT_FOUND error', () => {
      describe('When readShallow runs', () => {
        it('Then the error propagates', async () => {
          // Arrange — kill the `if (isFileNotFound(err)) return new Set()` survivor.
          const ctx = createMemoryContext();
          const boomCtx = {
            ...ctx,
            fs: {
              ...ctx.fs,
              readUtf8: async (): Promise<string> => {
                throw new Error('disk boom');
              },
            },
          };

          // Act
          let caught: unknown;
          try {
            await readShallow(boomCtx);
          } catch (err) {
            caught = err;
          }

          // Assert — non-FILE_NOT_FOUND must surface as-is, not get swallowed.
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).message).toBe('disk boom');
        });
      });
    });

    describe('Given readUtf8 throws a TsgitError that is NOT FILE_NOT_FOUND', () => {
      describe('When readShallow runs', () => {
        it('Then the error propagates', async () => {
          // Arrange — pins the RHS of `error instanceof TsgitError && error.data.code === 'FILE_NOT_FOUND'`.
          // Without this case, the `=== 'FILE_NOT_FOUND'` mutant survives because
          // the "plain Error" propagation test above hits the LHS (instanceof) check
          // not the RHS code comparison.
          const ctx = createMemoryContext();
          const boomCtx = {
            ...ctx,
            fs: {
              ...ctx.fs,
              readUtf8: async (): Promise<string> => {
                throw new TsgitError({ code: 'PERMISSION_DENIED', path: '/etc/shadow' });
              },
            },
          };

          // Act
          let caught: unknown;
          try {
            await readShallow(boomCtx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        });
      });
    });

    describe('Given a .git/shallow with a leading-space oid line', () => {
      describe('When read', () => {
        it('Then the trimmed oid is captured (kills the line.trim() → line mutant)', async () => {
          // Arrange — without `trim()`, the regex `^[0-9a-f]{40}$` fails on
          // `"  ${OID_A}  "` because of the surrounding spaces. The original
          // code trims, the mutant doesn't — the difference is observable.
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `  ${OID_A}  \n`);

          // Act
          const sut = await readShallow(ctx);

          // Assert
          expect(sut.size).toBe(1);
          expect(sut.has(OID_A)).toBe(true);
        });
      });
    });
  });

  describe('updateShallow', () => {
    describe('Given a fresh repo', () => {
      describe('When updateShallow adds two oids', () => {
        it('Then file holds them sorted', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);

          // Act
          await updateShallow(ctx, { shallow: [OID_B, OID_A], unshallow: [] });

          // Assert
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/shallow`);
          // sorted lex: a < b
          expect(written).toBe(`${OID_A}\n${OID_B}\n`);
        });
      });
    });

    describe('Given an existing shallow file', () => {
      describe('When updateShallow removes one oid via unshallow', () => {
        it('Then the file no longer carries it', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n${OID_B}\n`);

          // Act
          await updateShallow(ctx, { shallow: [], unshallow: [OID_A] });

          // Assert
          const sut = await readShallow(ctx);
          expect(sut.has(OID_A)).toBe(false);
          expect(sut.has(OID_B)).toBe(true);
        });
      });
      describe('When updateShallow empties the set via unshallow', () => {
        it('Then the file is deleted', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n`);

          // Act
          await updateShallow(ctx, { shallow: [], unshallow: [OID_A] });

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/shallow`)).toBe(false);
        });
      });
    });

    describe('Given an empty starting state', () => {
      describe('When updateShallow with empty inputs', () => {
        it('Then no file is created', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);

          // Act
          await updateShallow(ctx, { shallow: [], unshallow: [] });

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/shallow`)).toBe(false);
        });
      });
    });

    describe('Given a stale .lock file from a crashed prior write', () => {
      describe('When updateShallow runs', () => {
        it('Then throws (lock contention surfaces)', async () => {
          // Arrange — simulate a hung lock.
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow.lock`, '');

          // Act & Assert
          let caught: unknown;
          try {
            await updateShallow(ctx, { shallow: [OID_A], unshallow: [] });
          } catch (err) {
            caught = err;
          }
          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          // We accept either FILE_EXISTS (raw write-exclusive failure surface) or
          // a wrapped lock error. Both indicate the contention path fired.
          const code = (caught as TsgitError).data.code;
          expect(['FILE_EXISTS', 'RESOURCE_LOCKED']).toContain(code);
        });
      });
    });

    describe('Given a round-trip (write + read)', () => {
      describe('When the read fires', () => {
        it('Then the resulting Set matches the input', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);

          // Act
          await updateShallow(ctx, { shallow: [OID_A, OID_B, OID_C], unshallow: [] });
          const sut = await readShallow(ctx);

          // Assert
          expect(sut.size).toBe(3);
          expect([...sut].sort()).toEqual([OID_A, OID_B, OID_C]);
        });
      });
    });

    describe('Given fs.rm throws a non-FILE_NOT_FOUND error during the empty-set delete', () => {
      describe('When updateShallow runs', () => {
        it('Then the error propagates', async () => {
          // Arrange — kill both the L108 `BlockStatement -> {}` (catch body
          // emptied) and the L109 `ConditionalExpression -> true` (always
          // return) mutants in `deleteIfPresent`. With either mutant, a
          // PERMISSION_DENIED on rm would be silently swallowed.
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n`);
          const failingRm = {
            ...ctx,
            fs: {
              ...ctx.fs,
              rm: async (): Promise<void> => {
                throw new TsgitError({ code: 'PERMISSION_DENIED', path: 'shallow' });
              },
            },
          };

          // Act
          let caught: unknown;
          try {
            await updateShallow(failingRm, { shallow: [], unshallow: [OID_A] });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        });
      });
    });

    describe('Given fs.rename fails during atomicWrite', () => {
      describe('When updateShallow runs', () => {
        it('Then the rename error propagates after a best-effort lock cleanup', async () => {
          // Arrange — kills the L96 outer-catch `BlockStatement -> {}` (emptying it
          // would swallow the rename failure) and the L100 `BlockStatement -> {}`
          // (removing the `rm` call would skip lock cleanup). `rm` succeeds here so
          // the inner catch is not exercised.
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          const rmCalls: string[] = [];
          const failingRename = {
            ...ctx,
            fs: {
              ...ctx.fs,
              rename: async (): Promise<void> => {
                throw new TsgitError({ code: 'PERMISSION_DENIED', path: 'shallow' });
              },
              rm: async (p: string): Promise<void> => {
                rmCalls.push(p);
              },
            },
          };

          // Act
          let caught: unknown;
          try {
            await updateShallow(failingRename, { shallow: [OID_A], unshallow: [] });
          } catch (err) {
            caught = err;
          }

          // Assert — the rename error surfaces; the lock was cleaned up.
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
          expect(rmCalls).toEqual([`${ctx.layout.gitDir}/shallow.lock`]);
        });
      });
    });

    describe('Given fs.rename fails and the lock cleanup rm throws a non-FILE_NOT_FOUND error', () => {
      describe('When updateShallow runs', () => {
        it('Then the rm error propagates', async () => {
          // Arrange — kills L102 `BlockStatement -> {}` (swallowing rmErr would let
          // the rename error through instead), L103 `ConditionalExpression -> false`
          // (never re-throwing rmErr) and the `BooleanLiteral` mutant that drops the
          // `!` (would make `isFileNotFound` false → no throw). The inner rm error
          // is FILE_EXISTS — distinct from the rename error's PERMISSION_DENIED.
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          const failing = {
            ...ctx,
            fs: {
              ...ctx.fs,
              rename: async (): Promise<void> => {
                throw new TsgitError({ code: 'PERMISSION_DENIED', path: 'shallow' });
              },
              rm: async (): Promise<void> => {
                throw new TsgitError({ code: 'FILE_EXISTS', path: 'shallow.lock' });
              },
            },
          };

          // Act
          let caught: unknown;
          try {
            await updateShallow(failing, { shallow: [OID_A], unshallow: [] });
          } catch (err) {
            caught = err;
          }

          // Assert — the rm error wins because it is not FILE_NOT_FOUND.
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('FILE_EXISTS');
        });
      });
    });

    describe('Given fs.rename fails and the lock cleanup rm throws FILE_NOT_FOUND', () => {
      describe('When updateShallow runs', () => {
        it('Then the original rename error propagates', async () => {
          // Arrange — kills the L103 `ConditionalExpression -> true` mutant (which
          // would always re-throw rmErr — here the FILE_NOT_FOUND rm error — instead
          // of the rename error) and the `BooleanLiteral` mutant. A FILE_NOT_FOUND
          // on rm is tolerated, so the rename error must surface.
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          const failing = {
            ...ctx,
            fs: {
              ...ctx.fs,
              rename: async (): Promise<void> => {
                throw new TsgitError({ code: 'PERMISSION_DENIED', path: 'shallow' });
              },
              rm: async (): Promise<void> => {
                throw new TsgitError({ code: 'FILE_NOT_FOUND', path: 'shallow.lock' });
              },
            },
          };

          // Act
          let caught: unknown;
          try {
            await updateShallow(failing, { shallow: [OID_A], unshallow: [] });
          } catch (err) {
            caught = err;
          }

          // Assert — FILE_NOT_FOUND on rm is swallowed; the rename error surfaces.
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        });
      });
    });

    describe('Given shallow that re-adds an existing oid', () => {
      describe('When updateShallow runs', () => {
        it('Then no duplicate (Set semantics)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n`);

          // Act
          await updateShallow(ctx, { shallow: [OID_A], unshallow: [] });

          // Assert — file still contains exactly one line for OID_A.
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/shallow`);
          expect(written).toBe(`${OID_A}\n`);
        });
      });
    });
  });
});
