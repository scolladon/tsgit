import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const ID_A = 'a'.repeat(40) as ObjectId;
const ID_B = 'b'.repeat(40) as ObjectId;
const ZERO = '0'.repeat(40) as ObjectId;
const ID_A_SHA256 = 'a'.repeat(64) as ObjectId;
const ZERO_SHA256 = '0'.repeat(64) as ObjectId;
const MAIN = 'refs/heads/main' as RefName;
const HEAD = 'HEAD' as RefName;
const REASON = 'commit: test';

/**
 * Recursively read every file under `dir` (sorted, path + UTF-8 content
 * pairs) so a test can compare a directory's contents byte-for-byte before
 * and after an operation. `dir` itself may not exist — that's "no files".
 */
async function snapshotDir(
  ctx: Context,
  dir: string,
): Promise<ReadonlyArray<readonly [string, string]>> {
  if (!(await ctx.fs.exists(dir))) return [];
  const entries = await ctx.fs.readdir(dir);
  const files: Array<readonly [string, string]> = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...(await snapshotDir(ctx, path)));
    } else {
      files.push([path, await ctx.fs.readUtf8(path)]);
    }
  }
  return files.slice().sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

describe('updateRef', () => {
  describe('Given a fresh ref', () => {
    describe('When updateRef is called', () => {
      it('Then resolveRef returns the new id', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        await updateRef(ctx, 'refs/heads/new' as RefName, ID_A, { reflogMessage: REASON });
        const result = await resolveRef(ctx, 'refs/heads/new' as RefName);

        // Assert
        expect(result).toBe(ID_A);
      });
    });
  });

  describe('Given a pre-existing .lock file', () => {
    describe('When updateRef is called', () => {
      it('Then throws REF_LOCKED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write('/repo/.git/refs/heads/busy.lock', new Uint8Array([0]));

        // Act + Assert
        try {
          await updateRef(ctx, 'refs/heads/busy' as RefName, ID_A, { reflogMessage: REASON });
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('REF_LOCKED');
        }
      });
    });
  });

  describe('Given CAS hit (expected matches current)', () => {
    describe('When updateRef is called', () => {
      it('Then succeeds', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: MAIN, id: ID_A }],
        });

        // Act
        await updateRef(ctx, MAIN, ID_B, { expected: ID_A, reflogMessage: REASON });
        const result = await resolveRef(ctx, MAIN);

        // Assert
        expect(result).toBe(ID_B);
      });
    });
  });

  describe('Given CAS miss (expected differs from current)', () => {
    describe('When updateRef is called', () => {
      it('Then throws REF_UPDATE_CONFLICT with data.expected and data.actual populated', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: MAIN, id: ID_A }],
        });

        // Act + Assert
        try {
          await updateRef(ctx, MAIN, ID_B, { expected: ID_B, reflogMessage: REASON });
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('REF_UPDATE_CONFLICT');
          if (data.code === 'REF_UPDATE_CONFLICT') {
            expect(data.expected).toBe(ID_B);
            expect(data.actual).toBe(ID_A);
          }
        }
      });
    });
  });

  describe('Given CAS expected="absent" on a missing ref', () => {
    describe('When updateRef is called', () => {
      it('Then succeeds', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        await updateRef(ctx, 'refs/heads/fresh' as RefName, ID_A, {
          expected: 'absent',
          reflogMessage: REASON,
        });
        const result = await resolveRef(ctx, 'refs/heads/fresh' as RefName);

        // Assert
        expect(result).toBe(ID_A);
      });
    });
  });

  describe('Given CAS expected="absent" on an existing ref', () => {
    describe('When updateRef is called', () => {
      it('Then throws REF_UPDATE_CONFLICT', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: MAIN, id: ID_A }],
        });

        // Act + Assert
        try {
          await updateRef(ctx, MAIN, ID_B, { expected: 'absent', reflogMessage: REASON });
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('REF_UPDATE_CONFLICT');
        }
      });
    });
  });

  describe('Given an invalid ref name', () => {
    describe('When updateRef is called', () => {
      it('Then throws INVALID_REF', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act + Assert
        try {
          await updateRef(ctx, '..' as RefName, ID_A, { reflogMessage: REASON });
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_REF');
        }
      });
    });
  });

  describe('Given a repository whose HEAD cannot be resolved', () => {
    describe('When updateRef writes a branch', () => {
      it('Then it throws and leaves the ref and its reflog byte-unchanged', async () => {
        // Arrange
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/.invalid\n');
        const refsBefore = await snapshotDir(ctx, `${ctx.layout.gitDir}/refs`);
        const logsBefore = await snapshotDir(ctx, `${ctx.layout.gitDir}/logs`);

        // Act
        let thrown: TsgitError | undefined;
        try {
          await updateRef(ctx, MAIN, ID_B, { reflogMessage: REASON });
          expect.unreachable();
        } catch (error) {
          thrown = error as TsgitError;
        }

        // Assert
        expect(thrown?.data.code).toBe('INVALID_REF');
        expect(await snapshotDir(ctx, `${ctx.layout.gitDir}/refs`)).toEqual(refsBefore);
        expect(await snapshotDir(ctx, `${ctx.layout.gitDir}/logs`)).toEqual(logsBefore);
      });

      it('Then the coupled HEAD reflog is not written', async () => {
        // Arrange
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/.invalid\n');

        // Act
        try {
          await updateRef(ctx, MAIN, ID_B, { reflogMessage: REASON });
          expect.unreachable();
        } catch {
          // the throw itself is asserted by the sibling test
        }

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/HEAD`)).toBe(false);
      });
    });
  });

  describe('Given delete=true on a loose ref', () => {
    describe('When updateRef is called', () => {
      it('Then ref is removed', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/tmp' as RefName, id: ID_A }],
        });

        // Act
        await updateRef(ctx, 'refs/heads/tmp' as RefName, ID_A, { delete: true });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/tmp')).toBe(false);
      });
    });
  });

  describe('Given delete=true on a packed-only ref', () => {
    describe('When updateRef is called', () => {
      it('Then throws UNSUPPORTED_OPERATION with operation and reason set', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/old' as RefName, id: ID_A }],
        });

        // Act + Assert
        try {
          await updateRef(ctx, 'refs/tags/old' as RefName, ID_A, { delete: true });
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('UNSUPPORTED_OPERATION');
          if (data.code === 'UNSUPPORTED_OPERATION') {
            expect(data.operation).toBe('delete-packed-ref');
            expect(data.reason).toMatch(/packed-only refs/);
          }
        }
      });
    });
  });

  describe('Given delete=true on a ref that exists in neither loose nor packed storage', () => {
    describe('When updateRef is called', () => {
      it('Then throws REF_NOT_FOUND', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act + Assert
        try {
          await updateRef(ctx, 'refs/heads/never-existed' as RefName, ID_A, { delete: true });
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('REF_NOT_FOUND');
        }
      });
    });
  });

  describe('reflog logging', () => {
    describe('Given a fresh branch write', () => {
      describe('When updateRef is called', () => {
        it('Then a reflog entry records ZERO_OID → newId with the message', async () => {
          // Arrange
          const ctx = await buildSeededContext();

          // Act
          await updateRef(ctx, MAIN, ID_A, { reflogMessage: 'commit (initial): seed' });
          const result = await readReflog(ctx, MAIN);

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.oldId).toBe(ZERO);
          expect(result[0]?.newId).toBe(ID_A);
          expect(result[0]?.message).toBe('commit (initial): seed');
        });
      });
    });

    describe('Given a fresh branch write in a SHA-256 repository', () => {
      describe('When updateRef is called', () => {
        it('Then the raw reflog line bytes start with the 64-zero oldId', async () => {
          // Arrange — reads the raw `.git/logs/<ref>` bytes rather than going
          // through `readReflog`/`parseReflogLine`, which is a separate,
          // not-yet-width-aware cluster (`reflog-format.ts`'s `OID_LENGTH`).
          // This proves the WRITE side (`recordRefUpdate` → `updateRef`'s
          // zero-oid fallback) actually emits 64 zeros on disk.
          const ctx = createMemoryContext({ algorithm: 'sha256' });

          // Act
          await updateRef(ctx, MAIN, ID_A_SHA256, { reflogMessage: 'commit (initial): seed' });
          const line = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/${MAIN}`);

          // Assert
          expect(line.startsWith(`${ZERO_SHA256} ${ID_A_SHA256} `)).toBe(true);
        });
      });
    });

    describe('Given an existing branch', () => {
      describe('When updateRef moves it', () => {
        it('Then the reflog entry records the prior id as oldId', async () => {
          // Arrange
          const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });

          // Act
          await updateRef(ctx, MAIN, ID_B, { reflogMessage: REASON });
          const result = await readReflog(ctx, MAIN);

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.oldId).toBe(ID_A);
          expect(result[0]?.newId).toBe(ID_B);
        });
      });
    });

    describe('Given an existing branch updated to the same id (no move)', () => {
      describe('When updateRef is called', () => {
        it('Then no branch reflog entry is appended', async () => {
          // Arrange
          const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
          // Act
          await updateRef(ctx, MAIN, ID_A, { reflogMessage: 'reset: moving to a' });
          // Assert
          const result = await readReflog(ctx, MAIN);
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given HEAD targets a branch updated to the same id (no move)', () => {
      describe('When updateRef is called', () => {
        it('Then HEAD still records the move (symref log is unconditional)', async () => {
          // Arrange
          const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
          await writeSymbolicRef(ctx, HEAD, MAIN);
          // Act
          await updateRef(ctx, MAIN, ID_A, { reflogMessage: 'reset: moving to a' });
          // Assert
          const result = await readReflog(ctx, HEAD);
          expect(result).toHaveLength(1);
          expect(result[0]?.oldId).toBe(ID_A);
          expect(result[0]?.newId).toBe(ID_A);
          expect(result[0]?.message).toBe('reset: moving to a');
        });
      });
    });

    describe('Given HEAD symbolically points at the updated branch', () => {
      describe('When updateRef is called', () => {
        it('Then a second entry is appended to HEAD', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await writeSymbolicRef(ctx, HEAD, MAIN);

          // Act
          await updateRef(ctx, MAIN, ID_A, { reflogMessage: REASON });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.newId).toBe(ID_A);
          expect(result[0]?.message).toBe(REASON);
        });
      });
    });

    describe('Given HEAD is symbolic but targets a different branch', () => {
      describe('When updateRef is called', () => {
        it('Then HEAD is not logged', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await writeSymbolicRef(ctx, HEAD, 'refs/heads/other' as RefName);

          // Act
          await updateRef(ctx, MAIN, ID_A, { reflogMessage: REASON });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given HEAD is detached (a direct id)', () => {
      describe('When updateRef updates a branch', () => {
        it('Then HEAD is not logged', async () => {
          // Arrange
          const ctx = await buildSeededContext({ refs: [{ name: HEAD, id: ID_B }] });

          // Act
          await updateRef(ctx, MAIN, ID_A, { reflogMessage: REASON });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given a branch with a reflog', () => {
      describe('When updateRef deletes it', () => {
        it('Then the reflog file is removed', async () => {
          // Arrange
          const ctx = await buildSeededContext();

          // Act
          await updateRef(ctx, 'refs/heads/tmp' as RefName, ID_A, { reflogMessage: REASON });
          await updateRef(ctx, 'refs/heads/tmp' as RefName, ID_A, { delete: true });
          const result = await readReflog(ctx, 'refs/heads/tmp' as RefName);

          // Assert
          expect(result).toEqual([]);
          expect(await ctx.fs.exists('/repo/.git/logs/refs/heads/tmp')).toBe(false);
        });
      });
    });
  });
});
