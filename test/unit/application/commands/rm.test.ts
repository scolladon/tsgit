import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { rm } from '../../../../src/application/commands/rm.js';
import { indexEntryFromStat } from '../../../../src/application/primitives/internal/index-entry-from-stat.js';
import { acquireIndexLock } from '../../../../src/application/primitives/internal/index-lock.js';
import { deriveGitlinkContext } from '../../../../src/application/primitives/internal/submodule-context.js';
import {
  invalidateIndexCache,
  readIndex,
} from '../../../../src/application/primitives/read-index.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  rmLocalModifications,
  rmRecursiveWithoutR,
} from '../../../../src/domain/commands/error.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index.js';
import { parseResolveUndo } from '../../../../src/domain/git-index/resolve-undo.js';
import {
  fileNotFound,
  pathspecNoMatch,
  permissionDenied,
  TsgitError,
} from '../../../../src/domain/index.js';
import type { AuthorIdentity, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../../../src/ports/command-runner.js';
import type { Context } from '../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';
import { indexExtensionsOf } from '../primitives/helpers/index-extensions.js';
import { seedIndex, stagesOf } from './add-index-fixtures.js';
import { asBareContext, seedRepo } from './fixtures.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const uppercase = (b: Uint8Array): Uint8Array => enc(dec(b).toUpperCase());

class FakeRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    return { exitCode: 0, stdout: uppercase(request.stdin ?? new Uint8Array(0)) };
  }
}

/**
 * Seeds a repo with a .gitattributes filter=myf mapping + [filter "myf"] config,
 * stages the CLEANED (uppercased) bytes via add+runner, commits HEAD so the file
 * is tracked — then re-writes the smudged (original) bytes to the working tree
 * to simulate a post-checkout smudged state.
 */
const seedFilterRepo = async (
  name: string,
  smudgedContent: string,
): Promise<{ ctx: Context; cleanedContent: string }> => {
  const runner = new FakeRunner();
  const baseCtx = createMemoryContext();
  await init(baseCtx);

  const ext = name.split('.').pop() ?? 'y';
  await baseCtx.fs.writeUtf8(`${baseCtx.layout.workDir}/.gitattributes`, `*.${ext} filter=myf\n`);
  const configPath = `${baseCtx.layout.gitDir}/config`;
  const existingConfig = await baseCtx.fs.readUtf8(configPath).catch(() => '');
  await baseCtx.fs.writeUtf8(
    configPath,
    `${existingConfig}\n[filter "myf"]\n\tclean = uppercase-clean\n\tsmudge = lowercase-smudge\n`,
  );

  const ctxWithRunner: Context = { ...baseCtx, command: runner };

  // Stage and commit the file so it's tracked (HEAD matches index)
  await ctxWithRunner.fs.writeUtf8(`${baseCtx.layout.workDir}/${name}`, smudgedContent);
  await add(ctxWithRunner, [name]);
  await commit(ctxWithRunner, {
    message: 'seed',
    author: {
      name: 'Ada',
      email: 'ada@example.com',
      timestamp: 1_700_000_000,
      timezoneOffset: '+0000',
    },
  });

  // Simulate post-checkout: working tree holds smudged bytes again
  await ctxWithRunner.fs.writeUtf8(`${baseCtx.layout.workDir}/${name}`, smudgedContent);

  const cleanedContent = dec(uppercase(enc(smudgedContent)));
  return { ctx: ctxWithRunner, cleanedContent };
};

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

describe('Given a tracked file and a pathspec spelled with a `./` component', () => {
  describe('When rm names an untracked path', () => {
    it('Then PATHSPEC_NO_MATCH names the pathspec as spelled', async () => {
      // Arrange
      const ctx = await seedAndStage({ 'a.txt': 'a' });
      const sut = rm;

      // Act
      const err = await expectError(() => sut(ctx, ['./nomatch']), 'PATHSPEC_NO_MATCH');

      // Assert
      expect(err.data).toEqual(pathspecNoMatch('./nomatch').data);
    });
  });
});

