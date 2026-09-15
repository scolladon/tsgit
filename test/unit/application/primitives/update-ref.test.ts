import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { invalidateShallowSet } from '../../../../src/application/primitives/internal/shallow-set.js';
import {
  commonGitDir,
  shallowFilePath,
} from '../../../../src/application/primitives/path-layout.js';
import {
  getRefStore,
  type RefUpdate,
  type ResolveDirectResult,
} from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type { UpdateRefOptions } from '../../../../src/application/primitives/types.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { emptyTreeOid } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext, instrumentedContext, writeRawObjectBytes } from './fixtures.js';
import { withReftableStorage } from './reftable-fixtures.js';

const ENC = new TextEncoder();

/** A long, deflate-resistant byte stream (never `Math.random` — a failure
 *  reproduces exactly) — pushes a loose object's COMPRESSED size past the
 *  buffered gate. NUL-free so it stays a valid trailing message. */
function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    let h = (seed * 1_000_003 + i) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    const byte = h & 0xff;
    bytes[i] = byte === 0x00 ? 0x01 : byte;
  }
  return bytes;
}

function concatUint8(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

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

  describe('Given HEAD is a symbolic link to a file that does not hold a ref', () => {
    describe('When updateRef writes the branch HEAD used to name', () => {
      it('Then the branch moves and logs, and no coupled HEAD entry is written', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commitA = await writeCommit(ctx, 'broken head link a');
        await seedRef(ctx, MAIN, commitA);
        await ctx.fs.writeUtf8('/repo/secret.txt', 'PRIVATE-LINE\n');
        await ctx.fs.symlink('refs/../../secret.txt', `${ctx.layout.gitDir}/HEAD`);
        const commitB = await writeCommit(ctx, 'broken head link b');
        const sut = updateRef;

        // Act
        await sut(ctx, MAIN, commitB, { reflogMessage: REASON });

        // Assert
        expect(await resolveRef(ctx, MAIN)).toBe(commitB);
        expect((await readReflog(ctx, MAIN)).map((entry) => [entry.oldId, entry.newId])).toEqual([
          [commitA, commitB],
        ]);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/HEAD`)).toBe(false);
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

    describe('Given refs/heads/s symbolically names HEAD, which names the branch', () => {
      describe('When updateRef writes through s', () => {
        it.each([
          { label: 'files', build: (): Context => createMemoryContext() },
          { label: 'reftable', build: (): Context => withReftableStorage(createMemoryContext()) },
        ])(
          'Then the $label backend appends exactly one logs/HEAD entry — HEAD is a walked link, never coupled again',
          async ({ build }) => {
            // Arrange
            const ctx = build();
            const store = getRefStore(ctx);
            const commitA = await writeCommit(ctx, 'via head link a');
            const commitB = await writeCommit(ctx, 'via head link b');
            const s = 'refs/heads/s' as RefName;
            await store.applyRefUpdates([
              { kind: 'set', name: MAIN, id: commitA },
              { kind: 'setSymbolic', name: HEAD, target: MAIN },
              { kind: 'setSymbolic', name: s, target: HEAD },
            ]);
            const sut = updateRef;

            // Act
            await sut(ctx, s, commitB, { reflogMessage: 'm' });

            // Assert
            const result = await readReflog(ctx, HEAD);
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(
              expect.objectContaining({ oldId: commitA, newId: commitB, message: 'm' }),
            );
          },
        );
      });
    });

    describe('Given HEAD symbolically names the branch', () => {
      describe('When updateRef writes HEAD itself', () => {
        it('Then HEAD is read once — by the chain walk, never again for coupling', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await writeSymbolicRef(ctx, HEAD, MAIN);
          const commit = await writeCommit(ctx, 'head read once');
          const store = getRefStore(ctx);
          const reads: RefName[] = [];
          const originalResolve = store.resolveDirect.bind(store);
          store.resolveDirect = async (name) => {
            reads.push(name);
            return originalResolve(name);
          };
          const sut = updateRef;

          // Act
          await sut(ctx, HEAD, commit, { reflogMessage: REASON });

          // Assert
          expect(reads).toEqual([HEAD, MAIN]);
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

  describe('symbolic refs in one ref transaction', () => {
    const FROZEN_SECONDS = 1_700_000_000;
    const IDENTITY = `tsgit <tsgit@localhost> ${FROZEN_SECONDS} +0000`;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(FROZEN_SECONDS * 1000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    type Backend = 'files' | 'reftable';
    type Slot = 'c1' | 'c2' | 'zero';
    type ExpectedRef =
      | { readonly kind: 'direct'; readonly id: Slot }
      | { readonly kind: 'symbolic'; readonly target: string }
      | { readonly kind: 'missing' };

    interface Seed {
      readonly direct?: Readonly<Record<string, Slot>>;
      readonly symbolic?: Readonly<Record<string, string>>;
      readonly logged?: ReadonlyArray<string>;
    }

    interface Fixture {
      readonly ctx: Context;
      readonly ids: Readonly<Record<Slot, ObjectId>>;
      readonly calls: ReadonlyArray<ReadonlyArray<RefUpdate>>;
    }

    const contextFor = (backend: Backend): Context =>
      backend === 'files' ? createMemoryContext() : withReftableStorage(createMemoryContext());

    /** Seeds refs through the store (no reflog), optionally one `seed` log
     *  line per `logged` name, then records every later applyRefUpdates call. */
    const symrefFixture = async (backend: Backend, seed: Seed): Promise<Fixture> => {
      const ctx = contextFor(backend);
      const ids = {
        c1: await writeCommit(ctx, 'symref c1'),
        c2: await writeCommit(ctx, 'symref c2'),
        zero: ZERO,
      };
      const store = getRefStore(ctx);
      await store.applyRefUpdates([
        ...Object.entries(seed.direct ?? {}).map(
          ([name, slot]): RefUpdate => ({
            kind: 'set',
            name: name as RefName,
            id: ids[slot],
          }),
        ),
        ...Object.entries(seed.symbolic ?? {}).map(
          ([name, target]): RefUpdate => ({
            kind: 'setSymbolic',
            name: name as RefName,
            target: target as RefName,
          }),
        ),
        ...(seed.logged ?? []).map(
          (name): RefUpdate => ({
            kind: 'reflogOnly',
            name: name as RefName,
            reflog: { oldId: ZERO, newId: ids.c1, message: 'seed' },
          }),
        ),
      ]);
      const calls: RefUpdate[][] = [];
      const original = store.applyRefUpdates.bind(store);
      store.applyRefUpdates = async (updates) => {
        calls.push([...updates]);
        return original(updates);
      };
      return { ctx, ids, calls };
    };

    const logLines = async (fixture: Fixture, name: string): Promise<readonly string[]> =>
      (await readReflog(fixture.ctx, name as RefName)).map(
        (entry) =>
          `${entry.oldId} ${entry.newId} ${entry.identity.name} <${entry.identity.email}> ${entry.identity.timestamp} ${entry.identity.timezoneOffset}\t${entry.message}`,
      );

    const expectedLine = (ids: Fixture['ids'], [from, to, message]: LogSpec): string =>
      `${ids[from]} ${ids[to]} ${IDENTITY}\t${message}`;

    const expectedValue = (ids: Fixture['ids'], ref: ExpectedRef): ResolveDirectResult =>
      ref.kind === 'direct' ? { kind: 'direct', id: ids[ref.id] } : (ref as ResolveDirectResult);

    type LogSpec = readonly [Slot, Slot, string];

    interface SuccessRow {
      readonly label: string;
      readonly backend: Backend;
      readonly seed: Seed;
      readonly name: string;
      readonly newId: Slot;
      readonly options: UpdateRefOptions;
      readonly refs: Readonly<Record<string, ExpectedRef>>;
      readonly logs: Readonly<Record<string, ReadonlyArray<LogSpec>>>;
    }

    const HEAD_S_X = { symbolic: { HEAD: 'refs/heads/s', 'refs/heads/s': 'refs/heads/x' } };

    describe('Given a seeded chain of symbolic refs', () => {
      describe('When updateRef applies one write or delete to it', () => {
        it.each<SuccessRow>([
          {
            label: 'a link logs an unchanged value while the terminal does not',
            backend: 'files',
            seed: {
              direct: { 'refs/heads/x': 'c2' },
              symbolic: { 'refs/heads/a1': 'refs/heads/a2', 'refs/heads/a2': 'refs/heads/x' },
            },
            name: 'refs/heads/a1',
            newId: 'c2',
            options: { reflogMessage: 'm' },
            refs: { 'refs/heads/x': { kind: 'direct', id: 'c2' } },
            logs: {
              'refs/heads/a1': [['c2', 'c2', 'm']],
              'refs/heads/a2': [['c2', 'c2', 'm']],
              'refs/heads/x': [],
            },
          },
          {
            label: 'a tag symref to a branch passes its own logging gate: no tag log',
            backend: 'files',
            seed: {
              direct: { 'refs/heads/x': 'c1' },
              symbolic: { 'refs/tags/ts': 'refs/heads/x' },
            },
            name: 'refs/tags/ts',
            newId: 'c2',
            options: { reflogMessage: 'm' },
            refs: { 'refs/heads/x': { kind: 'direct', id: 'c2' } },
            logs: { 'refs/heads/x': [['c1', 'c2', 'm']], 'refs/tags/ts': [] },
          },
          {
            label: 'expecting absent through a dangling symref creates its target',
            backend: 'files',
            seed: { symbolic: { 'refs/heads/s4': 'refs/heads/nope4' } },
            name: 'refs/heads/s4',
            newId: 'c2',
            options: { expected: 'absent', reflogMessage: 'm' },
            refs: {
              'refs/heads/s4': { kind: 'symbolic', target: 'refs/heads/nope4' },
              'refs/heads/nope4': { kind: 'direct', id: 'c2' },
            },
            logs: {
              'refs/heads/s4': [['zero', 'c2', 'm']],
              'refs/heads/nope4': [['zero', 'c2', 'm']],
            },
          },
          {
            label: 'writing HEAD moves its branch and keeps HEAD symbolic',
            backend: 'files',
            seed: { direct: { 'refs/heads/main': 'c1' }, symbolic: { HEAD: 'refs/heads/main' } },
            name: 'HEAD',
            newId: 'c2',
            options: { reflogMessage: 'm' },
            refs: {
              HEAD: { kind: 'symbolic', target: 'refs/heads/main' },
              'refs/heads/main': { kind: 'direct', id: 'c2' },
            },
            logs: { HEAD: [['c1', 'c2', 'm']], 'refs/heads/main': [['c1', 'c2', 'm']] },
          },
          {
            label: 'writing HEAD through two hops logs every name once',
            backend: 'files',
            seed: { direct: { 'refs/heads/x': 'c2' }, ...HEAD_S_X },
            name: 'HEAD',
            newId: 'c1',
            options: { reflogMessage: 'm' },
            refs: { 'refs/heads/x': { kind: 'direct', id: 'c1' } },
            logs: {
              HEAD: [['c2', 'c1', 'm']],
              'refs/heads/s': [['c2', 'c1', 'm']],
              'refs/heads/x': [['c2', 'c1', 'm']],
            },
          },
          {
            label: 'a noDeref write of HEAD detaches it and leaves the branch unlogged',
            backend: 'files',
            seed: { direct: { 'refs/heads/main': 'c2' }, symbolic: { HEAD: 'refs/heads/main' } },
            name: 'HEAD',
            newId: 'c1',
            options: { noDeref: true, reflogMessage: 'detach' },
            refs: {
              HEAD: { kind: 'direct', id: 'c1' },
              'refs/heads/main': { kind: 'direct', id: 'c2' },
            },
            logs: { HEAD: [['c2', 'c1', 'detach']], 'refs/heads/main': [] },
          },
          {
            label: 'reftable logs the resolved old value for HEAD naming a walked link',
            backend: 'reftable',
            seed: { direct: { 'refs/heads/x': 'c2' }, ...HEAD_S_X },
            name: 'refs/heads/s',
            newId: 'c1',
            options: { reflogMessage: 'm' },
            refs: { 'refs/heads/x': { kind: 'direct', id: 'c1' } },
            logs: {
              HEAD: [['c2', 'c1', 'm']],
              'refs/heads/s': [['c2', 'c1', 'm']],
              'refs/heads/x': [['c2', 'c1', 'm']],
            },
          },
          ...(['files', 'reftable'] as const).map(
            (backend): SuccessRow => ({
              label: `${backend} logs HEAD naming a later link with ${backend === 'files' ? 'the null id' : 'the resolved value'}`,
              backend,
              seed: {
                direct: { 'refs/heads/x': 'c1' },
                symbolic: {
                  HEAD: 'refs/heads/a2',
                  'refs/heads/a1': 'refs/heads/a2',
                  'refs/heads/a2': 'refs/heads/x',
                },
              },
              name: 'refs/heads/a1',
              newId: 'c2',
              options: { reflogMessage: 'm' },
              refs: { 'refs/heads/x': { kind: 'direct', id: 'c2' } },
              logs: {
                HEAD: [[backend === 'files' ? 'zero' : 'c1', 'c2', 'm']],
                'refs/heads/a1': [['c1', 'c2', 'm']],
                'refs/heads/a2': [['c1', 'c2', 'm']],
                'refs/heads/x': [['c1', 'c2', 'm']],
              },
            }),
          ),
          {
            label: 'writing the terminal that HEAD reaches through a link couples nothing',
            backend: 'files',
            seed: { direct: { 'refs/heads/x': 'c1' }, ...HEAD_S_X },
            name: 'refs/heads/x',
            newId: 'c2',
            options: { reflogMessage: 'm' },
            refs: { 'refs/heads/x': { kind: 'direct', id: 'c2' } },
            logs: { HEAD: [], 'refs/heads/s': [], 'refs/heads/x': [['c1', 'c2', 'm']] },
          },
          ...(['files', 'reftable'] as const).map(
            (backend): SuccessRow => ({
              label: `${backend} logs the resolved old value for HEAD on a noDeref write of the symref it names`,
              backend,
              seed: { direct: { 'refs/heads/x': 'c1' }, ...HEAD_S_X },
              name: 'refs/heads/s',
              newId: 'c2',
              options: { noDeref: true, reflogMessage: 'm' },
              refs: {
                'refs/heads/s': { kind: 'direct', id: 'c2' },
                'refs/heads/x': { kind: 'direct', id: 'c1' },
              },
              logs: {
                HEAD: [['c1', 'c2', 'm']],
                'refs/heads/s': [['c1', 'c2', 'm']],
                'refs/heads/x': [],
              },
            }),
          ),
          {
            label: 'a delete through a symref removes its target and logs the symref',
            backend: 'files',
            seed: {
              direct: { 'refs/heads/x': 'c1' },
              symbolic: { 'refs/heads/s': 'refs/heads/x' },
            },
            name: 'refs/heads/s',
            newId: 'zero',
            options: { delete: true, reflogMessage: 'del' },
            refs: {
              'refs/heads/s': { kind: 'symbolic', target: 'refs/heads/x' },
              'refs/heads/x': { kind: 'missing' },
            },
            logs: { 'refs/heads/s': [['c1', 'zero', 'del']], 'refs/heads/x': [] },
          },
          ...(['files', 'reftable'] as const).map(
            (backend): SuccessRow => ({
              label: `${backend} ${backend === 'files' ? 'logs' : 'skips'} the null entry of a delete through a dangling symref`,
              backend,
              seed: { symbolic: { 'refs/heads/dd': 'refs/heads/nope' } },
              name: 'refs/heads/dd',
              newId: 'zero',
              options: { delete: true },
              refs: { 'refs/heads/dd': { kind: 'symbolic', target: 'refs/heads/nope' } },
              logs: { 'refs/heads/dd': backend === 'files' ? [['zero', 'zero', '']] : [] },
            }),
          ),
          {
            label: 'files removes the log of a symref deleted with noDeref, keeping its target',
            backend: 'files',
            seed: {
              direct: { 'refs/heads/w': 'c1' },
              symbolic: { 'refs/heads/u': 'refs/heads/w' },
              logged: ['refs/heads/u'],
            },
            name: 'refs/heads/u',
            newId: 'zero',
            options: { delete: true, noDeref: true, reflogMessage: 'm' },
            refs: {
              'refs/heads/u': { kind: 'missing' },
              'refs/heads/w': { kind: 'direct', id: 'c1' },
            },
            logs: { 'refs/heads/u': [] },
          },
          {
            label: 'a delete through a symref whose expected matches its target removes the target',
            backend: 'files',
            seed: {
              direct: { 'refs/heads/x3': 'c1' },
              symbolic: { 'refs/heads/dd2': 'refs/heads/x3' },
            },
            name: 'refs/heads/dd2',
            newId: 'zero',
            options: { delete: true, expected: 'c1' as ObjectId, reflogMessage: 'm' },
            refs: {
              'refs/heads/dd2': { kind: 'symbolic', target: 'refs/heads/x3' },
              'refs/heads/x3': { kind: 'missing' },
            },
            logs: { 'refs/heads/dd2': [['c1', 'zero', 'm']] },
          },
          {
            label: 'deleting HEAD removes its branch and keeps HEAD symbolic',
            backend: 'files',
            seed: { direct: { 'refs/heads/main': 'c2' }, symbolic: { HEAD: 'refs/heads/main' } },
            name: 'HEAD',
            newId: 'zero',
            options: { delete: true, reflogMessage: 'm' },
            refs: {
              HEAD: { kind: 'symbolic', target: 'refs/heads/main' },
              'refs/heads/main': { kind: 'missing' },
            },
            logs: { HEAD: [['c2', 'zero', 'm']] },
          },
          {
            label: 'a noDeref delete of HEAD removes HEAD and its log, keeping the branch',
            backend: 'files',
            seed: { direct: { 'refs/heads/main': 'c2' }, symbolic: { HEAD: 'refs/heads/main' } },
            name: 'HEAD',
            newId: 'zero',
            options: { delete: true, noDeref: true, reflogMessage: 'm' },
            refs: { HEAD: { kind: 'missing' }, 'refs/heads/main': { kind: 'direct', id: 'c2' } },
            logs: { HEAD: [] },
          },
          ...(['files', 'reftable'] as const).map(
            (backend): SuccessRow => ({
              label: `${backend} logs HEAD naming a deleted link with ${backend === 'files' ? 'the null id' : 'the resolved value'}`,
              backend,
              seed: { direct: { 'refs/heads/x': 'c1' }, ...HEAD_S_X },
              name: 'refs/heads/s',
              newId: 'zero',
              options: { delete: true, reflogMessage: 'm' },
              refs: { 'refs/heads/x': { kind: 'missing' } },
              logs: {
                HEAD: [[backend === 'files' ? 'zero' : 'c1', 'zero', 'm']],
                'refs/heads/s': [['c1', 'zero', 'm']],
              },
            }),
          ),
          {
            label: 'deleting HEAD through two hops logs HEAD and the link once each',
            backend: 'files',
            seed: { direct: { 'refs/heads/x': 'c1' }, ...HEAD_S_X },
            name: 'HEAD',
            newId: 'zero',
            options: { delete: true, reflogMessage: 'm' },
            refs: { 'refs/heads/x': { kind: 'missing' } },
            logs: { HEAD: [['c1', 'zero', 'm']], 'refs/heads/s': [['c1', 'zero', 'm']] },
          },
          ...(['files', 'reftable'] as const).map(
            (backend): SuccessRow => ({
              label: `${backend} ${backend === 'files' ? 'logs' : 'skips'} the null entries of HEAD and a dangling link on delete`,
              backend,
              seed: { symbolic: { HEAD: 'refs/heads/dd', 'refs/heads/dd': 'refs/heads/nope' } },
              name: 'refs/heads/dd',
              newId: 'zero',
              options: { delete: true, reflogMessage: 'm' },
              refs: { 'refs/heads/dd': { kind: 'symbolic', target: 'refs/heads/nope' } },
              logs:
                backend === 'files'
                  ? { HEAD: [['zero', 'zero', 'm']], 'refs/heads/dd': [['zero', 'zero', 'm']] }
                  : { HEAD: [], 'refs/heads/dd': [] },
            }),
          ),
          ...(['files', 'reftable'] as const).map(
            (backend): SuccessRow => ({
              label: `${backend} logs HEAD with the resolved value on a noDeref delete of its branch`,
              backend,
              seed: { direct: { 'refs/heads/main': 'c1' }, symbolic: { HEAD: 'refs/heads/main' } },
              name: 'refs/heads/main',
              newId: 'zero',
              options: { delete: true, noDeref: true, reflogMessage: 'm' },
              refs: { 'refs/heads/main': { kind: 'missing' } },
              logs: { HEAD: [['c1', 'zero', 'm']] },
            }),
          ),
        ])('Then $label, in one applyRefUpdates call', async (row) => {
          // Arrange
          const fixture = await symrefFixture(row.backend, row.seed);
          const options = withSlotIds(row.options, fixture.ids);
          const sut = updateRef;

          // Act
          await sut(fixture.ctx, row.name as RefName, fixture.ids[row.newId], options);

          // Assert
          const store = getRefStore(fixture.ctx);
          expect(fixture.calls).toHaveLength(1);
          for (const [name, ref] of Object.entries(row.refs)) {
            expect(await store.resolveDirect(name as RefName)).toEqual(
              expectedValue(fixture.ids, ref),
            );
          }
          for (const [name, lines] of Object.entries(row.logs)) {
            expect(await logLines(fixture, name)).toEqual(
              lines.map((line) => expectedLine(fixture.ids, line)),
            );
          }
        });
      });
    });

    /** Rows name expected ids by slot (`'c1'`); the real ids exist only once
     *  the fixture has written the commits. */
    const withSlotIds = (options: UpdateRefOptions, ids: Fixture['ids']): UpdateRefOptions => {
      const expected = options.expected;
      if (expected === undefined || expected === 'absent') return options;
      return { ...options, expected: ids[expected as Slot] };
    };

    interface ConflictRow {
      readonly label: string;
      readonly seed: Seed;
      readonly name: string;
      readonly options: UpdateRefOptions;
      readonly conflict: { readonly expected: Slot | 'absent'; readonly actual: Slot | 'absent' };
    }

    describe('Given a seeded symbolic ref and an expected value it does not match', () => {
      describe('When updateRef checks the compare-and-swap', () => {
        it.each<ConflictRow>([
          {
            label: 'a write through a symref compares its target and names the given ref',
            seed: {
              direct: { 'refs/heads/x': 'c1' },
              symbolic: { 'refs/heads/s': 'refs/heads/x' },
            },
            name: 'refs/heads/s',
            options: { expected: 'c2' as ObjectId, reflogMessage: 'm' },
            conflict: { expected: 'c2', actual: 'c1' },
          },
          {
            label: 'expecting absent through a symref to a live target refuses',
            seed: {
              direct: { 'refs/heads/x': 'c1' },
              symbolic: { 'refs/heads/s': 'refs/heads/x' },
            },
            name: 'refs/heads/s',
            options: { expected: 'absent', reflogMessage: 'm' },
            conflict: { expected: 'absent', actual: 'c1' },
          },
          {
            label: 'a noDeref write expecting absent over a symref to a live target refuses',
            seed: {
              direct: { 'refs/heads/x': 'c1' },
              symbolic: { 'refs/heads/s6': 'refs/heads/x' },
            },
            name: 'refs/heads/s6',
            options: { expected: 'absent', noDeref: true, reflogMessage: 'm' },
            conflict: { expected: 'absent', actual: 'c1' },
          },
          {
            label: 'a noDeref write expecting an id over a dangling symref refuses as absent',
            seed: { symbolic: { 'refs/heads/s7': 'refs/heads/nope7' } },
            name: 'refs/heads/s7',
            options: { expected: 'c1' as ObjectId, noDeref: true, reflogMessage: 'm' },
            conflict: { expected: 'c1', actual: 'absent' },
          },
          {
            label: 'a delete through a symref compares its target',
            seed: {
              direct: { 'refs/heads/x3': 'c1' },
              symbolic: { 'refs/heads/dd2': 'refs/heads/x3' },
            },
            name: 'refs/heads/dd2',
            options: { delete: true, expected: 'c2' as ObjectId },
            conflict: { expected: 'c2', actual: 'c1' },
          },
        ])('Then $label and nothing is applied', async (row) => {
          // Arrange
          const fixture = await symrefFixture('files', row.seed);
          const slotId = (slot: Slot | 'absent'): ObjectId | 'absent' =>
            slot === 'absent' ? 'absent' : fixture.ids[slot];
          const sut = updateRef;

          // Act
          let caught: unknown;
          try {
            await sut(
              fixture.ctx,
              row.name as RefName,
              row.options.delete === true ? ZERO : fixture.ids.c2,
              withSlotIds(row.options, fixture.ids),
            );
          } catch (error) {
            caught = error;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: row.name,
            expected: slotId(row.conflict.expected),
            actual: slotId(row.conflict.actual),
          });
          expect(fixture.calls).toEqual([]);
        });
      });
    });
  });

  describe('branch typing', () => {
    const writeTree = async (ctx: Context): Promise<ObjectId> =>
      writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry(FILE_MODE.REGULAR, 'a', await writeBlob(ctx))],
      });
    const writeBlob = (ctx: Context): Promise<ObjectId> =>
      writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: ENC.encode('typed blob') });
    const writeAnnotatedTag = async (ctx: Context): Promise<ObjectId> =>
      writeObject(ctx, {
        type: 'tag',
        id: '' as ObjectId,
        data: {
          object: await writeCommit(ctx, 'tagged commit'),
          objectType: 'commit',
          tagName: 'v1',
          tagger: COMMIT_AUTHOR,
          message: 'annotated\n',
          extraHeaders: [],
        },
      });

    describe('Given a non-commit object written to a branch-typed name', () => {
      describe('When updateRef writes it', () => {
        it.each([
          { label: 'a tree to a branch', actual: 'tree', name: 'refs/heads/x', write: writeTree },
          { label: 'a blob to a branch', actual: 'blob', name: 'refs/heads/x', write: writeBlob },
          {
            label: 'an annotated tag object to a branch',
            actual: 'tag',
            name: 'refs/heads/x',
            write: writeAnnotatedTag,
          },
          { label: 'a tree to HEAD', actual: 'tree', name: 'HEAD', write: writeTree },
        ])(
          'Then $label refuses UNEXPECTED_OBJECT_TYPE and leaves the ref absent',
          async ({ actual, name, write }) => {
            // Arrange
            const ctx = await buildSeededContext();
            const id = await write(ctx);
            const sut = updateRef;

            // Act
            let caught: unknown;
            try {
              await sut(ctx, name as RefName, id, { reflogMessage: REASON });
            } catch (error) {
              caught = error;
            }

            // Assert
            expect((caught as TsgitError).data).toEqual({
              code: 'UNEXPECTED_OBJECT_TYPE',
              expected: 'commit',
              actual,
              id,
            });
            expect(await getRefStore(ctx).resolveDirect(name as RefName)).toEqual({
              kind: 'missing',
            });
          },
        );
      });
    });

    describe('Given a tree written to a name git does not type as a branch', () => {
      describe('When updateRef writes it', () => {
        it.each([
          { label: 'ORIG_HEAD', name: 'ORIG_HEAD' },
          { label: 'a tag', name: 'refs/tags/x' },
        ])('Then $label accepts the tree', async ({ name }) => {
          // Arrange
          const ctx = await buildSeededContext();
          const tree = await writeTree(ctx);
          const sut = updateRef;

          // Act
          await sut(ctx, name as RefName, tree, { reflogMessage: REASON });

          // Assert
          expect(await getRefStore(ctx).resolveDirect(name as RefName)).toEqual({
            kind: 'direct',
            id: tree,
          });
        });
      });
    });

    describe('Given a tag symref naming a branch', () => {
      describe('When updateRef writes a tree through the tag name', () => {
        it('Then the tree is accepted — the given name, not the branch it reaches, is typed', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const tree = await writeTree(ctx);
          await writeSymbolicRef(ctx, 'refs/tags/ts' as RefName, 'refs/heads/x' as RefName);
          const sut = updateRef;

          // Act
          await sut(ctx, 'refs/tags/ts' as RefName, tree, { reflogMessage: REASON });

          // Assert
          expect(await getRefStore(ctx).resolveDirect('refs/heads/x' as RefName)).toEqual({
            kind: 'direct',
            id: tree,
          });
        });
      });
    });

    describe('Given a branch symref naming an absent tag', () => {
      describe('When updateRef writes a tree through the branch name', () => {
        it('Then it refuses UNEXPECTED_OBJECT_TYPE and the tag stays absent', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const tree = await writeTree(ctx);
          await writeSymbolicRef(ctx, 'refs/heads/bt' as RefName, 'refs/tags/tt' as RefName);
          const sut = updateRef;

          // Act
          let caught: unknown;
          try {
            await sut(ctx, 'refs/heads/bt' as RefName, tree, { reflogMessage: REASON });
          } catch (error) {
            caught = error;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'UNEXPECTED_OBJECT_TYPE',
            expected: 'commit',
            actual: 'tree',
            id: tree,
          });
          expect(await getRefStore(ctx).resolveDirect('refs/tags/tt' as RefName)).toEqual({
            kind: 'missing',
          });
        });
      });
    });

    describe('Given a missing object id and an expected value the ref does not hold', () => {
      describe('When updateRef writes it', () => {
        it('Then the verification refuses OBJECT_NOT_FOUND before the compare-and-swap', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const missing = 'e'.repeat(40) as ObjectId;
          const sut = updateRef;

          // Act
          let caught: unknown;
          try {
            await sut(ctx, MAIN, missing, {
              expected: 'f'.repeat(40) as ObjectId,
              reflogMessage: REASON,
            });
          } catch (error) {
            caught = error;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: missing });
        });
      });
    });
  });

  describe('verified targets on one Context', () => {
    describe('Given one commit written to two refs on the same Context', () => {
      describe('When updateRef writes the second ref', () => {
        it("Then the commit's stored bytes are not read again — only its presence is probed", async () => {
          // Arrange
          const base = await buildSeededContext();
          const commit = await writeCommit(base, 'verified once');
          const loosePath = `${base.layout.gitDir}/objects/${computeLooseObjectPath(commit)}`;
          const { ctx, calls } = instrumentedContext(base);
          await updateRef(ctx, 'refs/remotes/origin/main' as RefName, commit, {
            reflogMessage: REASON,
          });
          const before = calls().length;
          const sut = updateRef;

          // Act
          await sut(ctx, MAIN, commit, { reflogMessage: REASON });

          // Assert
          const touches = calls()
            .slice(before)
            .filter((call) => call.path === loosePath)
            .map((call) => call.method);
          expect(touches).toEqual(['exists']);
          expect(await resolveRef(ctx, MAIN)).toBe(commit);
        });
      });
    });

    describe('Given a verified commit whose loose object is removed afterwards', () => {
      describe('When updateRef writes it to another ref on the same Context', () => {
        it('Then it refuses OBJECT_NOT_FOUND and the ref stays absent', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const commit = await writeCommit(ctx, 'verified then removed');
          await updateRef(ctx, 'refs/tags/first' as RefName, commit, { reflogMessage: REASON });
          await ctx.fs.rm(`${ctx.layout.gitDir}/objects/${computeLooseObjectPath(commit)}`);
          const sut = updateRef;

          // Act
          let caught: unknown;
          try {
            await sut(ctx, 'refs/tags/second' as RefName, commit, { reflogMessage: REASON });
          } catch (error) {
            caught = error;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: commit });
          expect(await getRefStore(ctx).resolveDirect('refs/tags/second' as RefName)).toEqual({
            kind: 'missing',
          });
        });
      });
    });

    describe('Given a tree already written to a tag on the same Context', () => {
      describe('When updateRef writes the same tree to a branch', () => {
        it('Then the branch typing still refuses it', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const tree = await writeObject(ctx, {
            type: 'tree',
            id: '' as ObjectId,
            entries: [treeEntry(FILE_MODE.REGULAR, 'a', await writeCommit(ctx, 'tree entry'))],
          });
          await updateRef(ctx, 'refs/tags/tree' as RefName, tree, { reflogMessage: REASON });
          const sut = updateRef;

          // Act
          let caught: unknown;
          try {
            await sut(ctx, 'refs/heads/tree' as RefName, tree, { reflogMessage: REASON });
          } catch (error) {
            caught = error;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'UNEXPECTED_OBJECT_TYPE',
            expected: 'commit',
            actual: 'tree',
            id: tree,
          });
        });
      });
    });

    describe('Given a commit accepted only because .git/shallow lists it', () => {
      describe('When the shallow entry is dropped and updateRef writes it again on the same Context', () => {
        it('Then it refuses bad parent — a shallow-dependent acceptance is never remembered', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const treeHex = emptyTreeOid(ctx.hashConfig);
          const id = await writeRawObjectBytes(
            ctx,
            'commit',
            ENC.encode(`tree ${treeHex}\nparent ${treeHex}\nx`),
          );
          await ctx.fs.writeUtf8(shallowFilePath(commonGitDir(ctx)), `${id}\n`);
          invalidateShallowSet(ctx);
          await updateRef(ctx, 'refs/tags/shallow' as RefName, id, { reflogMessage: REASON });
          await ctx.fs.writeUtf8(shallowFilePath(commonGitDir(ctx)), '');
          invalidateShallowSet(ctx);
          const sut = updateRef;

          // Act
          let caught: unknown;
          try {
            await sut(ctx, 'refs/tags/again' as RefName, id, { reflogMessage: REASON });
          } catch (error) {
            caught = error;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_COMMIT',
            reason: `bad parent ${treeHex}`,
          });
        });
      });
    });
  });

  describe('parse acceptance', () => {
    describe('Given a hash-valid but too-short commit body', () => {
      describe('When updateRef writes it to a non-branch ref', () => {
        it('Then it refuses INVALID_COMMIT and writes nothing', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const malformed = await writeRawObjectBytes(ctx, 'commit', ENC.encode('short'));

          // Act + Assert
          try {
            await updateRef(ctx, 'refs/tags/x' as RefName, malformed, { reflogMessage: REASON });
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_COMMIT');
            if (data.code === 'INVALID_COMMIT') expect(data.reason).toBe('bogus commit object');
          }
          expect(await ctx.fs.exists('/repo/.git/refs/tags/x')).toBe(false);
        });
      });
    });

    describe('Given a hash-valid commit with a non-hex tree pointer', () => {
      describe('When updateRef writes it to a branch', () => {
        it('Then it refuses via the parse refusal, not UNEXPECTED_OBJECT_TYPE', async () => {
          // Arrange — the stored type is genuinely 'commit' (read from the
          // loose header, never from the malformed body), so a mutant that
          // ran the branch-type check first would still see type 'commit'
          // and pass it — proving this reason can only come from the parse
          // check actually running.
          const ctx = await buildSeededContext();
          const badTree = ENC.encode(`tree ${'g'.repeat(40)}\nx`);
          const malformed = await writeRawObjectBytes(ctx, 'commit', badTree);

          // Act + Assert
          try {
            await updateRef(ctx, 'refs/heads/x' as RefName, malformed, { reflogMessage: REASON });
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_COMMIT');
            if (data.code === 'INVALID_COMMIT') expect(data.reason).toBe('bad tree pointer');
          }
        });
      });
    });

    describe('Given a hash-valid but too-short tag body', () => {
      describe('When updateRef writes it', () => {
        it('Then it refuses INVALID_TAG', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const malformed = await writeRawObjectBytes(ctx, 'tag', ENC.encode('short'));

          // Act + Assert
          try {
            await updateRef(ctx, 'refs/tags/x' as RefName, malformed, { reflogMessage: REASON });
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_TAG');
            if (data.code === 'INVALID_TAG') expect(data.reason).toBe('tag object too short');
          }
        });
      });
    });

    describe('Given a tree with garbage entries', () => {
      describe('When updateRef writes it to a non-branch ref', () => {
        it('Then it is written — git never parses a tree', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const garbage = await writeRawObjectBytes(
            ctx,
            'tree',
            ENC.encode('not a tree body at all'),
          );

          // Act
          await updateRef(ctx, 'refs/tags/x' as RefName, garbage, { reflogMessage: REASON });

          // Assert
          expect(await resolveRef(ctx, 'refs/tags/x' as RefName)).toBe(garbage);
        });
      });
    });

    describe('Given a commit with no author or committer line', () => {
      describe('When updateRef writes it to a branch', () => {
        it('Then it is written — git does not require them', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const treeHex = emptyTreeOid(ctx.hashConfig);
          const body = ENC.encode(`tree ${treeHex}\n\nmessage only, no author or committer\n`);
          const commit = await writeRawObjectBytes(ctx, 'commit', body);

          // Act
          await updateRef(ctx, 'refs/heads/x' as RefName, commit, { reflogMessage: REASON });

          // Assert
          expect(await resolveRef(ctx, 'refs/heads/x' as RefName)).toBe(commit);
        });
      });
    });

    describe('Given a loose commit above the buffered gate with a malformed parent line', () => {
      describe('When updateRef writes it', () => {
        it('Then it refuses via parse acceptance, and the buffered inflate path is never used', async () => {
          // Arrange — incompressible padding pushes the loose file's
          // COMPRESSED size past the 64 KiB gate; the malformed parent line
          // sits right after the (valid) tree line, so the streamed scan
          // refuses long before the padding is even reached.
          const base = await buildSeededContext();
          const treeHex = emptyTreeOid(base.hashConfig);
          const prefix = ENC.encode(`tree ${treeHex}\nparent ${'g'.repeat(40)}\n`);
          const padding = pseudoRandomBytes(70_000, 1);
          const body = concatUint8(prefix, padding);
          const id = await writeRawObjectBytes(base, 'commit', body);
          const loosePath = `${base.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
          const compressedLength = (await base.fs.read(loosePath)).length;
          expect(compressedLength).toBeGreaterThan(65_536);
          let sawBufferedInflate = false;
          const ctx: Context = {
            ...base,
            compressor: {
              ...base.compressor,
              inflate: async (...args) => {
                sawBufferedInflate = true;
                return base.compressor.inflate(...args);
              },
            },
          };

          // Act + Assert
          try {
            await updateRef(ctx, 'refs/tags/big' as RefName, id, { reflogMessage: REASON });
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_COMMIT');
            if (data.code === 'INVALID_COMMIT') expect(data.reason).toBe('bad parents');
          }
          expect(sawBufferedInflate).toBe(false);
        });
      });
    });

    describe('Given a well-formed loose commit above the buffered gate', () => {
      describe('When updateRef writes it', () => {
        it('Then it is written — the streamed scan accepts it', async () => {
          // Arrange — the same incompressible padding, after a valid tree
          // line and the blank line that ends the headers.
          const ctx = await buildSeededContext();
          const treeHex = emptyTreeOid(ctx.hashConfig);
          const prefix = ENC.encode(`tree ${treeHex}\n\n`);
          const body = concatUint8(prefix, pseudoRandomBytes(70_000, 2));
          const id = await writeRawObjectBytes(ctx, 'commit', body);
          const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
          expect((await ctx.fs.read(loosePath)).length).toBeGreaterThan(65_536);

          // Act
          await updateRef(ctx, 'refs/tags/big-valid' as RefName, id, { reflogMessage: REASON });

          // Assert
          expect(await resolveRef(ctx, 'refs/tags/big-valid' as RefName)).toBe(id);
        });
      });
    });

    describe('Given a commit whose parent equals its own tree', () => {
      describe('When updateRef writes it, and the commit is not a recorded shallow boundary', () => {
        it('Then it refuses bad parent', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const treeHex = emptyTreeOid(ctx.hashConfig);
          const body = ENC.encode(`tree ${treeHex}\nparent ${treeHex}\nx`);
          const id = await writeRawObjectBytes(ctx, 'commit', body);

          // Act + Assert
          try {
            await updateRef(ctx, 'refs/tags/self-parent' as RefName, id, {
              reflogMessage: REASON,
            });
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_COMMIT');
            if (data.code === 'INVALID_COMMIT') {
              expect(data.reason).toBe(`bad parent ${treeHex}`);
            }
          }
        });
      });

      describe('When updateRef writes it, and the commit IS listed in .git/shallow', () => {
        it('Then it is written — the shallow boundary skips the parent lookup', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const treeHex = emptyTreeOid(ctx.hashConfig);
          const body = ENC.encode(`tree ${treeHex}\nparent ${treeHex}\nx`);
          const id = await writeRawObjectBytes(ctx, 'commit', body);
          await ctx.fs.writeUtf8(shallowFilePath(commonGitDir(ctx)), `${id}\n`);
          invalidateShallowSet(ctx);

          // Act
          await updateRef(ctx, 'refs/tags/shallow' as RefName, id, { reflogMessage: REASON });

          // Assert
          expect(await resolveRef(ctx, 'refs/tags/shallow' as RefName)).toBe(id);
        });
      });
    });

    describe('Given a commit whose parent differs from its own tree', () => {
      describe('When updateRef writes it', () => {
        it('Then .git/shallow is never read — the lookup is skipped, not merely answered no', async () => {
          // Arrange
          const base = await buildSeededContext();
          const treeHex = emptyTreeOid(base.hashConfig);
          const body = ENC.encode(`tree ${treeHex}\nparent ${'b'.repeat(40)}\nx`);
          const id = await writeRawObjectBytes(base, 'commit', body);
          const { ctx, calls } = instrumentedContext(base);

          // Act
          await updateRef(ctx, 'refs/tags/no-shallow' as RefName, id, { reflogMessage: REASON });

          // Assert
          expect(calls().some((entry) => entry.path === `${base.layout.gitDir}/shallow`)).toBe(
            false,
          );
        });
      });
    });
  });
});
