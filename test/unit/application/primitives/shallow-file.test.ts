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
import { MAX_SHALLOW_ENTRIES } from '../../../../src/application/primitives/internal/parse-shallow.js';
import { readShallow, updateShallow } from '../../../../src/application/primitives/shallow-file.js';
import {
  REASON_SHALLOW_BAD_LINE,
  REASON_SHALLOW_OID_WIDTH,
  REASON_SHALLOW_TOO_MANY_ENTRIES,
} from '../../../../src/application/primitives/validators.js';
import { notADirectory, TsgitError } from '../../../../src/domain/index.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';

const expectMalformedAt = async (raw: string, lineNumber: number): Promise<void> => {
  const ctx = createMemoryContext();
  await ctx.fs.mkdir(ctx.layout.gitDir);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, raw);

  // Act
  try {
    await readShallow(ctx);
    throw new Error('expected throw');
  } catch (err) {
    // Assert
    expect(err).toBeInstanceOf(TsgitError);
    if (!(err instanceof TsgitError)) throw err;
    expect(err.data.code).toBe('SHALLOW_FILE_MALFORMED');
    expect(err.data.code === 'SHALLOW_FILE_MALFORMED' && err.data.reason).toBe(
      REASON_SHALLOW_BAD_LINE,
    );
    expect(err.data.code === 'SHALLOW_FILE_MALFORMED' && err.data.lineNumber).toBe(lineNumber);
  }
};

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
          const result = await readShallow(ctx);

          // Assert
          expect(result.size).toBe(0);
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
          const result = await readShallow(ctx);

          // Assert
          expect(result.size).toBe(2);
          expect(result.has(OID_A)).toBe(true);
          expect(result.has(OID_B)).toBe(true);
        });
      });
    });

    describe('Given a .git/shallow with only a trailing newline', () => {
      describe('When read', () => {
        it('Then throws SHALLOW_FILE_MALFORMED at line 1', async () => {
          // Arrange & Act & Assert — a lone LF is one blank line; git refuses it.
          await expectMalformedAt('\n', 1);
        });
      });
    });

    describe('Given a .git/shallow with whitespace between oids', () => {
      describe('When read', () => {
        it('Then throws SHALLOW_FILE_MALFORMED at line 2', async () => {
          // Arrange & Act & Assert — an embedded blank line is refused, not skipped.
          await expectMalformedAt(`${OID_A}\n\n${OID_B}\n`, 2);
        });
      });
    });

    describe('Given a .git/shallow with malformed lines (non-oid)', () => {
      describe('When read', () => {
        it('Then throws SHALLOW_FILE_MALFORMED at line 1', async () => {
          // Arrange & Act & Assert — a non-hex line is refused, not skipped.
          await expectMalformedAt(`not-an-oid\n${OID_A}\nzzz\n`, 1);
        });
      });
    });

    describe('Given a .git/shallow oid with no corresponding object in the store', () => {
      describe('When read', () => {
        it('Then the oid is still returned (readShallow does no existence check)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n`);

          // Act
          const result = await readShallow(ctx);

          // Assert
          expect(result.has(OID_A)).toBe(true);
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
        it('Then throws SHALLOW_FILE_MALFORMED at line 1 (git does not trim)', async () => {
          // Arrange & Act & Assert — a leading space shifts the 40-hex prefix
          // window, so it no longer matches; canonical git does not trim lines.
          await expectMalformedAt(`  ${OID_A}  \n`, 1);
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
          const result = await readShallow(ctx);
          expect(result.has(OID_A)).toBe(false);
          expect(result.has(OID_B)).toBe(true);
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
          const result = await readShallow(ctx);

          // Assert
          expect(result.size).toBe(3);
          expect([...result].sort()).toEqual([OID_A, OID_B, OID_C]);
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

    describe('Given an update whose resulting set would exceed the entry cap', () => {
      describe('When updateShallow runs', () => {
        it('Then refuses before writing and leaves repository state untouched', async () => {
          // Arrange — the write side enforces the reader bound, so a hostile
          // server cannot persist a file every later read would refuse.
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          const overCap = Array.from(
            { length: MAX_SHALLOW_ENTRIES + 1 },
            (_, i) => i.toString(16).padStart(40, '0') as ObjectId,
          );

          // Act
          let caught: unknown;
          try {
            await updateShallow(ctx, { shallow: overCap, unshallow: [] });
            expect.unreachable();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          if (!(caught instanceof TsgitError)) throw caught;
          expect(caught.data.code).toBe('SHALLOW_FILE_MALFORMED');
          expect(caught.data.code === 'SHALLOW_FILE_MALFORMED' && caught.data.reason).toBe(
            REASON_SHALLOW_TOO_MANY_ENTRIES,
          );
          expect(caught.data.code === 'SHALLOW_FILE_MALFORMED' && caught.data.lineNumber).toBe(
            MAX_SHALLOW_ENTRIES + 1,
          );
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/shallow`)).toBe(false);
        });

        it('Then a resulting set exactly at the cap is written', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          const atCap = Array.from(
            { length: MAX_SHALLOW_ENTRIES },
            (_, i) => i.toString(16).padStart(40, '0') as ObjectId,
          );

          // Act
          await updateShallow(ctx, { shallow: atCap, unshallow: [] });

          // Assert
          const written = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/shallow`);
          expect(written.length).toBe(MAX_SHALLOW_ENTRIES * 41);
        });
      });
    });
  });

  describe('sha256 repositories', () => {
    describe('Given a sha256 repository with a 64-hex shallow line', () => {
      describe('When read', () => {
        it('Then returns the full 64-hex oid untruncated', async () => {
          // Arrange
          const ctx = createMemoryContext({ algorithm: 'sha256' });
          await ctx.fs.mkdir(ctx.layout.gitDir);
          const oid64 = ObjectId.from('d'.repeat(64));
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${oid64}\n`);

          // Act
          const result = await readShallow(ctx);

          // Assert
          expect(result.has(oid64)).toBe(true);
          expect(result.size).toBe(1);
        });
      });

      describe('When round-tripped through updateShallow', () => {
        it('Then the re-read set carries the full 64-hex oid', async () => {
          // Arrange
          const ctx = createMemoryContext({ algorithm: 'sha256' });
          await ctx.fs.mkdir(ctx.layout.gitDir);
          const oid64 = ObjectId.from('e'.repeat(64));

          // Act
          await updateShallow(ctx, { shallow: [oid64], unshallow: [] });
          const result = await readShallow(ctx);

          // Assert
          expect(result.has(oid64)).toBe(true);
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/shallow`)).toBe(`${oid64}\n`);
        });
      });
    });

    describe('Given a sha1 repository and a 64-hex oid to persist', () => {
      describe('When updateShallow runs', () => {
        it('Then refuses: persisting a foreign-width oid would truncate on the next read', async () => {
          // Arrange — the wire parser accepts either width, so the write gate
          // is what keeps the on-disk file readable at the repository width.
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(ctx.layout.gitDir);
          const oid64 = ObjectId.from('f'.repeat(64));

          // Act
          let caught: unknown;
          try {
            await updateShallow(ctx, { shallow: [oid64], unshallow: [] });
            expect.unreachable();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          if (!(caught instanceof TsgitError)) throw caught;
          expect(caught.data.code).toBe('SHALLOW_FILE_MALFORMED');
          expect(caught.data.code === 'SHALLOW_FILE_MALFORMED' && caught.data.reason).toBe(
            REASON_SHALLOW_OID_WIDTH,
          );
          expect(caught.data.code === 'SHALLOW_FILE_MALFORMED' && caught.data.lineNumber).toBe(1);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/shallow`)).toBe(false);
        });
      });
    });

    describe('Given a sha256 repository with a 40-hex shallow line', () => {
      describe('When read', () => {
        it('Then refuses: the line is short of the repository oid length', async () => {
          // Arrange
          const ctx = createMemoryContext({ algorithm: 'sha256' });
          await ctx.fs.mkdir(ctx.layout.gitDir);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${OID_A}\n`);

          // Act
          let caught: unknown;
          try {
            await readShallow(ctx);
            expect.unreachable();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          if (!(caught instanceof TsgitError)) throw caught;
          expect(caught.data.code).toBe('SHALLOW_FILE_MALFORMED');
          expect(caught.data.code === 'SHALLOW_FILE_MALFORMED' && caught.data.reason).toBe(
            REASON_SHALLOW_BAD_LINE,
          );
        });
      });
    });
  });

  describe('Given a git dir whose path component is not a directory', () => {
    describe('When read', () => {
      it('Then NOT_A_DIRECTORY counts as absent — same predicate as the per-Context memo', async () => {
        // Arrange
        const base = createMemoryContext();
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            readUtf8: async () => {
              throw notADirectory(`${base.layout.gitDir}/shallow`);
            },
          },
        };

        // Act
        const result = await readShallow(ctx);

        // Assert
        expect(result.size).toBe(0);
      });
    });
  });
});