describe('Given a tracked directory d holding d/a and d/b', () => {
  const seedDirectory = (): Promise<Context> =>
    seedAndStage({ 'd/a': 'a\n', 'd/b': 'b\n', 'top.txt': 't\n' });
  const trackedPaths = async (ctx: Context): Promise<ReadonlyArray<string>> =>
    (await readIndex(ctx)).entries.map((e) => e.path);

  describe.each([
    ['d', 'd'],
    ['d/', 'd/'],
    ['./d', './d'],
    ['.', '.'],
  ])('When rm names %s without recursive', (pathspec, spelled) => {
    it('Then it refuses with RM_RECURSIVE_WITHOUT_R naming the pathspec and removes nothing', async () => {
      // Arrange
      const ctx = await seedDirectory();
      const sut = rm;

      // Act
      const err = await expectError(() => sut(ctx, [pathspec]), 'RM_RECURSIVE_WITHOUT_R');

      // Assert
      expect(err.data).toEqual({ code: 'RM_RECURSIVE_WITHOUT_R', pattern: spelled });
      expect(err.message).toContain(`not removing '${spelled}' recursively without -r`);
      expect(await trackedPaths(ctx)).toEqual(['d/a', 'd/b', 'top.txt']);
      expect(await ctx.fs.exists(work(ctx, 'd/a'))).toBe(true);
    });
  });

  describe('When rm names a file and the directory without recursive', () => {
    it('Then the directory pathspec is refused and the file is kept', async () => {
      // Arrange
      const ctx = await seedDirectory();
      const sut = rm;

      // Act
      const err = await expectError(() => sut(ctx, ['top.txt', 'd']), 'RM_RECURSIVE_WITHOUT_R');

      // Assert
      expect(err.data).toEqual({ code: 'RM_RECURSIVE_WITHOUT_R', pattern: 'd' });
      expect(await trackedPaths(ctx)).toEqual(['d/a', 'd/b', 'top.txt']);
    });
  });

  describe('When rm names the directory then an unmatched path without recursive', () => {
    it('Then the directory refusal comes first, as git checks pathspecs in order', async () => {
      // Arrange
      const ctx = await seedDirectory();
      const sut = rm;

      // Act
      const err = await expectError(() => sut(ctx, ['d', 'nomatch']), 'RM_RECURSIVE_WITHOUT_R');

      // Assert
      expect(err.data).toEqual({ code: 'RM_RECURSIVE_WITHOUT_R', pattern: 'd' });
    });
  });

  describe('When rm names the directory with recursive', () => {
    it('Then both files leave the index and the working tree', async () => {
      // Arrange
      const ctx = await seedDirectory();
      const sut = rm;

      // Act
      const result = await sut(ctx, ['d'], { recursive: true });

      // Assert
      expect(result.removed).toEqual(['d/a', 'd/b']);
      expect(await trackedPaths(ctx)).toEqual(['top.txt']);
      expect(await ctx.fs.exists(work(ctx, 'd/b'))).toBe(false);
    });
  });

  describe('When rm names the directory with recursive explicitly false', () => {
    it('Then it refuses like the default', async () => {
      // Arrange
      const ctx = await seedDirectory();
      const sut = rm;

      // Act
      const err = await expectError(
        () => sut(ctx, ['d'], { recursive: false }),
        'RM_RECURSIVE_WITHOUT_R',
      );

      // Assert
      expect(err.data).toEqual({ code: 'RM_RECURSIVE_WITHOUT_R', pattern: 'd' });
    });
  });

  describe('When rm names a glob reaching into the directory without recursive', () => {
    it('Then the glob removes its matches, as git does for an fnmatch', async () => {
      // Arrange
      const ctx = await seedDirectory();
      const sut = rm;

      // Act
      const result = await sut(ctx, ['d/*']);

      // Assert
      expect(result.removed).toEqual(['d/a', 'd/b']);
    });
  });
});

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

        // Act + Assert
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
        const result = await rm(ctx, ['a.txt']);

        // Assert
        expect(result.removed).toEqual(['a.txt']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(false);
      });
    });
  });

  describe('Given a tracked file that is the last one in its directory', () => {
    describe('When rm', () => {
      it('Then the emptied directory is removed and a non-empty sibling directory stays', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/e/q': 'q', 'k/a': 'a', 'k/b': 'b' });

        // Act
        await rm(ctx, ['d/e/q', 'k/a']);

        // Assert
        expect(await ctx.fs.exists(work(ctx, 'd'))).toBe(false);
        expect(await ctx.fs.exists(work(ctx, 'k/b'))).toBe(true);
      });
    });
  });

  describe('Given a tracked file whose directory keeps another tracked file', () => {
    describe('When rm', () => {
      it('Then only the file is removed and the directory stays', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/q': 'q', 'd/kept': 'k' });

        // Act
        await rm(ctx, ['d/q']);

        // Assert
        expect(await ctx.fs.exists(work(ctx, 'd/q'))).toBe(false);
        expect(await ctx.fs.exists(work(ctx, 'd/kept'))).toBe(true);
      });
    });
  });

  describe('Given a tracked file whose directory keeps a tracked entry already gone from disk', () => {
    describe('When rm', () => {
      it('Then the emptied directory is removed', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/a': 'a', 'd/b': 'b' });
        await ctx.fs.rm(work(ctx, 'd/b'));

        // Act
        await rm(ctx, ['d/a']);

        // Assert
        expect(await ctx.fs.exists(work(ctx, 'd'))).toBe(false);
      });
    });
  });

  describe('Given a tracked file whose directory keeps only a skip-worktree entry', () => {
    describe('When rm', () => {
      it('Then the directory is removed, as nothing of it is on disk', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/q': 'q', 'd/sparse': 's' });
        const lock = await acquireIndexLock(ctx);
        const { entries } = await readIndex(ctx);
        await lock.commit(
          entries.map((entry) =>
            entry.path === 'd/sparse'
              ? { ...entry, flags: { ...entry.flags, skipWorktree: true } }
              : entry,
          ),
          'replace',
        );
        await lock.release();
        await ctx.fs.rm(work(ctx, 'd/sparse'));

        // Act
        await rm(ctx, ['d/q']);

        // Assert
        expect(await ctx.fs.exists(work(ctx, 'd'))).toBe(false);
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

        // Act + Assert
        await expectError(() => rm(ctx, ['ghost.txt']), 'PATHSPEC_NO_MATCH');
      });
    });
  });

  describe('Given a glob "*.log" with two matching tracked files', () => {
    describe('When rm', () => {
      it('Then both are removed', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.log': 'a', 'b.log': 'b', 'keep.ts': 'k' });

        // Act
        const result = await rm(ctx, ['*.log']);

        // Assert
        expect([...result.removed].sort()).toEqual(['a.log', 'b.log']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/keep.ts`)).toBe(true);
      });
    });
  });

  describe('Given a glob "*.nope" with no matches', () => {
    describe('When rm', () => {
      it('Then it refuses PATHSPEC_NO_MATCH naming the glob', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        const sut = rm;

        // Act
        const err = await expectError(() => sut(ctx, ['*.nope']), 'PATHSPEC_NO_MATCH');

        // Assert
        expect(err.data).toEqual(pathspecNoMatch('*.nope').data);
      });
    });
  });

  describe.each([
    ['nomatch*', 'tracked.txt'],
    ['tracked.txt', 'nomatch*'],
  ])('Given the pathspecs %j then %j and only tracked.txt tracked', (first, second) => {
    describe('When rm', () => {
      it('Then the unmatched glob refuses and tracked.txt stays indexed and on disk', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'tracked.txt': 't' });
        const sut = rm;

        // Act
        const err = await expectError(() => sut(ctx, [first, second]), 'PATHSPEC_NO_MATCH');

        // Assert
        expect(err.data).toEqual(pathspecNoMatch('nomatch*').data);
        expect((await readIndex(ctx)).entries.map((e) => e.path)).toEqual(['tracked.txt']);
        expect(await ctx.fs.exists(work(ctx, 'tracked.txt'))).toBe(true);
      });
    });
  });

  describe('Given a tracked a?/f and zz', () => {
    describe('When rm names the glob a? without recursive', () => {
      it('Then it refuses RM_RECURSIVE_WITHOUT_R and removes nothing', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a?/f': 'f', zz: 'z' });
        const sut = rm;

        // Act
        const err = await expectError(() => sut(ctx, ['a?']), 'RM_RECURSIVE_WITHOUT_R');

        // Assert
        expect(err.data).toEqual(rmRecursiveWithoutR('a?').data);
        expect((await readIndex(ctx)).entries.map((e) => e.path)).toEqual(['a?/f', 'zz']);
      });
    });

    describe('When rm names the glob a? with recursive', () => {
      it('Then it removes a?/f only', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a?/f': 'f', zz: 'z' });
        const sut = rm;

        // Act
        const result = await sut(ctx, ['a?'], { recursive: true });

        // Assert
        expect(result.removed).toEqual(['a?/f']);
      });
    });
  });

  describe('Given a tracked a?/f and ab', () => {
    describe('When rm names the glob a? without recursive', () => {
      it('Then the wildcard match outranks the directory and both a?/f and ab are removed', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a?/f': 'f', ab: 'b' });
        const sut = rm;

        // Act
        const result = await sut(ctx, ['a?']);

        // Assert
        expect([...result.removed].sort()).toEqual(['a?/f', 'ab']);
      });
    });
  });

  describe('Given a glob + a `!`-negation', () => {
    describe('When rm', () => {
      it('Then negated paths stay in the index', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.log': 'a', 'keep.log': 'k', 'b.log': 'b' });

        // Act
        const result = await rm(ctx, ['*.log', '!keep.log']);

        // Assert
        expect([...result.removed].sort()).toEqual(['a.log', 'b.log']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/keep.log`)).toBe(true);
      });
    });
  });

  describe('Given a bare repo', () => {
    describe('When rm', () => {
      it('Then throws WORK_TREE_REQUIRED tagged with operation "rm"', async () => {
        // Arrange — fresh ctx with no work tree, seeded BEFORE any read.
        const ctx0 = createMemoryContext();
        await seedRepo(ctx0, {});
        const ctx = asBareContext(ctx0);

        // Act
        const err = await expectError(() => rm(ctx, ['a.txt']), 'WORK_TREE_REQUIRED');

        // Assert — the operation label travels with the error (kills `'rm'` -> `''`).
        if (err.data.code !== 'WORK_TREE_REQUIRED') throw new Error('unexpected error shape');
        expect(err.data.operation).toBe('rm');
        expect(err.message).toBe('WORK_TREE_REQUIRED: operation requires a working tree: rm');
      });
    });
  });

  describe('Given a corrupt index (INVALID_INDEX_HEADER) and a glob', () => {
    describe('When rm', () => {
      it('Then the parse error is tolerated and the glob refuses as unmatched', async () => {
        // Arrange — an index file shorter than the hash trailer makes readIndex
        // throw INVALID_INDEX_HEADER. rm tolerates it via INDEX_MISSING_CODES.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, new Uint8Array([1, 2, 3]));

        // Act — the empty index leaves the glob unmatched; a surfaced parse error
        // would carry another code.
        const err = await expectError(() => rm(ctx, ['*.nope']), 'PATHSPEC_NO_MATCH');

        // Assert — kills `'INVALID_INDEX_HEADER'` -> `''` in INDEX_MISSING_CODES.
        expect(err.data).toEqual(pathspecNoMatch('*.nope').data);
      });
    });
  });

  describe('Given a corrupt index (INVALID_INDEX_ENTRY) and a glob', () => {
    describe('When rm', () => {
      it('Then the parse error is tolerated and the glob refuses as unmatched', async () => {
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
        const err = await expectError(() => rm(ctx, ['*.nope']), 'PATHSPEC_NO_MATCH');

        // Assert — kills `'INVALID_INDEX_ENTRY'` -> `''` in INDEX_MISSING_CODES.
        expect(err.data).toEqual(pathspecNoMatch('*.nope').data);
      });
    });
  });

  describe('Given readIndex stat racing to FILE_NOT_FOUND and a glob', () => {
    describe('When rm', () => {
      it('Then the error is tolerated and the glob refuses as unmatched', async () => {
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
        const err = await expectError(() => rm(racingCtx, ['*.nope']), 'PATHSPEC_NO_MATCH');

        // Assert — kills `'FILE_NOT_FOUND'` -> `''` in INDEX_MISSING_CODES.
        expect(err.data).toEqual(pathspecNoMatch('*.nope').data);
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

        // Act + Assert — kills the L52 ConditionalExpression mutants: a `true`
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
        const result = await rm(racingCtx, ['a.txt']);

        // Assert — index entry still removed; kills L68 BlockStatement (an empty
        // catch would swallow everything) and L69 ConditionalExpression `-> false`
        // (which would re-throw FILE_NOT_FOUND).
        expect(result.removed).toEqual(['a.txt']);
      });
    });
  });

  describe('Given cached=false and a tracked file already deleted from the working tree', () => {
    describe('When rm', () => {
      it('Then the index entry is removed, as git does', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'a.txt': 'a' } });
        await add(ctx, ['a.txt']);
        await ctx.fs.rm(`${ctx.layout.workDir}/a.txt`);

        // Act
        const result = await rm(ctx, ['a.txt']);

        // Assert
        expect(result.removed).toEqual(['a.txt']);
        const index = await readIndex(ctx);
        expect(index.entries.map((e) => e.path)).not.toContain('a.txt');
      });
    });
  });

  describe('Given cached=false and a working file whose lstat is denied', () => {
    describe('When rm', () => {
      it('Then the error propagates', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'a.txt': 'a' } });
        await add(ctx, ['a.txt']);
        const target = `${ctx.layout.workDir}/a.txt`;
        const deniedCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: async (path: string) => {
              if (path === target) throw permissionDenied(path);
              return ctx.fs.lstat(path);
            },
          },
        };

        // Act + Assert — the catch must re-throw any non-FILE_NOT_FOUND error.
        // Kills the `===` -> `!==` and `-> true` mutants of the catch condition.
        const err = await expectError(() => rm(deniedCtx, ['a.txt']), 'CHECKOUT_OVERWRITE_DIRTY');
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
        const result = await rm(staleCtx, ['a.txt']);

        // Assert — the policy reached acquireIndexLock; the stale lock was broken.
        expect(result.removed).toEqual(['a.txt']);
      });
    });
  });

  describe('Given no config.breakStaleLockMs and a held lock', () => {
    describe('When rm', () => {
      it('Then it surfaces RESOURCE_LOCKED', async () => {
        // Arrange — pre-create index.lock with no breakStaleLockMs option.
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        await ctx.fs.writeExclusive(`${ctx.layout.gitDir}/index.lock`, new Uint8Array());

        // Act + Assert — baseline: without the option a contended lock is fatal.
        const err = await expectError(() => rm(ctx, ['a.txt']), 'RESOURCE_LOCKED');
        if (err.data.code !== 'RESOURCE_LOCKED') throw new Error('unexpected error shape');
        expect(err.data.resource).toBe('index');
      });
    });
  });

  describe('Given a held lock and a glob that matches nothing', () => {
    describe('When rm names the glob', () => {
      it('Then the lock refusal wins over the no-match refusal and the lock is kept', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        const lockPath = `${ctx.layout.gitDir}/index.lock`;
        const held = new Uint8Array([0x68]);
        await ctx.fs.writeExclusive(lockPath, held);
        const sut = rm;

        // Act
        const err = await expectError(() => sut(ctx, ['nomatch*']), 'RESOURCE_LOCKED');

        // Assert
        if (err.data.code !== 'RESOURCE_LOCKED') throw new Error('unexpected error shape');
        expect(err.data.resource).toBe('index');
        expect(await ctx.fs.read(lockPath)).toEqual(held);
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
        const result = await rm(ctx, ['b.txt']);

        // Assert — the lock file is gone after a successful rm.
        expect(result.removed).toEqual(['b.txt']);
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
        const result = await rm(ctx, ['b.txt']);
        expect(result.removed).toEqual(['b.txt']);
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
        const result = await rm(ctx, ['a.txt'], { cached: true });

        // Assert — index entry gone, working file kept (git rm --cached semantics).
        expect(result.removed).toEqual(['a.txt']);
        expect(await ctx.fs.exists(work(ctx, 'a.txt'))).toBe(true);
      });
    });

    describe('When rm --force', () => {
      it('Then force suppresses the valve and removes index entry and working file', async () => {
        // Arrange
        const ctx = await seedStaged();

        // Act
        const result = await rm(ctx, ['a.txt'], { force: true });

        // Assert
        expect(result.removed).toEqual(['a.txt']);
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
        const result = await rm(ctx, ['a.txt'], { cached: true });

        // Assert
        expect(result.removed).toEqual(['a.txt']);
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

        // Act + Assert — unlike the staged-only and local-only cases, --cached
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
        const result = await rm(ctx, ['a.txt'], { force: true });

        // Assert
        expect(result.removed).toEqual(['a.txt']);
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
        const result = await rm(ctx, ['a.txt'], { cached: true });

        // Assert
        expect(result.removed).toEqual(['a.txt']);
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

// ── Filter-aware safety valve ──────────────────────────────────────────────

describe('rm safety valve — clean filter re-application', () => {
  describe('Given a smudged-unmodified file under an active filter=myf and a command runner', () => {
    describe('When rm is called on the file (no force)', () => {
      it('Then the file is removed (safety valve treats it as unchanged, not locally modified)', async () => {
        // Arrange — seed with cleaned OID in HEAD; worktree holds smudged bytes
        const { ctx } = await seedFilterRepo('filtered.y', 'hello world\n');

        // Act — safety valve must NOT refuse; file should be removed
        const result = await rm(ctx, ['filtered.y']);

        // Assert — removed successfully; working file deleted from disk
        expect(result.removed).toEqual(['filtered.y']);
        expect(await ctx.fs.exists(work(ctx, 'filtered.y'))).toBe(false);
      });
    });
  });

  describe('Given a smudged-unmodified file under an active filter=myf but ctx.command is absent', () => {
    describe('When rm is called on the file (no force, no runner)', () => {
      it('Then rm refuses with RM_LOCAL_MODIFICATIONS (raw bytes differ from cleaned OID — regression guard)', async () => {
        // Arrange — build context WITHOUT command so raw-bytes path is taken
        const { ctx } = await seedFilterRepo('norun.y', 'hello world\n');
        const { command: _cmd, ...ctxWithoutCommand } = ctx;
        const noRunnerCtx: Context = ctxWithoutCommand;

        // Act — raw bytes differ from cleaned OID => spuriously modified => refuse
        let caught: unknown;
        try {
          await rm(noRunnerCtx, ['norun.y']);
        } catch (err) {
          caught = err;
        }

        // Assert — safety valve fires because raw path sees the smudged bytes as modified
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('RM_LOCAL_MODIFICATIONS');
      });
    });
  });
});

describe('rm stat cache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const SEED_MS = 1_700_000_000_000;

  describe('Given a stat-clean, non-racy tracked file', () => {
    describe('When rm classifies it', () => {
      it('Then the file is never read', async () => {
        // Arrange
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(SEED_MS);
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'a.txt': 'v1\n' } });
        vi.setSystemTime(SEED_MS + 2_000);
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'seed', author: AUTHOR });
        const path = work(ctx, 'a.txt');
        const originalRead = ctx.fs.read.bind(ctx.fs);
        const reads: string[] = [];
        const spiedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: (p, ...rest) => {
              reads.push(p);
              return originalRead(p, ...rest);
            },
          },
        };
        const sut = rm;

        // Act
        await sut(spiedCtx, ['a.txt']);

        // Assert
        expect(reads).not.toContain(path);
      });
    });
  });
});

