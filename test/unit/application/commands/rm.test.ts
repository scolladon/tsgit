import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { rm } from '../../../../src/application/commands/rm.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { fileNotFound, TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const work = (ctx: Context, name: string): string => `${ctx.layout.workDir}/${name}`;

// Stage AND commit, so the index matches HEAD and the working tree matches the
// index — a clean state `git rm` removes without engaging the safety valve.
const seedAndStage = async (workingTree: Readonly<Record<string, string>>) => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree });
  await add(ctx, Object.keys(workingTree));
  await commit(ctx, { message: 'seed', author: AUTHOR });
  return ctx;
};

const expectError = async (fn: () => Promise<unknown>, code: string): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(code);
  return caught as TsgitError;
};

// Committed `a.txt`, then a staged edit (index ≠ HEAD, working tree == index).
const seedStaged = async (): Promise<Context> => {
  const ctx = await seedAndStage({ 'a.txt': 'v1\n' });
  await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'v2\n');
  await add(ctx, ['a.txt']);
  return ctx;
};

// Committed `a.txt`, then an unstaged working edit (working tree ≠ index == HEAD).
const seedLocal = async (): Promise<Context> => {
  const ctx = await seedAndStage({ 'a.txt': 'v1\n' });
  await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'v2\n');
  return ctx;
};

// Committed `a.txt`, a staged edit, then a further unstaged edit
// (working tree ≠ index ≠ HEAD).
const seedBoth = async (): Promise<Context> => {
  const ctx = await seedStaged();
  await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'v3\n');
  return ctx;
};

