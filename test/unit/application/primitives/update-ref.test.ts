import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { emptyTreeOid } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';
import { withReftableStorage } from './reftable-fixtures.js';

const ZERO = '0'.repeat(40) as ObjectId;
const ZERO_SHA256 = '0'.repeat(64) as ObjectId;
const MAIN = 'refs/heads/main' as RefName;
const HEAD = 'HEAD' as RefName;
const REASON = 'commit: test';

const COMMIT_AUTHOR: AuthorIdentity = {
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp: 0,
  timezoneOffset: '+0000',
};

/**
 * Writes a real, hash-valid parentless commit and returns its id. Every
 * branch-typed ref update now verifies its target (existence, hash, and —
 * for a branch — its type), so a synthetic id (`'a'.repeat(40)`) no longer
 * stands in for a write target; `message` keeps two commits in the same
 * test distinct.
 */
async function writeCommit(ctx: Context, message: string): Promise<ObjectId> {
  return writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: emptyTreeOid(ctx.hashConfig),
      parents: [],
      author: COMMIT_AUTHOR,
      committer: COMMIT_AUTHOR,
      message,
      extraHeaders: [],
    },
  });
}

/** Seeds a loose ref file directly (bypassing `updateRef`, so the value is
 *  never verified) — the same shape `buildSeededContext`'s own `refs` seeding
 *  writes, for a ref this test needs to exist before writeCommit's caller
 *  can compute its id. */