const LOSSY_NAME_BYTES = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
const LOSSY_VIEW = '\uFFFD.txt' as FilePath;

describe('rm on an index holding entries whose decoded paths collide', () => {
  describe('Given z, U and L in the index', () => {
    describe('When rm --cached removes z', () => {
      it('Then U and L both survive and L keeps its raw path bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { z: 'z' } });
        const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/z`);
        const entryOf = async (path: FilePath, text: string): Promise<IndexEntry> => ({
          ...indexEntryFromStat(
            stat,
            FILE_MODE.REGULAR,
            await writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc(text) }),
            path,
          ),
          fileSize: 0,
        });
        const lossy: IndexEntry = {
          ...(await entryOf(LOSSY_VIEW, 'x')),
          pathBytes: LOSSY_NAME_BYTES,
        };
        const entries = [
          await entryOf('z' as FilePath, 'z'),
          await entryOf(LOSSY_VIEW, 'y'),
          lossy,
        ];
        await ctx.fs.write(
          `${ctx.layout.gitDir}/index`,
          await serializeIndexFixtureAsync(
            { version: 2, entries, extensions: [], trailerSha: new Uint8Array(0) },
            ctx,
          ),
        );
        const sut = rm;

        // Act
        const result = await sut(ctx, ['z'], { cached: true });

        // Assert
        expect(result.removed).toEqual(['z']);
        const index = await readIndex(ctx);
        expect(index.entries.map((e) => e.path)).toEqual([LOSSY_VIEW, LOSSY_VIEW]);
        expect(index.entries.map((e) => e.pathBytes)).toEqual([undefined, LOSSY_NAME_BYTES]);
      });
    });
  });
});

describe('rm of a directory holding a lossy entry beside a well-formed one', () => {
  const seedDirectory = async (): Promise<Context> => {
    const ctx = createMemoryContext();
    await seedRepo(ctx, { workingTree: { 'd/y': 'y' } });
    await ctx.fs.write(`${ctx.layout.workDir}/d/\uFFFD`, enc('twin'));
    const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/d/y`);
    const entryOf = async (path: string, text: string): Promise<IndexEntry> => ({
      ...indexEntryFromStat(
        stat,
        FILE_MODE.REGULAR,
        await writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc(text) }),
        path as FilePath,
      ),
      fileSize: 0,
    });
    const lossy: IndexEntry = {
      ...(await entryOf('d/\uFFFD', 'x')),
      pathBytes: Uint8Array.of(0x64, 0x2f, 0xff),
    };
    await ctx.fs.write(
      `${ctx.layout.gitDir}/index`,
      await serializeIndexFixtureAsync(
        {
          version: 2,
          entries: [await entryOf('d/y', 'y'), lossy],
          extensions: [],
          trailerSha: new Uint8Array(0),
        },
        ctx,
      ),
    );
    return ctx;
  };

  describe('Given d/y, a lossy d/\\xff and an untracked file at d/\uFFFD', () => {
    describe('When rm removes d recursively with force', () => {
      it('Then both entries leave the index, d/y is unlinked and d/\uFFFD stays', async () => {
        // Arrange
        const ctx = await seedDirectory();
        const sut = rm;

        // Act
        await sut(ctx, ['d'], { recursive: true, force: true });

        // Assert
        expect((await readIndex(ctx)).entries).toEqual([]);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/d/y`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/d/\uFFFD`)).toBe(true);
      });
    });
  });

  describe('Given d/y and a lossy d/\\xff', () => {
    describe('When rm removes d recursively with cached', () => {
      it('Then both entries leave the index and nothing is unlinked', async () => {
        // Arrange
        const ctx = await seedDirectory();
        const sut = rm;

        // Act
        await sut(ctx, ['d'], { recursive: true, cached: true });

        // Assert
        expect((await readIndex(ctx)).entries).toEqual([]);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/d/y`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/d/\uFFFD`)).toBe(true);
      });
    });
  });
});