describe('rm', () => {
  describe('Given an empty pathspec', () => {
    describe('When rm', () => {
      it('Then throws EMPTY_PATHSPEC', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        // Assert
        await expectError(() => rm(ctx, []), 'EMPTY_PATHSPEC');
      });
    });
  });

  describe('Given a tracked file', () => {
    describe('When rm', () => {
      it('Then result.removed lists it and the file is deleted', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act
        const sut = await rm(ctx, ['a.txt']);

        // Assert
        expect(sut.removed).toEqual(['a.txt']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(false);
      });
    });
  });

  describe('Given cached=true', () => {
    describe('When rm', () => {
      it('Then index entry removed but working file kept', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act
        await rm(ctx, ['a.txt'], { cached: true });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(true);
      });
    });
  });

  describe('Given an untracked path', () => {
    describe('When rm', () => {
      it('Then throws PATHSPEC_NO_MATCH', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        // Assert
        await expectError(() => rm(ctx, ['ghost.txt']), 'PATHSPEC_NO_MATCH');
      });
    });
  });

  describe('Given a glob "*.log" with two matching tracked files', () => {
    describe('When rm', () => {
      it('Then both are removed (no PATHSPEC_NO_MATCH for globs)', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.log': 'a', 'b.log': 'b', 'keep.ts': 'k' });

        // Act
        const sut = await rm(ctx, ['*.log']);

        // Assert
        expect([...sut.removed].sort()).toEqual(['a.log', 'b.log']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/keep.ts`)).toBe(true);
      });
    });
  });

  describe('Given a glob "*.nope" with no matches', () => {
    describe('When rm', () => {
      it('Then returns removed=[] without throwing', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act
        const sut = await rm(ctx, ['*.nope']);

        // Assert — glob no-match is a no-op, not an error (Git semantics).
        expect(sut.removed).toEqual([]);
      });
    });
  });

  describe('Given a glob + a `!`-negation', () => {
    describe('When rm', () => {
      it('Then negated paths stay in the index', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.log': 'a', 'keep.log': 'k', 'b.log': 'b' });

        // Act
        const sut = await rm(ctx, ['*.log', '!keep.log']);

        // Assert
        expect([...sut.removed].sort()).toEqual(['a.log', 'b.log']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/keep.log`)).toBe(true);
      });
    });
  });

  describe('Given a bare repo', () => {
    describe('When rm', () => {
      it('Then throws BARE_REPOSITORY tagged with operation "rm"', async () => {
        // Arrange — fresh ctx with bare=true config seeded BEFORE any read.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

        // Act
        const err = await expectError(() => rm(ctx, ['a.txt']), 'BARE_REPOSITORY');

        // Assert — the operation label travels with the error (kills `'rm'` -> `''`).
        if (err.data.code !== 'BARE_REPOSITORY') throw new Error('unexpected error shape');
        expect(err.data.operation).toBe('rm');
        expect(err.message).toBe('BARE_REPOSITORY: operation requires a working tree: rm');
      });
    });
  });

  describe('Given a corrupt index (INVALID_INDEX_HEADER) and a glob', () => {
    describe('When rm', () => {
      it('Then the parse error is tolerated and removed is empty', async () => {
        // Arrange — an index file shorter than the hash trailer makes readIndex
        // throw INVALID_INDEX_HEADER. rm tolerates it via INDEX_MISSING_CODES.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, new Uint8Array([1, 2, 3]));

        // Act — glob never triggers PATHSPEC_NO_MATCH, so the only path to a throw
        // is rm re-throwing the parse error (which it must NOT do).
        const sut = await rm(ctx, ['*.nope']);

        // Assert — kills `'INVALID_INDEX_HEADER'` -> `''` in INDEX_MISSING_CODES.
        expect(sut.removed).toEqual([]);
      });
    });
  });

  describe('Given a corrupt index (INVALID_INDEX_ENTRY) and a glob', () => {
    describe('When rm', () => {
      it('Then the parse error is tolerated and removed is empty', async () => {
        // Arrange — checksum-valid index whose single entry has no NUL terminator,
        // so parseIndex throws INVALID_INDEX_ENTRY (reached only after the checksum
        // passes).
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const payload = new Uint8Array(12 + 62 + 100);
        const view = new DataView(payload.buffer);
        view.setUint32(0, 0x44495243); // 'DIRC'
        view.setUint32(4, 2); // version 2
        view.setUint32(8, 1); // 1 entry
        view.setUint32(12 + 24, 0o100644); // entry mode
        view.setUint16(12 + 60, 5); // declared path length
        payload.fill(0x78, 12 + 62); // garbage path bytes, no NUL terminator
        const checksum = await ctx.hash.hash(payload);
        const indexBytes = new Uint8Array(payload.length + checksum.length);
        indexBytes.set(payload, 0);
        indexBytes.set(checksum, payload.length);
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, indexBytes);

        // Act
        const sut = await rm(ctx, ['*.nope']);

        // Assert — kills `'INVALID_INDEX_ENTRY'` -> `''` in INDEX_MISSING_CODES.
        expect(sut.removed).toEqual([]);
      });
    });
  });

  describe('Given readIndex stat racing to FILE_NOT_FOUND and a glob', () => {
    describe('When rm', () => {
      it('Then the error is tolerated and removed is empty', async () => {
        // Arrange — index file exists (so readIndex passes the exists() guard) but
        // ctx.fs.stat throws FILE_NOT_FOUND, simulating the file vanishing between
        // exists() and stat(). readIndex propagates FILE_NOT_FOUND.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, new Uint8Array(32));
        const indexFile = `${ctx.layout.gitDir}/index`;
        const racingCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (path: string) => {
              if (path === indexFile) throw fileNotFound(indexFile);
              return ctx.fs.stat(path);
            },
          },
        };

        // Act
        const sut = await rm(racingCtx, ['*.nope']);

        // Assert — kills `'FILE_NOT_FOUND'` -> `''` in INDEX_MISSING_CODES.
        expect(sut.removed).toEqual([]);
      });
    });
  });

  describe('Given a non-INDEX_MISSING readIndex error', () => {
    describe('When rm', () => {
      it('Then the error propagates (not silently tolerated)', async () => {
        // Arrange — make readIndex throw a code that is NOT in INDEX_MISSING_CODES.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, new Uint8Array(32));
        const indexFile = `${ctx.layout.gitDir}/index`;
        const failingCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (path: string) => {
              if (path === indexFile) {
                throw new TsgitError({ code: 'PERMISSION_DENIED', path: indexFile });
              }
              return ctx.fs.stat(path);
            },
          },
        };

        // Act / Assert — kills the L52 ConditionalExpression mutants: a `true`
        // mutant would swallow this, a `false` mutant would swallow nothing — and
        // this branch must re-throw PERMISSION_DENIED specifically because it is
        // not an INDEX_MISSING code.
        await expectError(() => rm(failingCtx, ['*.nope']), 'PERMISSION_DENIED');
      });
    });
  });

  describe('Given cached=false and a working file that vanishes during removeFile', () => {
    describe('When rm', () => {
      it('Then the FILE_NOT_FOUND race is tolerated', async () => {
        // Arrange — a committed (clean) tracked file whose ctx.fs.rm throws
        // FILE_NOT_FOUND, simulating the working copy disappearing mid-remove.
        // lstat still succeeds, so the file passes the safety valve.
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'a.txt': 'a' } });
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'seed', author: AUTHOR });
        const workFile = `${ctx.layout.workDir}/a.txt`;
        const racingCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rm: async (path: string) => {
              if (path === workFile) throw fileNotFound(workFile);
              return ctx.fs.rm(path);
            },
          },
        };

        // Act — must NOT throw: the removeFile catch swallows FILE_NOT_FOUND.
        const sut = await rm(racingCtx, ['a.txt']);

        // Assert — index entry still removed; kills L68 BlockStatement (an empty
        // catch would swallow everything) and L69 ConditionalExpression `-> false`
        // (which would re-throw FILE_NOT_FOUND).
        expect(sut.removed).toEqual(['a.txt']);
      });
    });
  });

  describe('Given cached=false and a missing working file (CHECKOUT_OVERWRITE_DIRTY)', () => {
    describe('When rm', () => {
      it('Then the error propagates', async () => {
        // Arrange — a tracked file already deleted from the working tree. removeFile
        // sees the missing file and throws CHECKOUT_OVERWRITE_DIRTY, NOT FILE_NOT_FOUND.
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'a.txt': 'a' } });
        await add(ctx, ['a.txt']);
        await ctx.fs.rm(`${ctx.layout.workDir}/a.txt`);

        // Act / Assert — the removeFile catch must re-throw any non-FILE_NOT_FOUND
        // error. Kills L69 EqualityOperator `=== ` -> `!==` (which would swallow
        // CHECKOUT_OVERWRITE_DIRTY) and the `-> true` ConditionalExpression mutant.
        const err = await expectError(() => rm(ctx, ['a.txt']), 'CHECKOUT_OVERWRITE_DIRTY');
        if (err.data.code !== 'CHECKOUT_OVERWRITE_DIRTY') throw new Error('unexpected error shape');
        expect(err.data.localChanges).toEqual(['a.txt']);
        expect(err.data.untracked).toEqual([]);
      });
    });
  });

  describe('Given config.breakStaleLockMs and a stale lock', () => {
    describe('When rm', () => {
      it('Then the stale lock is broken and rm succeeds', async () => {
        // Arrange — pre-create index.lock and report an ancient mtime for it, so
        // its age exceeds the repo-wide config.breakStaleLockMs. With the policy
        // sourced from config, acquireIndexLock breaks the stale lock and rm proceeds.
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        const lockPath = `${ctx.layout.gitDir}/index.lock`;
        await ctx.fs.writeExclusive(lockPath, new Uint8Array());
        const staleCtx = {
          ...ctx,
          config: { ...ctx.config, breakStaleLockMs: 1 },
          fs: {
            ...ctx.fs,
            lstat: async (path: string) => {
              const stat = await ctx.fs.lstat(path);
              // Report epoch-0 mtime for the lock so it always reads as stale.
              return path === lockPath ? { ...stat, mtimeMs: 0 } : stat;
            },
          },
        };

        // Act — if rm stopped sourcing the window from config the lock would not
        // break and RESOURCE_LOCKED would surface instead.
        const sut = await rm(staleCtx, ['a.txt']);

        // Assert — the policy reached acquireIndexLock; the stale lock was broken.
        expect(sut.removed).toEqual(['a.txt']);
      });
    });
  });

  describe('Given no config.breakStaleLockMs and a held lock', () => {
    describe('When rm', () => {
      it('Then it surfaces RESOURCE_LOCKED', async () => {
        // Arrange — pre-create index.lock with no breakStaleLockMs option.
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        await ctx.fs.writeExclusive(`${ctx.layout.gitDir}/index.lock`, new Uint8Array());

        // Act / Assert — baseline: without the option a contended lock is fatal.
        const err = await expectError(() => rm(ctx, ['a.txt']), 'RESOURCE_LOCKED');
        if (err.data.code !== 'RESOURCE_LOCKED') throw new Error('unexpected error shape');
        expect(err.data.resource).toBe('index');
      });
    });
  });

  describe('Given a successful rm', () => {
    describe('When it completes', () => {
      it('Then the index lock is released (a second rm is not RESOURCE_LOCKED)', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a', 'b.txt': 'b' });

        // Act — first rm acquires the lock; commit() consumes it.
        await rm(ctx, ['a.txt']);
        // A second rm would throw RESOURCE_LOCKED if the lock were not released.
        const sut = await rm(ctx, ['b.txt']);

        // Assert — the lock file is gone after a successful rm.
        expect(sut.removed).toEqual(['b.txt']);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
      });
    });
  });

  describe('Given a rm that throws PATHSPEC_NO_MATCH before commit', () => {
    describe('When it rejects', () => {
      it('Then the finally block still releases the lock', async () => {
        // Arrange — `commit()` consumes the lock on the happy path, so a successful
        // rm cannot prove the `finally` release runs. Force a failure AFTER the
        // lock is acquired but BEFORE commit: an unmatched literal makes
        // enforceLiteralMustMatch throw, leaving the lock un-consumed. Only the
        // `finally` block can drop it.
        const ctx = await seedAndStage({ 'a.txt': 'a', 'b.txt': 'b' });

        // Act — first rm acquires the lock then rejects pre-commit.
        await expectError(() => rm(ctx, ['ghost.txt']), 'PATHSPEC_NO_MATCH');

        // Assert — the lock was released by `finally`; the file is gone and a
        // follow-up rm succeeds instead of throwing RESOURCE_LOCKED. Kills L76
        // BlockStatement `-> {}` (an empty `finally` leaks the un-committed lock).
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
        const sut = await rm(ctx, ['b.txt']);
        expect(sut.removed).toEqual(['b.txt']);
      });
    });
  });

  describe('Given a path with staged changes (index differs from HEAD)', () => {
    describe('When rm without an override', () => {
      it('Then it refuses with RM_STAGED_CHANGES and removes nothing', async () => {
        // Arrange
        const ctx = await seedStaged();

        // Act
        const err = await expectError(() => rm(ctx, ['a.txt']), 'RM_STAGED_CHANGES');

        // Assert — the refused path travels with the error and nothing was removed.
        if (err.data.code !== 'RM_STAGED_CHANGES') throw new Error('unexpected error shape');
        expect(err.data.paths).toEqual(['a.txt']);
        expect(err.message).toContain('changes staged in the index');
        expect(await ctx.fs.exists(work(ctx, 'a.txt'))).toBe(true);
        const index = await readIndex(ctx);
        expect(index.entries.map((e) => e.path)).toContain('a.txt');
      });
    });

    describe('When rm --cached', () => {
      it('Then --cached suppresses the staged valve and the index entry is dropped', async () => {
        // Arrange
        const ctx = await seedStaged();

        // Act
        const sut = await rm(ctx, ['a.txt'], { cached: true });

        // Assert — index entry gone, working file kept (git rm --cached semantics).
        expect(sut.removed).toEqual(['a.txt']);
        expect(await ctx.fs.exists(work(ctx, 'a.txt'))).toBe(true);
      });
    });

    describe('When rm --force', () => {
      it('Then force suppresses the valve and removes index entry and working file', async () => {
        // Arrange
        const ctx = await seedStaged();

        // Act
        const sut = await rm(ctx, ['a.txt'], { force: true });

        // Assert
        expect(sut.removed).toEqual(['a.txt']);
        expect(await ctx.fs.exists(work(ctx, 'a.txt'))).toBe(false);
      });
    });
  });

  describe('Given a path with a staged mode-only change (same blob, different mode)', () => {
    describe('When rm without an override', () => {
      it('Then it refuses with RM_STAGED_CHANGES on the mode difference alone', async () => {
        // Arrange — commit a symlink, then replace it with a regular file holding
        // the identical bytes (the link target). The blob id is unchanged, but the
        // index mode (100644) now differs from HEAD's (120000): a staged mode-only
        // change, with the working file matching the index (no local change).
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.symlink('payload', work(ctx, 'link'));
        await add(ctx, ['link']);
        await commit(ctx, { message: 'seed', author: AUTHOR });
        await ctx.fs.rm(work(ctx, 'link'));
        await ctx.fs.writeUtf8(work(ctx, 'link'), 'payload');
        await add(ctx, ['link']);

        // Act
        const err = await expectError(() => rm(ctx, ['link']), 'RM_STAGED_CHANGES');

        // Assert
        if (err.data.code !== 'RM_STAGED_CHANGES') throw new Error('unexpected error shape');
        expect(err.data.paths).toEqual(['link']);
      });
    });
  });

  describe('Given a path with local modifications (working tree differs from index)', () => {
    describe('When rm without an override', () => {
      it('Then it refuses with RM_LOCAL_MODIFICATIONS and removes nothing', async () => {
        // Arrange
        const ctx = await seedLocal();

        // Act
        const err = await expectError(() => rm(ctx, ['a.txt']), 'RM_LOCAL_MODIFICATIONS');

        // Assert
        if (err.data.code !== 'RM_LOCAL_MODIFICATIONS') throw new Error('unexpected error shape');
        expect(err.data.paths).toEqual(['a.txt']);
        expect(err.message).toContain('local modifications');
        expect(await ctx.fs.exists(work(ctx, 'a.txt'))).toBe(true);
        const index = await readIndex(ctx);
        expect(index.entries.map((e) => e.path)).toContain('a.txt');
      });
    });

    describe('When rm --cached', () => {
      it('Then --cached suppresses the local valve and drops the index entry', async () => {
        // Arrange
        const ctx = await seedLocal();

        // Act
        const sut = await rm(ctx, ['a.txt'], { cached: true });

        // Assert
        expect(sut.removed).toEqual(['a.txt']);
        expect(await ctx.fs.exists(work(ctx, 'a.txt'))).toBe(true);
      });
    });
  });

  describe('Given a path with both staged and local changes', () => {
    describe('When rm without an override', () => {
      it('Then it refuses with RM_STAGED_AND_LOCAL_CHANGES and removes nothing', async () => {
        // Arrange
        const ctx = await seedBoth();

        // Act
        const err = await expectError(() => rm(ctx, ['a.txt']), 'RM_STAGED_AND_LOCAL_CHANGES');

        // Assert
        if (err.data.code !== 'RM_STAGED_AND_LOCAL_CHANGES') {
          throw new Error('unexpected error shape');
        }
        expect(err.data.paths).toEqual(['a.txt']);
        expect(err.message).toContain('staged content different from both');
        expect(await ctx.fs.exists(work(ctx, 'a.txt'))).toBe(true);
      });
    });

    describe('When rm --cached', () => {
      it('Then --cached does NOT suppress the both-valve (git requires -f)', async () => {
        // Arrange
        const ctx = await seedBoth();

        // Act / Assert — unlike the staged-only and local-only cases, --cached
        // still refuses when a path is dirty in both index and working tree.
        const err = await expectError(
          () => rm(ctx, ['a.txt'], { cached: true }),
          'RM_STAGED_AND_LOCAL_CHANGES',
        );
        if (err.data.code !== 'RM_STAGED_AND_LOCAL_CHANGES') {
          throw new Error('unexpected error shape');
        }
        expect(err.data.paths).toEqual(['a.txt']);
      });
    });

    describe('When rm --force', () => {
      it('Then force removes it', async () => {
        // Arrange
        const ctx = await seedBoth();

        // Act
        const sut = await rm(ctx, ['a.txt'], { force: true });

        // Assert
        expect(sut.removed).toEqual(['a.txt']);
        expect(await ctx.fs.exists(work(ctx, 'a.txt'))).toBe(false);
      });
    });
  });

  describe('Given a staged-but-never-committed file (unborn HEAD)', () => {
    describe('When rm without an override', () => {
      it('Then it refuses with RM_STAGED_CHANGES (the path is absent from HEAD)', async () => {
        // Arrange — staged, never committed: index has the entry, HEAD has nothing.
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'a.txt': 'a' } });
        await add(ctx, ['a.txt']);

        // Act
        const err = await expectError(() => rm(ctx, ['a.txt']), 'RM_STAGED_CHANGES');

        // Assert
        if (err.data.code !== 'RM_STAGED_CHANGES') throw new Error('unexpected error shape');
        expect(err.data.paths).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a clean committed file whose working copy was deleted', () => {
    describe('When rm', () => {
      it('Then an absent working file skips the valve and the index entry is removed', async () => {
        // Arrange — committed clean, then the working file is deleted. The valve
        // never refuses an absent file (the removal is what git wants).
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        await ctx.fs.rm(work(ctx, 'a.txt'));

        // Act
        const sut = await rm(ctx, ['a.txt'], { cached: true });

        // Assert
        expect(sut.removed).toEqual(['a.txt']);
      });
    });
  });

  describe('Given HEAD resolves to a non-commit object', () => {
    describe('When rm runs the safety valve', () => {
      it('Then it throws UNEXPECTED_OBJECT_TYPE expected=commit', async () => {
        // Arrange — detach HEAD onto a blob oid, then stage a file so the valve
        // reads HEAD's tree and finds a non-commit there.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const blobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('not-a-commit'),
          id: '' as ObjectId,
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${blobId}\n`);
        await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'a');
        await add(ctx, ['a.txt']);

        // Act
        const err = await expectError(() => rm(ctx, ['a.txt']), 'UNEXPECTED_OBJECT_TYPE');

        // Assert
        if (err.data.code !== 'UNEXPECTED_OBJECT_TYPE') throw new Error('unexpected error shape');
        expect(err.data.expected).toBe('commit');
      });
    });
  });

  describe('Given resolving HEAD throws a non-REF_NOT_FOUND error (a ref cycle)', () => {
    describe('When rm runs the safety valve', () => {
      it('Then the error propagates rather than being swallowed as an unborn HEAD', async () => {
        // Arrange — a tracked file plus a HEAD → main → loop → main symref cycle, so
        // resolveRef('HEAD') throws REF_CYCLE_DETECTED (not REF_NOT_FOUND). The valve
        // must re-throw it, not treat it as an unborn HEAD.
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'a.txt': 'a' } });
        await add(ctx, ['a.txt']);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, 'ref: refs/heads/loop\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/loop`, 'ref: refs/heads/main\n');

        // Act
        const err = await expectError(() => rm(ctx, ['a.txt']), 'REF_CYCLE_DETECTED');

        // Assert — kills the catch's `{}` body and `true` condition mutants, which
        // would swallow the cycle error and mis-classify the file as staged.
        expect(err.data.code).toBe('REF_CYCLE_DETECTED');
      });
    });
  });

  describe('Given two paths refused as staged-only and local-only (no both)', () => {
    describe('When rm without an override', () => {
      it('Then staged-only takes precedence over local-only', async () => {
        // Arrange — `staged.txt` is staged-only; `local.txt` is local-only.
        const ctx = await seedAndStage({ 'staged.txt': 's1\n', 'local.txt': 'l1\n' });
        await ctx.fs.writeUtf8(work(ctx, 'staged.txt'), 's2\n');
        await add(ctx, ['staged.txt']);
        await ctx.fs.writeUtf8(work(ctx, 'local.txt'), 'l2\n');

        // Act — precedence is staged → local, so the staged refusal surfaces.
        const err = await expectError(() => rm(ctx, ['*.txt']), 'RM_STAGED_CHANGES');

        // Assert
        if (err.data.code !== 'RM_STAGED_CHANGES') throw new Error('unexpected error shape');
        expect(err.data.paths).toEqual(['staged.txt']);
        expect(await ctx.fs.exists(work(ctx, 'staged.txt'))).toBe(true);
        expect(await ctx.fs.exists(work(ctx, 'local.txt'))).toBe(true);
      });
    });
  });

  describe('Given two paths refused in different categories (staged-only and both)', () => {
    describe('When rm without an override', () => {
      it('Then it throws by precedence (both wins) and removes nothing', async () => {
        // Arrange — `staged.txt` is staged-only; `both.txt` is staged + local.
        const ctx = await seedAndStage({ 'staged.txt': 's1\n', 'both.txt': 'b1\n' });
        await ctx.fs.writeUtf8(work(ctx, 'staged.txt'), 's2\n');
        await ctx.fs.writeUtf8(work(ctx, 'both.txt'), 'b2\n');
        await add(ctx, ['staged.txt', 'both.txt']);
        await ctx.fs.writeUtf8(work(ctx, 'both.txt'), 'b3\n');

        // Act — the strongest required override (both → -f only) surfaces first.
        const err = await expectError(() => rm(ctx, ['*.txt']), 'RM_STAGED_AND_LOCAL_CHANGES');

        // Assert — nothing removed; both files still present.
        if (err.data.code !== 'RM_STAGED_AND_LOCAL_CHANGES') {
          throw new Error('unexpected error shape');
        }
        expect(err.data.paths).toEqual(['both.txt']);
        expect(await ctx.fs.exists(work(ctx, 'staged.txt'))).toBe(true);
        expect(await ctx.fs.exists(work(ctx, 'both.txt'))).toBe(true);
      });
    });
  });
});