async function seedRef(ctx: Context, name: RefName, id: ObjectId): Promise<void> {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `${id}\n`);
}

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
        const commit = await writeCommit(ctx, 'fresh ref target');

        // Act
        await updateRef(ctx, 'refs/heads/new' as RefName, commit, { reflogMessage: REASON });
        const result = await resolveRef(ctx, 'refs/heads/new' as RefName);

        // Assert
        expect(result).toBe(commit);
      });
    });
  });

  describe('Given a pre-existing .lock file', () => {
    describe('When updateRef is called', () => {
      it('Then throws REF_LOCKED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commit = await writeCommit(ctx, 'busy target');
        await ctx.fs.write('/repo/.git/refs/heads/busy.lock', new Uint8Array([0]));

        // Act + Assert
        try {
          await updateRef(ctx, 'refs/heads/busy' as RefName, commit, { reflogMessage: REASON });
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
        const ctx = await buildSeededContext();
        const commitA = await writeCommit(ctx, 'cas hit a');
        await seedRef(ctx, MAIN, commitA);
        const commitB = await writeCommit(ctx, 'cas hit b');

        // Act
        await updateRef(ctx, MAIN, commitB, { expected: commitA, reflogMessage: REASON });
        const result = await resolveRef(ctx, MAIN);

        // Assert
        expect(result).toBe(commitB);
      });
    });
  });

  describe('Given CAS miss (expected differs from current)', () => {
    describe('When updateRef is called', () => {
      it('Then throws REF_UPDATE_CONFLICT with data.expected and data.actual populated', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commitA = await writeCommit(ctx, 'cas miss a');
        await seedRef(ctx, MAIN, commitA);
        const commitB = await writeCommit(ctx, 'cas miss b');

        // Act + Assert
        try {
          await updateRef(ctx, MAIN, commitB, { expected: commitB, reflogMessage: REASON });
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('REF_UPDATE_CONFLICT');
          if (data.code === 'REF_UPDATE_CONFLICT') {
            expect(data.expected).toBe(commitB);
            expect(data.actual).toBe(commitA);
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
        const commit = await writeCommit(ctx, 'cas absent target');

        // Act
        await updateRef(ctx, 'refs/heads/fresh' as RefName, commit, {
          expected: 'absent',
          reflogMessage: REASON,
        });
        const result = await resolveRef(ctx, 'refs/heads/fresh' as RefName);

        // Assert
        expect(result).toBe(commit);
      });
    });
  });

  describe('Given CAS expected="absent" on an existing ref', () => {
    describe('When updateRef is called', () => {
      it('Then throws REF_UPDATE_CONFLICT', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commitA = await writeCommit(ctx, 'cas absent existing a');
        await seedRef(ctx, MAIN, commitA);
        const commitB = await writeCommit(ctx, 'cas absent existing b');

        // Act + Assert
        try {
          await updateRef(ctx, MAIN, commitB, { expected: 'absent', reflogMessage: REASON });
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('REF_UPDATE_CONFLICT');
        }
      });
    });
  });

  describe('Given a noDeref name that is itself a dangling symref', () => {
    describe('When updateRef is called with expected="absent"', () => {
      it('Then throws REF_UPDATE_CONFLICT naming both sides "absent" — the symref itself exists', async () => {
        // Arrange — `sym` exists and is symbolic, but its target does not:
        // `expected: 'absent'` must not treat that as a match, since the
        // name being updated (under noDeref) is not itself absent.
        const ctx = await buildSeededContext();
        const sym = 'refs/heads/sym' as RefName;
        const ghost = 'refs/heads/ghost' as RefName;
        await writeSymbolicRef(ctx, sym, ghost);
        const commit = await writeCommit(ctx, 'dangling symref target');

        // Act + Assert
        try {
          await updateRef(ctx, sym, commit, {
            expected: 'absent',
            noDeref: true,
            reflogMessage: REASON,
          });
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('REF_UPDATE_CONFLICT');
          if (data.code === 'REF_UPDATE_CONFLICT') {
            expect(data.expected).toBe('absent');
            expect(data.actual).toBe('absent');
          }
        }
      });
    });
  });

  describe('Given an invalid ref name', () => {
    describe('When updateRef is called', () => {
      it('Then throws INVALID_REF', async () => {
        // Arrange — name validation refuses before the target is ever
        // looked up, so the id need not resolve to anything.
        const ctx = await buildSeededContext();
        const unverified = 'a'.repeat(40) as ObjectId;

        // Act + Assert
        try {
          await updateRef(ctx, '..' as RefName, unverified, { reflogMessage: REASON });
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
        const ctx = await buildSeededContext();
        const commitA = await writeCommit(ctx, 'malformed head a');
        await seedRef(ctx, MAIN, commitA);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/.invalid\n');
        const commitB = await writeCommit(ctx, 'malformed head b');

        // Act
        await updateRef(ctx, MAIN, commitB, { reflogMessage: REASON });

        // Assert
        expect(await resolveRef(ctx, MAIN)).toBe(commitB);
        const reflog = await readReflog(ctx, MAIN);
        expect(reflog).toHaveLength(1);
        expect(reflog[0]?.oldId).toBe(commitA);
        expect(reflog[0]?.newId).toBe(commitB);
      });

      it('Then the coupled HEAD reflog entry is not written', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commitA = await writeCommit(ctx, 'malformed head no-couple a');
        await seedRef(ctx, MAIN, commitA);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/.invalid\n');
        const commitB = await writeCommit(ctx, 'malformed head no-couple b');

        // Act
        await updateRef(ctx, MAIN, commitB, { reflogMessage: REASON });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/HEAD`)).toBe(false);
      });
    });

    describe('When updateRef deletes a ref', () => {
      it('Then it succeeds and the ref is gone', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commitA = await writeCommit(ctx, 'malformed head delete');
        await seedRef(ctx, MAIN, commitA);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/.invalid\n');

        // Act
        await updateRef(ctx, MAIN, commitA, { delete: true });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/${MAIN}`)).toBe(false);
      });
    });
  });

  describe('Given HEAD cannot be read due to a non-INVALID_REF I/O error', () => {
    describe('When updateRef writes a branch', () => {
      it('Then it throws and leaves refs and logs byte-unchanged', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commitA = await writeCommit(ctx, 'io error a');
        await seedRef(ctx, MAIN, commitA);
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
        const commitB = await writeCommit(ctx, 'io error b');
        const refsBefore = await snapshotDir(ctx, `${ctx.layout.gitDir}/refs`);
        const logsBefore = await snapshotDir(ctx, `${ctx.layout.gitDir}/logs`);

        // Act
        let thrown: unknown;
        try {
          await updateRef(failingCtx, MAIN, commitB, { reflogMessage: REASON });
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
        // Arrange — a delete is never verified, so the seeded value need not
        // resolve to a real object.
        const unverified = 'a'.repeat(40) as ObjectId;
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/tmp' as RefName, id: unverified }],
        });

        // Act
        await updateRef(ctx, 'refs/heads/tmp' as RefName, unverified, { delete: true });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/tmp')).toBe(false);
      });
    });
  });

  describe('Given delete=true on a packed-only ref', () => {
    describe('When updateRef is called', () => {
      it('Then the packed-refs line is removed and the ref resolves as missing', async () => {
        // Arrange — a delete is never verified, so the seeded value need not
        // resolve to a real object.
        const unverified = 'a'.repeat(40) as ObjectId;
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/old' as RefName, id: unverified }],
        });

        // Act
        await updateRef(ctx, 'refs/tags/old' as RefName, unverified, { delete: true });

        // Assert
        const packedContent = await ctx.fs.readUtf8('/repo/.git/packed-refs');
        expect(packedContent).not.toContain('refs/tags/old');
      });
    });
  });

  describe('Given delete=true on a ref that exists in neither loose nor packed storage', () => {
    describe('When updateRef is called', () => {
      it('Then it resolves and nothing is created', async () => {
        // Arrange — a delete is never verified.
        const ctx = await buildSeededContext();
        const unverified = 'a'.repeat(40) as ObjectId;

        // Act
        await updateRef(ctx, 'refs/heads/never-existed' as RefName, unverified, {
          delete: true,
        });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/never-existed')).toBe(false);
      });
    });

    describe('When updateRef is called with expected: "absent"', () => {
      it('Then it resolves the same way', async () => {
        // Arrange — a delete is never verified.
        const ctx = await buildSeededContext();
        const unverified = 'a'.repeat(40) as ObjectId;

        // Act
        await updateRef(ctx, 'refs/heads/never-existed' as RefName, unverified, {
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
        const commit = await writeCommit(ctx, 'null id target');
        await updateRef(ctx, 'refs/heads/tmp' as RefName, commit, { reflogMessage: REASON });
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
        // Arrange — the write target is the null id, so it is never
        // verified; the seeded/expected value need not be a real object.
        const unverified = 'a'.repeat(40) as ObjectId;
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: unverified }] });

        // Act
        await updateRef(ctx, MAIN, ZERO, { expected: unverified, reflogMessage: REASON });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/main')).toBe(false);
      });
    });

    describe('When updateRef is called with a mismatching expected id', () => {
      it('Then it throws REF_UPDATE_CONFLICT and leaves the ref in place', async () => {
        // Arrange — the write target is the null id, so it is never
        // verified; the seeded/expected values need not be real objects.
        const unverifiedA = 'a'.repeat(40) as ObjectId;
        const unverifiedB = 'b'.repeat(40) as ObjectId;
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: unverifiedA }] });

        // Act + Assert
        try {
          await updateRef(ctx, MAIN, ZERO, { expected: unverifiedB, reflogMessage: REASON });
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('REF_UPDATE_CONFLICT');
          if (data.code === 'REF_UPDATE_CONFLICT') {
            expect(data.expected).toBe(unverifiedB);
            expect(data.actual).toBe(unverifiedA);
          }
        }
        expect(await resolveRef(ctx, MAIN)).toBe(unverifiedA);
      });
    });

    describe('When updateRef is called with an expected id on an absent ref', () => {
      it('Then it throws REF_UPDATE_CONFLICT with actual "absent"', async () => {
        // Arrange — the write target is the null id, so it is never verified.
        const ctx = await buildSeededContext();
        const unverified = 'a'.repeat(40) as ObjectId;

        // Act + Assert
        try {
          await updateRef(ctx, 'refs/heads/gone' as RefName, ZERO, {
            expected: unverified,
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
        // Arrange — the write target is the null id, so it is never
        // verified; the seeded value need not be a real object.
        const unverified = 'a'.repeat(40) as ObjectId;
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: unverified }] });

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
        const commit = await writeCommit(ctx, 'sha256 null id target');
        await updateRef(ctx, MAIN, commit, { reflogMessage: REASON });

        // Act
        await updateRef(ctx, MAIN, ZERO_SHA256, { reflogMessage: REASON });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/main')).toBe(false);
      });
    });

    describe('When updateRef is called against a SHA-256 repository with a 40-zero id', () => {
      it('Then it is not treated as the null id and is verified on the write path', async () => {
        // Arrange — a 40-hex-zero id is not the SHA-256 null id (64 zeros),
        // so this must take the verified write path rather than the
        // unverified delete one: it is looked up as a real object, which no
        // genuine writer produces at that id, so verification refuses it. A
        // wrongly-treated-as-null mutant would skip verification and delete
        // the (nonexistent) ref as a no-op instead of throwing.
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        const fortyZeroes = '0'.repeat(40) as ObjectId;

        // Act + Assert
        try {
          await updateRef(ctx, MAIN, fortyZeroes, { reflogMessage: REASON });
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_NOT_FOUND');
          if (data.code === 'OBJECT_NOT_FOUND') {
            expect(data.id).toBe(fortyZeroes);
          }
        }
        expect(await ctx.fs.exists('/repo/.git/refs/heads/main')).toBe(false);
      });
    });

    describe('When updateRef is called on a packed-only ref with the null id', () => {
      it('Then the packed-refs line is removed', async () => {
        // Arrange — the write target is the null id, so it is never
        // verified; the seeded value need not be a real object.
        const unverified = 'a'.repeat(40) as ObjectId;
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/old' as RefName, id: unverified }],
        });

        // Act
        await updateRef(ctx, 'refs/tags/old' as RefName, ZERO, { reflogMessage: REASON });

        // Assert
        const packedContent = await ctx.fs.readUtf8('/repo/.git/packed-refs');
        expect(packedContent).not.toContain('refs/tags/old');
      });
    });

    describe('When updateRef is called against a symbolic ref by its own name', () => {
      it('Then it dereferences: the target is deleted and the symbolic ref itself is kept', async () => {
        // Arrange — the write target is the null id, so it is never
        // verified; the seeded value need not be a real object.
        const unverified = 'a'.repeat(40) as ObjectId;
        const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: unverified }] });
        const sym = 'refs/heads/sym' as RefName;
        await writeSymbolicRef(ctx, sym, MAIN);

        // Act
        await updateRef(ctx, sym, ZERO, { reflogMessage: REASON });

        // Assert
        expect(await ctx.fs.exists('/repo/.git/refs/heads/main')).toBe(false);
        expect(await ctx.fs.readUtf8('/repo/.git/refs/heads/sym')).toBe('ref: refs/heads/main\n');
      });
    });
  });

  describe('Given a live target reached through one symbolic hop', () => {
    describe('When updateRef writes a new value through the symbolic ref', () => {
      it('Then the terminal moves, the symref stays put, and both get a reflog entry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commitA = await writeCommit(ctx, 'symbolic hop a');
        await seedRef(ctx, MAIN, commitA);
        const sym = 'refs/heads/sym' as RefName;
        await writeSymbolicRef(ctx, sym, MAIN);
        const commitB = await writeCommit(ctx, 'symbolic hop b');

        // Act
        await updateRef(ctx, sym, commitB, { reflogMessage: 'move' });

        // Assert — the terminal's value moved; the symref's own file is
        // untouched (still a symref onto `main`); both names logged the move.
        expect(await resolveRef(ctx, MAIN)).toBe(commitB);
        expect(await ctx.fs.readUtf8('/repo/.git/refs/heads/sym')).toBe('ref: refs/heads/main\n');
        const mainLog = await readReflog(ctx, MAIN);
        const symLog = await readReflog(ctx, sym);
        expect(mainLog).toHaveLength(1);
        expect(mainLog[0]?.oldId).toBe(commitA);
        expect(mainLog[0]?.newId).toBe(commitB);
        expect(mainLog[0]?.message).toBe('move');
        expect(symLog).toHaveLength(1);
        expect(symLog[0]?.oldId).toBe(commitA);
        expect(symLog[0]?.newId).toBe(commitB);
        expect(symLog[0]?.message).toBe('move');
      });
    });
  });

  describe('reflog logging', () => {
    describe('Given a fresh branch write', () => {
      describe('When updateRef is called', () => {
        it('Then a reflog entry records ZERO_OID → newId with the message', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const commit = await writeCommit(ctx, 'fresh branch write');

          // Act
          await updateRef(ctx, MAIN, commit, { reflogMessage: 'commit (initial): seed' });
          const result = await readReflog(ctx, MAIN);

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.oldId).toBe(ZERO);
          expect(result[0]?.newId).toBe(commit);
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
          const commit = await writeCommit(ctx, 'sha256 fresh branch write');

          // Act
          await updateRef(ctx, MAIN, commit, { reflogMessage: 'commit (initial): seed' });
          const line = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/${MAIN}`);

          // Assert
          expect(line.startsWith(`${ZERO_SHA256} ${commit} `)).toBe(true);
        });
      });
    });

    describe('Given an existing branch', () => {
      describe('When updateRef moves it', () => {
        it('Then the reflog entry records the prior id as oldId', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const commitA = await writeCommit(ctx, 'existing branch a');
          await seedRef(ctx, MAIN, commitA);
          const commitB = await writeCommit(ctx, 'existing branch b');

          // Act
          await updateRef(ctx, MAIN, commitB, { reflogMessage: REASON });
          const result = await readReflog(ctx, MAIN);

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.oldId).toBe(commitA);
          expect(result[0]?.newId).toBe(commitB);
        });
      });
    });

    describe('Given an existing branch updated to the same id (no move)', () => {
      describe('When updateRef is called', () => {
        it('Then no branch reflog entry is appended', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const commit = await writeCommit(ctx, 'no-move branch');
          await seedRef(ctx, MAIN, commit);
          // Act
          await updateRef(ctx, MAIN, commit, { reflogMessage: 'reset: moving to a' });
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
          const ctx = await buildSeededContext();
          const commit = await writeCommit(ctx, 'head no-move branch');
          await seedRef(ctx, MAIN, commit);
          await writeSymbolicRef(ctx, HEAD, MAIN);
          // Act
          await updateRef(ctx, MAIN, commit, { reflogMessage: 'reset: moving to a' });
          // Assert
          const result = await readReflog(ctx, HEAD);
          expect(result).toHaveLength(1);
          expect(result[0]?.oldId).toBe(commit);
          expect(result[0]?.newId).toBe(commit);
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
          const commit = await writeCommit(ctx, 'head symbolic branch');

          // Act
          await updateRef(ctx, MAIN, commit, { reflogMessage: REASON });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.newId).toBe(commit);
          expect(result[0]?.message).toBe(REASON);
        });

        it('Then the branch and the coupled HEAD reflog land in one applyRefUpdates call', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await writeSymbolicRef(ctx, HEAD, MAIN);
          const commit = await writeCommit(ctx, 'head symbolic branch one-call');
          const store = getRefStore(ctx);
          const calls: unknown[][] = [];
          const originalApply = store.applyRefUpdates.bind(store);
          store.applyRefUpdates = async (updates) => {
            calls.push([...updates]);
            return originalApply(updates);
          };

          // Act
          await updateRef(ctx, MAIN, commit, { reflogMessage: REASON });

          // Assert
          expect(calls).toHaveLength(1);
          expect(calls[0]).toHaveLength(2);
        });
      });
    });

    describe('Given HEAD symbolically points at a LINK the write walks through, not the terminal', () => {
      describe('When updateRef writes through that link', () => {
        it('Then the files backend logs HEAD with the null id — the value is not known yet at that hop', async () => {
          // Arrange — HEAD -> s -> x: writing through `s` walks one hop to
          // reach the terminal `x`; HEAD names `s` itself, a walked LINK,
          // not the terminal.
          // `refs/heads/x`'s seeded value is read only through the chain walk
          // (never verified — verification checks only the write target), so
          // it stays a synthetic id; it proves the coupled HEAD entry logs
          // the null id even though the walked-through terminal has a real
          // prior value.
          const unverifiedX = 'a'.repeat(40) as ObjectId;
          const ctx = await buildSeededContext({
            refs: [{ name: 'refs/heads/x' as RefName, id: unverifiedX }],
          });
          const s = 'refs/heads/s' as RefName;
          await writeSymbolicRef(ctx, s, 'refs/heads/x' as RefName);
          await writeSymbolicRef(ctx, HEAD, s);
          const commit = await writeCommit(ctx, 'link write target');

          // Act
          await updateRef(ctx, s, commit, { reflogMessage: 'via link' });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.oldId).toBe(ZERO);
          expect(result[0]?.newId).toBe(commit);
        });
      });
    });

    describe('Given HEAD is symbolic but targets a different branch', () => {
      describe('When updateRef is called', () => {
        it('Then HEAD is not logged', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await writeSymbolicRef(ctx, HEAD, 'refs/heads/other' as RefName);
          const commit = await writeCommit(ctx, 'head other branch');

          // Act
          await updateRef(ctx, MAIN, commit, { reflogMessage: REASON });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given HEAD is detached (a direct id)', () => {
      describe('When updateRef updates a branch', () => {
        it('Then HEAD is not logged', async () => {
          // Arrange — HEAD's seeded value is a direct (detached) id, read
          // only for coupling, never verified.
          const unverifiedHead = 'b'.repeat(40) as ObjectId;
          const ctx = await buildSeededContext({ refs: [{ name: HEAD, id: unverifiedHead }] });
          const commit = await writeCommit(ctx, 'head detached branch');

          // Act
          await updateRef(ctx, MAIN, commit, { reflogMessage: REASON });
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
          const commit = await writeCommit(ctx, 'tmp branch with reflog');

          // Act
          await updateRef(ctx, 'refs/heads/tmp' as RefName, commit, { reflogMessage: REASON });
          await updateRef(ctx, 'refs/heads/tmp' as RefName, commit, { delete: true });
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
          // Arrange — a delete's write target is the null id, so the seeded
          // current value is never verified.
          const unverified = 'a'.repeat(40) as ObjectId;
          const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: unverified }] });
          await writeSymbolicRef(ctx, HEAD, MAIN);

          // Act
          await updateRef(ctx, MAIN, ZERO, { delete: true, reflogMessage: 'why' });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.oldId).toBe(unverified);
          expect(result[0]?.newId).toBe(ZERO);
          expect(result[0]?.message).toBe('why');
        });
      });

      describe('When updateRef deletes it with delete: true and no reflogMessage', () => {
        it('Then the entry message is empty and the raw line carries no tab', async () => {
          // Arrange — a delete's write target is the null id, so the seeded
          // current value is never verified.
          const unverified = 'a'.repeat(40) as ObjectId;
          const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: unverified }] });
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
          // Arrange — the write target is the null id, so the seeded current
          // value is never verified.
          const unverified = 'a'.repeat(40) as ObjectId;
          const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: unverified }] });
          await writeSymbolicRef(ctx, HEAD, MAIN);

          // Act
          await updateRef(ctx, MAIN, ZERO, { reflogMessage: 'via null id' });
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.oldId).toBe(unverified);
          expect(result[0]?.newId).toBe(ZERO);
          expect(result[0]?.message).toBe('via null id');
        });
      });
    });

    describe('Given HEAD does not name the branch being deleted', () => {
      describe('When updateRef deletes it', () => {
        it('Then no HEAD entry is written', async () => {
          // Arrange — a delete's write target is the null id, so the seeded
          // current values are never verified.
          const unverifiedMain = 'a'.repeat(40) as ObjectId;
          const unverifiedOther = 'b'.repeat(40) as ObjectId;
          const ctx = await buildSeededContext({
            refs: [
              { name: MAIN, id: unverifiedMain },
              { name: 'refs/heads/other' as RefName, id: unverifiedOther },
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
          // Arrange — a delete's write target is the null id, so the seeded
          // current value is never verified.
          const unverified = 'a'.repeat(40) as ObjectId;
          const ctx = await buildSeededContext({ refs: [{ name: MAIN, id: unverified }] });
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

    describe('Given a reftable-backend Context and a symbolic ref pointing at a live target', () => {
      describe('When that symbolic ref is deleted with noDeref', () => {
        it('Then its own kept log gains an entry recording the deletion', async () => {
          // Arrange — seeded directly through the store (bypassing
          // `updateRef`), so this value is never verified.
          const unverified = 'a'.repeat(40) as ObjectId;
          const ctx = withReftableStorage(createMemoryContext());
          const sym = 'refs/heads/sym' as RefName;
          const store = getRefStore(ctx);
          await store.applyRefUpdates([
            { kind: 'set', name: MAIN, id: unverified },
            { kind: 'setSymbolic', name: sym, target: MAIN },
          ]);

          // Act
          await updateRef(ctx, sym, ZERO, { delete: true, noDeref: true, reflogMessage: 'bye' });
          const symLog = await readReflog(ctx, sym);

          // Assert — the symref itself is gone, its target untouched, and its
          // own log (kept, not tombstoned, on the reftable backend) gained
          // one entry recording the deletion.
          expect(await store.resolveDirect(sym)).toEqual({ kind: 'missing' });
          expect(await resolveRef(ctx, MAIN)).toBe(unverified);
          expect(symLog).toHaveLength(1);
          expect(symLog[0]).toEqual(
            expect.objectContaining({ oldId: unverified, newId: ZERO, message: 'bye' }),
          );
        });
      });
    });
  });
});