describe('rm pathspec matching against an index holding U and its lossy twin L', () => {
  const seedTwins = async (): Promise<Context> => {
    const ctx = createMemoryContext();
    await seedRepo(ctx, { workingTree: { z: 'z' } });
    const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/z`);
    const entryOf = async (path: FilePath, text: string): Promise<IndexEntry> => ({
      ...indexEntryFromStat(
        stat,
        FILE_MODE.REGULAR,
        await writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc(text) }),
        path,
      ),
      fileSize: 0,
    });
    const lossy: IndexEntry = {
      ...(await entryOf(LOSSY_VIEW, 'x')),
      pathBytes: LOSSY_NAME_BYTES,
    };
    await ctx.fs.write(
      `${ctx.layout.gitDir}/index`,
      await serializeIndexFixtureAsync(
        {
          version: 2,
          entries: [await entryOf(LOSSY_VIEW, 'y'), lossy],
          extensions: [],
          trailerSha: new Uint8Array(0),
        },
        ctx,
      ),
    );
    return ctx;
  };

  describe.each([
    ['a U+FFFD literal', '�.txt'],
    ['a lone-surrogate literal', '\uDCFF.txt'],
  ])('Given %s naming the UTF-8 twin', (_title, spelling) => {
    describe('When rm --cached runs', () => {
      it('Then only the twin leaves the index and L keeps its raw bytes', async () => {
        // Arrange
        const ctx = await seedTwins();
        const sut = rm;

        // Act
        const result = await sut(ctx, [spelling], { cached: true, force: true });

        // Assert
        expect(result.removed).toEqual([LOSSY_VIEW]);
        const index = await readIndex(ctx);
        expect(index.entries.map((e) => e.pathBytes)).toEqual([LOSSY_NAME_BYTES]);
      });
    });
  });
});

describe('rm of a lossy entry and its U+FFFD twin both committed in HEAD', () => {
  const TWIN_BYTES = Uint8Array.of(0xef, 0xbf, 0xbd, 0x2e, 0x74, 0x78, 0x74);
  const committer: AuthorIdentity = {
    name: 'T',
    email: 't@x',
    timestamp: 1,
    timezoneOffset: '+0000',
  };

  const seedCommittedTwins = async (): Promise<Context> => {
    const ctx = createMemoryContext();
    await seedRepo(ctx, { workingTree: { z: 'z' } });
    await ctx.fs.write(`${ctx.layout.workDir}/${LOSSY_VIEW}`, enc('u'));
    const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/${LOSSY_VIEW}`);
    const blob = (text: string): Promise<ObjectId> =>
      writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc(text) });
    const lossyId = await blob('l');
    const twinId = await blob('u');
    const tree = await writeObject(ctx, {
      type: 'tree',
      id: '' as ObjectId,
      entries: [
        treeEntry(FILE_MODE.REGULAR, LOSSY_NAME_BYTES, lossyId),
        treeEntry(FILE_MODE.REGULAR, TWIN_BYTES, twinId),
      ],
    });
    const commitId = await writeObject(ctx, {
      type: 'commit',
      id: '' as ObjectId,
      data: {
        tree,
        parents: [],
        author: committer,
        committer,
        message: 'seed',
        extraHeaders: [],
      },
    });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
    const twin: IndexEntry = {
      ...indexEntryFromStat(stat, FILE_MODE.REGULAR, twinId, LOSSY_VIEW),
      fileSize: 1,
    };
    const lossy: IndexEntry = {
      ...indexEntryFromStat(stat, FILE_MODE.REGULAR, lossyId, LOSSY_VIEW),
      fileSize: 1,
      pathBytes: LOSSY_NAME_BYTES,
    };
    await ctx.fs.write(
      `${ctx.layout.gitDir}/index`,
      await serializeIndexFixtureAsync(
        {
          version: 2,
          entries: [twin, lossy],
          extensions: [],
          trailerSha: new Uint8Array(0),
        },
        ctx,
      ),
    );
    return ctx;
  };

  describe('Given both entries unchanged against HEAD and the twin clean on disk', () => {
    describe('When rm runs on a star pathspec', () => {
      it('Then both entries leave the index and only the twin is unlinked', async () => {
        // Arrange
        const ctx = await seedCommittedTwins();
        const sut = rm;

        // Act
        await sut(ctx, ['*.txt']);

        // Assert
        expect((await readIndex(ctx)).entries).toEqual([]);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/${LOSSY_VIEW}`)).toBe(false);
      });
    });
  });
});

const SHA1_DIGEST = 20;

const CONFLICT_ROWS = [
  { path: 'a/f', text: 'f-base', stage: 1 },
  { path: 'a/f', text: 'f-ours', stage: 2 },
  { path: 'a/f', text: 'f-theirs', stage: 3 },
] as const;

const seedMergeConflict = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree: { 'a/f': 'merged', b: 'b' } });
  await seedIndex(ctx, [...CONFLICT_ROWS, { path: 'b', text: 'b' }]);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'a'.repeat(40)}\n`);
  return ctx;
};

const recordedStages = async (
  ctx: Context,
): Promise<ReadonlyArray<readonly [string, ReadonlyArray<number>]>> => {
  const reuc = (await indexExtensionsOf(ctx)).get('REUC');
  if (reuc === undefined) return [];
  const records = parseResolveUndo(reuc, SHA1_DIGEST) ?? [];
  return records.map((record) => [record.path, record.stages.map(({ stage }) => stage)]);
};

describe('Given an unrelated conflicted path c and a clean b', () => {
  describe('When rm removes b', () => {
    it('Then the three stages of c survive', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, { workingTree: { b: 'b', c: 'merged' } });
      await seedIndex(ctx, [
        { path: 'b', text: 'b' },
        { path: 'c', text: 'c-base', stage: 1 },
        { path: 'c', text: 'c-ours', stage: 2 },
        { path: 'c', text: 'c-theirs', stage: 3 },
      ]);
      const before = (await stagesOf(ctx)).filter((line) => line.startsWith('c@'));
      const sut = rm;

      // Act
      await sut(ctx, ['b'], { force: true });
      const result = await stagesOf(ctx);

      // Assert
      expect(before).toHaveLength(3);
      expect(result).toEqual(before);
    });
  });
});

describe('Given a merge stopped on a conflicted a/f', () => {
  describe.each([
    { title: 'rm', opts: {} },
    { title: 'rm --cached', opts: { cached: true } },
  ])('When $title removes a/f', ({ opts }) => {
    it('Then a/f leaves the index and REUC records its stages 1, 2 and 3', async () => {
      // Arrange
      const ctx = await seedMergeConflict();
      const sut = rm;

      // Act
      const result = await sut(ctx, ['a/f'], opts);

      // Assert
      expect(result.removed).toEqual(['a/f']);
      expect((await stagesOf(ctx)).map((line) => line.split(':')[0])).toEqual(['b@0']);
      expect(await recordedStages(ctx)).toEqual([['a/f', [1, 2, 3]]]);
    });
  });
});

describe('Given a merge stopped on a conflicted a/f and a merged b', () => {
  describe('When rm removes a/f and b together', () => {
    it('Then REUC records the stages of a/f only', async () => {
      // Arrange
      const ctx = await seedMergeConflict();
      const sut = rm;

      // Act
      const result = await sut(ctx, ['a/f', 'b'], { force: true });

      // Assert
      expect(result.removed).toEqual(['a/f', 'b']);
      expect(await recordedStages(ctx)).toEqual([['a/f', [1, 2, 3]]]);
    });
  });
});

describe('Given a tracked backslash-named file a\\b beside a tracked ab', () => {
  describe.each([
    { label: 'an escaped backslash', spec: 'a\\\\b' },
    { label: 'question marks', spec: 'a??' },
  ])('When rm force-removes it with $label', ({ spec }) => {
    it('Then only the backslash-named file leaves the index and the working tree', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, { workingTree: { 'a\\b': 'x\n', ab: 'y\n' } });
      await add(ctx, ['.']);
      await commit(ctx, { message: 'seed', author: AUTHOR });
      const sut = rm;

      // Act
      const result = await sut(ctx, [spec], { force: true });

      // Assert
      expect(result.removed).toEqual(['a\\b']);
      expect(await ctx.fs.exists(work(ctx, 'a\\b'))).toBe(false);
      expect(await ctx.fs.exists(work(ctx, 'ab'))).toBe(true);
      expect((await readIndex(ctx)).entries.map((e) => e.path)).toEqual(['ab']);
    });
  });
});

