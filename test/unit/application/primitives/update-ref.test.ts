import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';
import { withReftableStorage } from './reftable-fixtures.js';

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

  describe('Given HEAD content is malformed', () => {
    describe('When updateRef writes a branch', () => {
      it('Then it succeeds and writes the branch ref and its reflog', async () => {
        // Arrange
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/.invalid\n');

        // Act
        await updateRef(ctx, MAIN, ID_B, { reflogMessage: REASON });

        // Assert
        expect(await resolveRef(ctx, MAIN)).toBe(ID_B);
        const reflog = await readReflog(ctx, MAIN);
        expect(reflog).toHaveLength(1);
        expect(reflog[0]?.oldId).toBe(ID_A);
        expect(reflog[0]?.newId).toBe(ID_B);
      });

      it('Then the coupled HEAD reflog entry is not written', async () => {
        // Arrange
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/.invalid\n');

        // Act
        await updateRef(ctx, MAIN, ID_B, { reflogMessage: REASON });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/HEAD`)).toBe(false);
      });
    });

    describe('When updateRef deletes a ref', () => {
      it('Then it succeeds and the ref is gone', async () => {
        // Arrange
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/.invalid\n');

        // Act
        await updateRef(ctx, MAIN, ID_A, { delete: true });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/${MAIN}`)).toBe(false);
      });
    });
  });

  describe('Given HEAD cannot be read due to a non-INVALID_REF I/O error', () => {
    describe('When updateRef writes a branch', () => {
      it('Then it throws and leaves refs and logs byte-unchanged', async () => {
        // Arrange
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
        const headPath = `${ctx.layout.gitDir}/HEAD`;
        await ctx.fs.writeUtf8(headPath, 'ref: refs/heads/main\n');
        const ioError = new Error('EIO: simulated read failure');
        const failingCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readUtf8: async (path: string): Promise<string> => {
              if (path === headPath) throw ioError;
              return ctx.fs.readUtf8(path);
            },
          },
        };
        const refsBefore = await snapshotDir(ctx, `${ctx.layout.gitDir}/refs`);
        const logsBefore = await snapshotDir(ctx, `${ctx.layout.gitDir}/logs`);

        // Act
        let thrown: unknown;
        try {
          await updateRef(failingCtx, MAIN, ID_B, { reflogMessage: REASON });
          expect.unreachable();
        } catch (error) {
          thrown = error;
        }

        // Assert
        expect(thrown).toBe(ioError);
        expect(await snapshotDir(ctx, `${ctx.layout.gitDir}/refs`)).toEqual(refsBefore);
        expect(await snapshotDir(ctx, `${ctx.layout.gitDir}/logs`)).toEqual(logsBefore);
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
      it('Then the packed-refs line is removed and the ref resolves as missing', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/old' as RefName, id: ID_A }],
        });

        // Act
        await updateRef(ctx, 'refs/tags/old' as RefName, ID_A, { delete: true });

        // Assert
        const packedContent = await ctx.fs.readUtf8('/repo/.git/packed-refs');
        expect(packedContent).not.toContain('refs/tags/old');
      });
    });
  });

  describe('Given delete=true on a ref that exists in neither loose nor packed storage', () => {
    describe('When updateRef is called', () => {
      it('Then it resolves and nothing is created', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        await updateRef(ctx, 'refs/heads/never-existed' as RefName, ID_A, { delete: true });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/never-existed')).toBe(false);
      });
    });

    describe('When updateRef is called with expected: "absent"', () => {
      it('Then it resolves the same way', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        await updateRef(ctx, 'refs/heads/never-existed' as RefName, ID_A, {
          delete: true,
          expected: 'absent',
        });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/never-existed')).toBe(false);
      });
    });
  });

  describe('Given a null object id as the new value', () => {
    describe('When updateRef is called on an existing loose ref with a reflog', () => {
      it('Then the ref file and its reflog file are both gone', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await updateRef(ctx, 'refs/heads/tmp' as RefName, ID_A, { reflogMessage: REASON });
        expect(await ctx.fs.exists('/repo/.git/logs/refs/heads/tmp')).toBe(true);

        // Act
        await updateRef(ctx, 'refs/heads/tmp' as RefName, ZERO, { reflogMessage: REASON });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/tmp')).toBe(false);
        expect(await ctx.fs.exists('/repo/.git/logs/refs/heads/tmp')).toBe(false);
      });
    });

    describe('When updateRef is called on an absent ref', () => {
      it('Then nothing is created and it does not throw', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        await updateRef(ctx, 'refs/heads/never-existed' as RefName, ZERO, {
          reflogMessage: REASON,
        });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/never-existed')).toBe(false);
      });
    });

    describe('When updateRef is called with a matching expected id', () => {
      it('Then the ref is deleted', async () => {
        // Arrange
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });

        // Act
        await updateRef(ctx, MAIN, ZERO, { expected: ID_A, reflogMessage: REASON });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/main')).toBe(false);
      });
    });

    describe('When updateRef is called with a mismatching expected id', () => {
      it('Then it throws REF_UPDATE_CONFLICT and leaves the ref in place', async () => {
        // Arrange
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });

        // Act + Assert
        try {
          await updateRef(ctx, MAIN, ZERO, { expected: ID_B, reflogMessage: REASON });
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('REF_UPDATE_CONFLICT');
          if (data.code === 'REF_UPDATE_CONFLICT') {
            expect(data.expected).toBe(ID_B);
            expect(data.actual).toBe(ID_A);
          }
        }
        expect(await resolveRef(ctx, MAIN)).toBe(ID_A);
      });
    });

    describe('When updateRef is called with an expected id on an absent ref', () => {
      it('Then it throws REF_UPDATE_CONFLICT with actual "absent"', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act + Assert
        try {
          await updateRef(ctx, 'refs/heads/gone' as RefName, ZERO, {
            expected: ID_A,
            reflogMessage: REASON,
          });
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('REF_UPDATE_CONFLICT');
          if (data.code === 'REF_UPDATE_CONFLICT') {
            expect(data.actual).toBe('absent');
          }
        }
      });
    });

    describe('When updateRef is called with expected: "absent" on an existing ref', () => {
      it('Then it throws REF_UPDATE_CONFLICT', async () => {
        // Arrange
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });

        // Act + Assert
        try {
          await updateRef(ctx, MAIN, ZERO, { expected: 'absent', reflogMessage: REASON });
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('REF_UPDATE_CONFLICT');
        }
      });
    });

    describe('When updateRef is called against a SHA-256 repository with a 64-zero id', () => {
      it('Then the ref is deleted', async () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        await updateRef(ctx, MAIN, ID_A_SHA256, { reflogMessage: REASON });

        // Act
        await updateRef(ctx, MAIN, ZERO_SHA256, { reflogMessage: REASON });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/main')).toBe(false);
      });
    });

    describe('When updateRef is called against a SHA-256 repository with a 40-zero id', () => {
      it('Then it is not treated as the null id and builds a "set" update, never a "delete"', async () => {
        // Arrange — a 40-hex-zero id is not the SHA-256 null id (64 zeros),
        // so this must take the write path. Captures the update list rather
        // than letting it commit: a genuinely 40-char id on a 64-char
        // repository is not a value any real writer would carry through to
        // the reflog serializer, which has its own, unrelated width guard.
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        const fortyZeroes = '0'.repeat(40) as ObjectId;
        const store = getRefStore(ctx);
        const calls: unknown[][] = [];
        store.applyRefUpdates = async (updates) => {
          calls.push([...updates]);
        };

        // Act
        await updateRef(ctx, MAIN, fortyZeroes, { reflogMessage: REASON });

        // Assert
        expect(calls).toHaveLength(1);
        const kind = (calls[0]?.[0] as { kind: string } | undefined)?.kind;
        expect(kind).toBe('set');
      });
    });

    describe('When updateRef is called on a packed-only ref with the null id', () => {
      it('Then the packed-refs line is removed', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/old' as RefName, id: ID_A }],
        });

        // Act
        await updateRef(ctx, 'refs/tags/old' as RefName, ZERO, { reflogMessage: REASON });

        // Assert
        const packedContent = await ctx.fs.readUtf8('/repo/.git/packed-refs');
        expect(packedContent).not.toContain('refs/tags/old');
      });
    });

    describe('When updateRef is called against a symbolic ref by its own name', () => {
      it('Then the symbolic ref file itself is removed (dereferencing lands in a later change)', async () => {
        // Arrange
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
        const sym = 'refs/heads/sym' as RefName;
        await writeSymbolicRef(ctx, sym, MAIN);

        // Act
        await updateRef(ctx, sym, ZERO, { reflogMessage: REASON });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/sym')).toBe(false);
        expect(await resolveRef(ctx, MAIN)).toBe(ID_A);
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

        it('Then the branch and the coupled HEAD reflog land in one applyRefUpdates call', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await writeSymbolicRef(ctx, HEAD, MAIN);
          const store = getRefStore(ctx);
          const calls: unknown[][] = [];
          const originalApply = store.applyRefUpdates.bind(store);
          store.applyRefUpdates = async (updates) => {
            calls.push([...updates]);
            return originalApply(updates);
          };

          // Act
          await updateRef(ctx, MAIN, ID_A, { reflogMessage: REASON });

          // Assert
          expect(calls).toHaveLength(1);
          expect(calls[0]).toHaveLength(2);
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

  describe('coupled HEAD entry on delete', () => {
    describe('Given HEAD symbolically points at the branch being deleted', () => {
      describe('When updateRef deletes it with delete: true and a reflogMessage', () => {
        it('Then logs/HEAD gains exactly one oldId -> ZERO entry with the message', async () => {
          // Arrange
          const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
          await writeSymbolicRef(ctx, HEAD, MAIN);

          // Act
          await updateRef(ctx, MAIN, ZERO, { delete: true, reflogMessage: 'why' });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.oldId).toBe(ID_A);
          expect(result[0]?.newId).toBe(ZERO);
          expect(result[0]?.message).toBe('why');
        });
      });

      describe('When updateRef deletes it with delete: true and no reflogMessage', () => {
        it('Then the entry message is empty and the raw line carries no tab', async () => {
          // Arrange
          const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
          await writeSymbolicRef(ctx, HEAD, MAIN);

          // Act
          await updateRef(ctx, MAIN, ZERO, { delete: true });
          const result = await readReflog(ctx, HEAD);
          const raw = await ctx.fs.readUtf8('/repo/.git/logs/HEAD');

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.message).toBe('');
          expect(raw.includes('\t')).toBe(false);
        });
      });

      describe('When updateRef deletes it through the null object id', () => {
        it('Then the same coupled HEAD entry is written', async () => {
          // Arrange
          const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
          await writeSymbolicRef(ctx, HEAD, MAIN);

          // Act
          await updateRef(ctx, MAIN, ZERO, { reflogMessage: 'via null id' });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.oldId).toBe(ID_A);
          expect(result[0]?.newId).toBe(ZERO);
          expect(result[0]?.message).toBe('via null id');
        });
      });
    });

    describe('Given HEAD does not name the branch being deleted', () => {
      describe('When updateRef deletes it', () => {
        it('Then no HEAD entry is written', async () => {
          // Arrange
          const ctx = await buildSeededContext({
            refs: [
              { name: MAIN, id: ID_A },
              { name: 'refs/heads/other' as RefName, id: ID_B },
            ],
          });
          await writeSymbolicRef(ctx, HEAD, 'refs/heads/other' as RefName);

          // Act
          await updateRef(ctx, MAIN, ZERO, { delete: true });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given a files-backend Context, HEAD points at an unborn branch', () => {
      describe('When that branch is deleted (absent target)', () => {
        it('Then logs/HEAD is created with a 0{40} 0{40} entry', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await writeSymbolicRef(ctx, HEAD, MAIN);
          expect(await ctx.fs.exists('/repo/.git/logs/HEAD')).toBe(false);

          // Act
          await updateRef(ctx, MAIN, ZERO, { delete: true, reflogMessage: 'gone' });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.oldId).toBe(ZERO);
          expect(result[0]?.newId).toBe(ZERO);
        });
      });
    });

    describe('Given a reftable-backend Context, HEAD points at an unborn branch', () => {
      describe('When that branch is deleted (absent target)', () => {
        it('Then no HEAD entry is written — the reftable backend skips no-op delete logs', async () => {
          // Arrange
          const ctx = withReftableStorage(createMemoryContext());
          const store = getRefStore(ctx);
          await store.applyRefUpdates([{ kind: 'setSymbolic', name: HEAD, target: MAIN }]);

          // Act
          await updateRef(ctx, MAIN, ZERO, { delete: true, reflogMessage: 'gone' });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given HEAD symbolically points at the branch being deleted', () => {
      describe('When updateRef deletes it', () => {
        it('Then the deletion and the coupled HEAD entry land in one applyRefUpdates call', async () => {
          // Arrange
          const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: ID_A }] });
          await writeSymbolicRef(ctx, HEAD, MAIN);
          const store = getRefStore(ctx);
          const calls: unknown[][] = [];
          const originalApply = store.applyRefUpdates.bind(store);
          store.applyRefUpdates = async (updates) => {
            calls.push([...updates]);
            return originalApply(updates);
          };

          // Act
          await updateRef(ctx, MAIN, ZERO, { delete: true, reflogMessage: 'why' });

          // Assert
          expect(calls).toHaveLength(1);
          expect(calls[0]).toHaveLength(2);
        });
      });
    });
  });
});