/** A committed superproject whose gitlink `sub` records the HEAD of a real, clean submodule holding `u`. */
const withCommittedSubmodule = async (): Promise<{ ctx: Context; child: Context }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(work(ctx, 'k'), 'k\n');
  await seedIndex(ctx, [{ path: 'k', text: 'k\n' }]);
  const child = deriveGitlinkContext(ctx, `${ctx.layout.gitDir}/modules/sub`, 'sub' as FilePath);
  await init(child);
  await ctx.fs.writeUtf8(work(ctx, 'sub/.git'), 'gitdir: ../.git/modules/sub\n');
  await ctx.fs.writeUtf8(work(ctx, 'sub/u'), 'u\n');
  await seedIndex(child, [{ path: 'u', text: 'u\n' }]);
  const { id } = await commit(child, { message: 'child', author: AUTHOR });
  await seedIndex(ctx, [
    { path: 'k', text: 'k\n' },
    { path: 'sub', text: 'recorded\n', mode: FILE_MODE.GITLINK },
  ]);
  const index = await readIndex(ctx);
  const entries = index.entries.map((e) => (e.path === 'sub' ? { ...e, id } : e));
  invalidateIndexCache(ctx);
  await ctx.fs.write(
    `${ctx.layout.gitDir}/index`,
    await serializeIndexFixtureAsync({ ...index, entries, extensions: [] }, ctx),
  );
  invalidateIndexCache(ctx);
  await commit(ctx, { message: 'record', author: AUTHOR });
  return { ctx, child };
};

describe('Given an unmoved submodule whose checkout has an edited tracked file', () => {
  describe('When rm names the submodule', () => {
    it('Then RM_LOCAL_MODIFICATIONS names it', async () => {
      // Arrange
      const { ctx } = await withCommittedSubmodule();
      await ctx.fs.writeUtf8(work(ctx, 'sub/u'), 'edited\n');
      const sut = rm;

      // Act
      const err = await expectError(() => sut(ctx, ['sub']), 'RM_LOCAL_MODIFICATIONS');

      // Assert
      expect(err.data).toEqual(rmLocalModifications(['sub' as FilePath]).data);
    });
  });
});

const emptySubmoduleDirectory = async (ctx: Context): Promise<void> => {
  await ctx.fs.rm(work(ctx, 'sub/.git'));
  await ctx.fs.rm(work(ctx, 'sub/u'));
  await ctx.fs.rm(work(ctx, 'sub'));
};

const GITMODULES_IGNORING_ALL = '[submodule "sub"]\n\tpath = sub\n\turl = ../up\n\tignore = all\n';
const OVERSIZED_GITFILE_BYTES = (1 << 20) + 1;

describe.each([
  {
    given: 'an untracked file in a submodule configured ignore = all',
    arrange: async (ctx: Context) => {
      await ctx.fs.writeUtf8(work(ctx, '.gitmodules'), GITMODULES_IGNORING_ALL);
      await ctx.fs.writeUtf8(work(ctx, 'sub/n'), 'n\n');
    },
  },
  {
    given: 'a submodule whose checkout moved off the recorded commit',
    arrange: async (ctx: Context, child: Context) => {
      await ctx.fs.writeUtf8(work(ctx, 'sub/v'), 'v\n');
      await seedIndex(child, [
        { path: 'u', text: 'u\n' },
        { path: 'v', text: 'v\n' },
      ]);
      await commit(child, { message: 'advance', author: AUTHOR });
    },
  },
  {
    given: 'a file in place of the submodule',
    arrange: async (ctx: Context) => {
      await emptySubmoduleDirectory(ctx);
      await ctx.fs.writeUtf8(work(ctx, 'sub'), 'plain\n');
    },
  },
])('Given $given', ({ arrange }) => {
  describe('When rm names the submodule', () => {
    it('Then RM_LOCAL_MODIFICATIONS names it', async () => {
      // Arrange
      const { ctx, child } = await withCommittedSubmodule();
      await arrange(ctx, child);
      const sut = rm;

      // Act
      const err = await expectError(() => sut(ctx, ['sub']), 'RM_LOCAL_MODIFICATIONS');

      // Assert
      expect(err.data).toEqual(rmLocalModifications(['sub' as FilePath]).data);
    });
  });
});

describe.each([
  {
    given: 'a submodule whose .git is a gitfile past the size git reads',
    gitfile: 'x'.repeat(OVERSIZED_GITFILE_BYTES),
    expected: { code: 'GITFILE_TOO_LARGE', path: 'sub/.git' },
  },
  {
    given: 'a submodule whose .git is a gitfile that is not a pointer',
    gitfile: 'garbage\n',
    expected: { code: 'NOT_A_REPOSITORY', path: 'sub/.git' },
  },
])('Given $given', ({ gitfile, expected }) => {
  describe('When rm names the submodule', () => {
    it('Then the dying gitfile reader refuses', async () => {
      // Arrange
      const { ctx } = await withCommittedSubmodule();
      await ctx.fs.writeUtf8(work(ctx, 'sub/.git'), gitfile);
      const sut = rm;

      // Act
      const err = await expectError(() => sut(ctx, ['sub']), expected.code);

      // Assert
      expect(err.data).toEqual(expected);
    });
  });
});

describe('Given a symlink in place of the submodule', () => {
  describe('When rm names the submodule', () => {
    it('Then SUBMODULE_PATH_IS_SYMLINK names it', async () => {
      // Arrange
      const { ctx } = await withCommittedSubmodule();
      await emptySubmoduleDirectory(ctx);
      await ctx.fs.symlink('k', work(ctx, 'sub'));
      const sut = rm;

      // Act
      const err = await expectError(() => sut(ctx, ['sub']), 'SUBMODULE_PATH_IS_SYMLINK');

      // Assert
      expect(err.data).toEqual({ code: 'SUBMODULE_PATH_IS_SYMLINK', path: 'sub' });
    });
  });
});

describe('Given an unmoved submodule whose checkout has an edited tracked file', () => {
  describe('When rm keeps the working tree with cached', () => {
    it('Then the gitlink leaves the index without a refusal', async () => {
      // Arrange
      const { ctx } = await withCommittedSubmodule();
      await ctx.fs.writeUtf8(work(ctx, 'sub/u'), 'edited\n');
      const sut = rm;

      // Act
      const result = await sut(ctx, ['sub'], { cached: true });

      // Assert
      expect(result.removed).toEqual(['sub']);
      expect((await readIndex(ctx)).entries.map((e) => e.path)).toEqual(['k']);
    });
  });
});

describe('Given a clean submodule whose checkout is a gitfile', () => {
  describe('When rm names the submodule', () => {
    it('Then the directory goes, the index forgets it and the absorbed module stays', async () => {
      // Arrange
      const { ctx } = await withCommittedSubmodule();
      const sut = rm;

      // Act
      const result = await sut(ctx, ['sub']);

      // Assert
      expect(result.removed).toEqual(['sub']);
      expect(await ctx.fs.exists(work(ctx, 'sub'))).toBe(false);
      expect((await readIndex(ctx)).entries.map((e) => e.path)).toEqual(['k']);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules/sub/HEAD`)).toBe(true);
    });
  });
});

describe('Given a submodule whose checkout moved off the recorded commit', () => {
  describe('When rm forces the removal', () => {
    it('Then the directory goes and the index forgets it', async () => {
      // Arrange
      const { ctx, child } = await withCommittedSubmodule();
      await ctx.fs.writeUtf8(work(ctx, 'sub/v'), 'v\n');
      await seedIndex(child, [
        { path: 'u', text: 'u\n' },
        { path: 'v', text: 'v\n' },
      ]);
      await commit(child, { message: 'advance', author: AUTHOR });
      const sut = rm;

      // Act
      const result = await sut(ctx, ['sub'], { force: true });

      // Assert
      expect(result.removed).toEqual(['sub']);
      expect(await ctx.fs.exists(work(ctx, 'sub'))).toBe(false);
      expect((await readIndex(ctx)).entries.map((e) => e.path)).toEqual(['k']);
    });
  });
});

describe('Given a submodule whose directory is absent from the work tree', () => {
  describe('When rm names the submodule', () => {
    it('Then the index forgets it without touching the disk', async () => {
      // Arrange
      const { ctx } = await withCommittedSubmodule();
      await emptySubmoduleDirectory(ctx);
      const sut = rm;

      // Act
      const result = await sut(ctx, ['sub']);

      // Assert
      expect(result.removed).toEqual(['sub']);
      expect((await readIndex(ctx)).entries.map((e) => e.path)).toEqual(['k']);
    });
  });
});

const GITMODULES_SUB = '[submodule "sub"]\n\tpath = sub\n\turl = ../up\n';
const GITMODULES_SUB2 = '[submodule "sub2"]\n\tpath = sub2\n\turl = ../up\n';

/** The committed submodule fixture with a staged `.gitmodules` holding `text`. */
const withStagedGitmodules = async (text: string): Promise<{ ctx: Context; child: Context }> => {
  const fixture = await withCommittedSubmodule();
  await fixture.ctx.fs.writeUtf8(work(fixture.ctx, '.gitmodules'), text);
  await add(fixture.ctx, ['.gitmodules']);
  return fixture;
};

const blobIdOf = (ctx: Context, text: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc(text) }) as Promise<ObjectId>;

const indexIdOf = async (ctx: Context, path: string): Promise<ObjectId | undefined> =>
  (await readIndex(ctx)).entries.find((e) => e.path === path)?.id;

describe('Given a clean submodule named in the staged .gitmodules', () => {
  describe('When rm names the submodule', () => {
    it('Then its section leaves .gitmodules and the new text is staged', async () => {
      // Arrange
      const { ctx } = await withStagedGitmodules(GITMODULES_SUB);
      const sut = rm;

      // Act
      await sut(ctx, ['sub']);

      // Assert
      const text = await ctx.fs.readUtf8(work(ctx, '.gitmodules'));
      expect(text).not.toContain('[submodule "sub"]');
      expect(await indexIdOf(ctx, '.gitmodules')).toBe(await blobIdOf(ctx, text));
    });
  });
});

describe('Given a clean submodule named in the staged .gitmodules', () => {
  describe('When rm keeps the working tree with cached', () => {
    it('Then .gitmodules, its index entry and the directory stay', async () => {
      // Arrange
      const { ctx } = await withStagedGitmodules(GITMODULES_SUB);
      const before = await indexIdOf(ctx, '.gitmodules');
      const sut = rm;

      // Act
      await sut(ctx, ['sub'], { cached: true });

      // Assert
      expect(await ctx.fs.readUtf8(work(ctx, '.gitmodules'))).toBe(GITMODULES_SUB);
      expect(await indexIdOf(ctx, '.gitmodules')).toBe(before);
      expect(await ctx.fs.exists(work(ctx, 'sub/u'))).toBe(true);
    });
  });
});

describe('Given two sections in the staged .gitmodules', () => {
  describe('When rm names the first submodule', () => {
    it('Then the other section survives byte for byte', async () => {
      // Arrange
      const { ctx } = await withStagedGitmodules(GITMODULES_SUB + GITMODULES_SUB2);
      const sut = rm;

      // Act
      await sut(ctx, ['sub']);

      // Assert
      expect(await ctx.fs.readUtf8(work(ctx, '.gitmodules'))).toBe(GITMODULES_SUB2);
    });
  });
});

describe('Given a staged .gitmodules with no section for the submodule', () => {
  describe('When rm names the submodule', () => {
    it('Then .gitmodules and its index entry are left alone', async () => {
      // Arrange
      const { ctx } = await withStagedGitmodules(GITMODULES_SUB2);
      const before = await indexIdOf(ctx, '.gitmodules');
      const sut = rm;

      // Act
      await sut(ctx, ['sub']);

      // Assert
      expect(await ctx.fs.readUtf8(work(ctx, '.gitmodules'))).toBe(GITMODULES_SUB2);
      expect(await indexIdOf(ctx, '.gitmodules')).toBe(before);
    });
  });
});

const GITMODULES_EDITED = `${GITMODULES_SUB}# unstaged\n`;

describe.each([
  { options: {}, label: 'default options' },
  { options: { cached: true }, label: 'cached' },
  { options: { force: true }, label: 'force' },
])('Given a .gitmodules edited after it was staged ($label)', ({ options }) => {
  describe('When rm names the submodule', () => {
    it('Then GITMODULES_NOT_STAGED refuses and nothing changes', async () => {
      // Arrange
      const { ctx } = await withStagedGitmodules(GITMODULES_SUB);
      await ctx.fs.writeUtf8(work(ctx, '.gitmodules'), GITMODULES_EDITED);
      const before = (await readIndex(ctx)).entries.map((e) => `${e.path}:${e.id}`);
      const sut = rm;

      // Act
      const err = await expectError(() => sut(ctx, ['sub'], options), 'GITMODULES_NOT_STAGED');

      // Assert
      expect(err.data).toEqual({ code: 'GITMODULES_NOT_STAGED' });
      expect(await ctx.fs.exists(work(ctx, 'sub/u'))).toBe(true);
      expect(await ctx.fs.readUtf8(work(ctx, '.gitmodules'))).toBe(GITMODULES_EDITED);
      expect((await readIndex(ctx)).entries.map((e) => `${e.path}:${e.id}`)).toEqual(before);
    });
  });
});

describe('Given a .gitmodules rewritten with the staged bytes', () => {
  describe('When rm names the submodule', () => {
    it('Then the removal proceeds and the section leaves', async () => {
      // Arrange
      const { ctx } = await withStagedGitmodules(GITMODULES_SUB);
      await ctx.fs.writeUtf8(work(ctx, '.gitmodules'), GITMODULES_SUB);
      const sut = rm;

      // Act
      const result = await sut(ctx, ['sub']);

      // Assert
      expect(result.removed).toEqual(['sub']);
      expect(await ctx.fs.readUtf8(work(ctx, '.gitmodules'))).toBe('');
    });
  });
});

describe('Given a .gitmodules deleted from the work tree after it was staged', () => {
  describe('When rm names the submodule', () => {
    it('Then the removal proceeds and stages nothing for .gitmodules', async () => {
      // Arrange
      const { ctx } = await withStagedGitmodules(GITMODULES_SUB);
      await ctx.fs.rm(work(ctx, '.gitmodules'));
      const before = await indexIdOf(ctx, '.gitmodules');
      const sut = rm;

      // Act
      const result = await sut(ctx, ['sub']);

      // Assert
      expect(result.removed).toEqual(['sub']);
      expect(await ctx.fs.exists(work(ctx, '.gitmodules'))).toBe(false);
      expect(await indexIdOf(ctx, '.gitmodules')).toBe(before);
    });
  });
});

/** Turn the fixture's gitfile submodule into one that carries its repository in `sub/.git`. */
const embedSubmoduleRepository = async (ctx: Context): Promise<void> => {
  await ctx.fs.rm(work(ctx, 'sub/.git'));
  await ctx.fs.rename(`${ctx.layout.gitDir}/modules/sub`, work(ctx, 'sub/.git'));
};

describe('Given a clean submodule that carries its repository in sub/.git', () => {
  describe('When rm names the submodule', () => {
    it('Then the repository moves to .git/modules/sub with core.worktree set', async () => {
      // Arrange
      const { ctx } = await withStagedGitmodules(GITMODULES_SUB);
      await embedSubmoduleRepository(ctx);
      const headBytes = await ctx.fs.readUtf8(work(ctx, 'sub/.git/HEAD'));
      const sut = rm;

      // Act
      await sut(ctx, ['sub']);

      // Assert
      expect(await ctx.fs.exists(work(ctx, 'sub'))).toBe(false);
      expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/sub/HEAD`)).toBe(headBytes);
      expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/sub/config`)).toContain(
        'worktree = ../../../sub',
      );
    });
  });
});

describe('Given an embedded repository whose .gitmodules name differs from its path', () => {
  describe('When rm names the submodule', () => {
    it('Then the repository lands under the name with a core.worktree that climbs to the path', async () => {
      // Arrange
      const { ctx } = await withStagedGitmodules(
        '[submodule "mod"]\n\tpath = sub\n\turl = ../up\n',
      );
      await ctx.fs.rename(`${ctx.layout.gitDir}/modules/sub`, `${ctx.layout.gitDir}/modules/mod`);
      await ctx.fs.rm(work(ctx, 'sub/.git'));
      await ctx.fs.rename(`${ctx.layout.gitDir}/modules/mod`, work(ctx, 'sub/.git'));
      const sut = rm;

      // Act
      await sut(ctx, ['sub']);

      // Assert
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules/mod/HEAD`)).toBe(true);
      expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/mod/config`)).toContain(
        'worktree = ../../../sub',
      );
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/modules/sub`)).toBe(false);
    });
  });
});

describe('Given an embedded repository and a populated .git/modules/<name>', () => {
  describe('When rm names the submodule', () => {
    it('Then DIRECTORY_NOT_EMPTY refuses and the embedded repository stays', async () => {
      // Arrange
      const { ctx } = await withStagedGitmodules(GITMODULES_SUB);
      await embedSubmoduleRepository(ctx);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/modules/sub/occupied`, 'x');
      const sut = rm;

      // Act
      const err = await expectError(() => sut(ctx, ['sub']), 'DIRECTORY_NOT_EMPTY');

      // Assert
      expect(err.data).toMatchObject({ code: 'DIRECTORY_NOT_EMPTY' });
      expect(await ctx.fs.exists(work(ctx, 'sub/.git/HEAD'))).toBe(true);
      expect((await readIndex(ctx)).entries.map((e) => e.path)).toContain('sub');
    });
  });
});

describe('Given a deinitialised submodule whose directory is empty', () => {
  describe('When rm names the submodule', () => {
    it('Then the empty directory goes with the index entry', async () => {
      // Arrange
      const { ctx } = await withCommittedSubmodule();
      await emptySubmoduleDirectory(ctx);
      await ctx.fs.mkdir(work(ctx, 'sub'));
      const sut = rm;

      // Act
      const result = await sut(ctx, ['sub']);

      // Assert
      expect(result.removed).toEqual(['sub']);
      expect(await ctx.fs.exists(work(ctx, 'sub'))).toBe(false);
    });
  });
});

const NAMELESS_REFUSAL_CODE = 'SUBMODULE_NAME_NOT_FOUND';

describe('Given an embedded repository whose path no .gitmodules row names', () => {
  describe('When rm names the submodule', () => {
    it('Then SUBMODULE_NAME_NOT_FOUND refuses and nothing changes', async () => {
      // Arrange
      const { ctx } = await withCommittedSubmodule();
      await embedSubmoduleRepository(ctx);
      const before = (await readIndex(ctx)).entries.map((e) => `${e.path}:${e.id}`);
      const sut = rm;

      // Act
      const err = await expectError(() => sut(ctx, ['sub']), NAMELESS_REFUSAL_CODE);

      // Assert
      expect(err.data).toEqual({ code: NAMELESS_REFUSAL_CODE, path: 'sub' });
      expect(await ctx.fs.exists(work(ctx, 'sub/.git/HEAD'))).toBe(true);
      expect(await ctx.fs.exists(work(ctx, '.gitmodules'))).toBe(false);
      expect((await readIndex(ctx)).entries.map((e) => `${e.path}:${e.id}`)).toEqual(before);
    });
  });
});

describe('Given an unnamed embedded repository', () => {
  describe('When rm keeps the working tree with cached', () => {
    it('Then the gitlink leaves the index without a refusal', async () => {
      // Arrange
      const { ctx } = await withCommittedSubmodule();
      await embedSubmoduleRepository(ctx);
      const sut = rm;

      // Act
      const result = await sut(ctx, ['sub'], { cached: true });

      // Assert
      expect(result.removed).toEqual(['sub']);
      expect(await ctx.fs.exists(work(ctx, 'sub/.git/HEAD'))).toBe(true);
    });
  });
});

describe('Given an embedded repository removed from a linked worktree', () => {
  describe('When rm names the submodule', () => {
    it('Then core.worktree climbs from the worktree admin directory to the worktree path', async () => {
      // Arrange
      const { ctx: main } = await withStagedGitmodules(GITMODULES_SUB);
      await embedSubmoduleRepository(main);
      const root = main.layout.workDir as string;
      const linkedDir = `${main.layout.gitDir}/worktrees/wt`;
      await main.fs.mkdir(linkedDir);
      await main.fs.mkdir(`${root}/wt`);
      await main.fs.write(`${linkedDir}/HEAD`, await main.fs.read(`${main.layout.gitDir}/HEAD`));
      await main.fs.write(`${linkedDir}/index`, await main.fs.read(`${main.layout.gitDir}/index`));
      await main.fs.write(`${root}/wt/.gitmodules`, await main.fs.read(`${root}/.gitmodules`));
      await main.fs.writeUtf8(`${linkedDir}/commondir`, '../..\n');
      await main.fs.writeUtf8(`${linkedDir}/gitdir`, `${root}/wt/.git\n`);
      await main.fs.rename(work(main, 'sub'), `${root}/wt/sub`);
      const ctx: Context = {
        ...main,
        layout: {
          ...main.layout,
          gitDir: linkedDir,
          commonDir: main.layout.gitDir,
          workDir: `${root}/wt`,
        },
      };
      const sut = rm;

      // Act
      await sut(ctx, ['sub'], { cached: false, force: true });

      // Assert
      expect(await ctx.fs.readUtf8(`${linkedDir}/modules/sub/config`)).toContain(
        'worktree = ../../../../../wt/sub',
      );
    });
  });
});
