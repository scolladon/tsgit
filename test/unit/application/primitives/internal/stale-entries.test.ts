import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import type { ChangesetEntry } from '../../../../../src/application/primitives/compute-changeset.js';
import { indexEntryFromStat } from '../../../../../src/application/primitives/internal/index-entry-from-stat.js';
import type { IndexMtime } from '../../../../../src/application/primitives/internal/is-entry-stat-clean.js';
import { serializeAndHash } from '../../../../../src/application/primitives/internal/serialize-and-hash.js';
import { upgradeStaleNoops } from '../../../../../src/application/primitives/internal/stale-entries.js';
import type { GitIndex, IndexEntry } from '../../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';

const NON_RACY: IndexMtime = { seconds: 4_000_000_000, nanoseconds: 0 };
const FROZEN_NOW = new Date('2026-01-01T00:00:00Z');
const BYTES = (text: string): Uint8Array => new TextEncoder().encode(text);
const ZERO_ID = '0'.repeat(40) as ObjectId;

const workOf = (ctx: Context, relative: string): string => `${ctx.layout.workDir}/${relative}`;

const blobIdOf = async (ctx: Context, text: string): Promise<ObjectId> =>
  (await serializeAndHash(ctx, { type: 'blob', id: '' as ObjectId, content: BYTES(text) })).id;

const noopOf = (entry: IndexEntry): ChangesetEntry => ({
  kind: 'noop',
  path: entry.path,
  ...(entry.pathBytes && { pathBytes: entry.pathBytes }),
  mode: entry.mode,
  id: entry.id,
  previousId: entry.id,
  previousMode: entry.mode,
});

const indexOf = (entries: ReadonlyArray<IndexEntry>, indexMtime?: IndexMtime): GitIndex => ({
  version: 2,
  entries,
  extensions: [],
  trailerSha: new Uint8Array(0),
  ...(indexMtime && { indexMtime }),
});

const seed = async (ctx: Context, relative: string, text: string): Promise<IndexEntry> => {
  await ctx.fs.write(workOf(ctx, relative), BYTES(text));
  return indexEntryFromStat(
    await ctx.fs.lstat(workOf(ctx, relative)),
    FILE_MODE.REGULAR,
    await blobIdOf(ctx, text),
    relative as FilePath,
  );
};

const bareEntry = (relative: string, mode: IndexEntry['mode']): IndexEntry => ({
  ...indexEntryFromStat(
    {
      size: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      ino: 0,
      uid: 0,
      gid: 0,
      mode: 0,
      isDirectory: false,
    } as never,
    mode,
    ZERO_ID,
    relative as FilePath,
  ),
});

const judge = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  indexMtime?: IndexMtime,
): Promise<ReadonlyArray<ChangesetEntry['kind']>> => {
  const sut = await upgradeStaleNoops(
    ctx,
    entries.map(noopOf),
    indexOf(entries, indexMtime),
    ctx.layout.workDir ?? '',
  );
  return sut.entries.map((e) => e.kind);
};

describe('upgradeStaleNoops', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Given an up-to-date entry', () => {
    describe('When it is judged', () => {
      it('Then it stays a noop', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entry = await seed(ctx, 'a.txt', 'one\n');

        // Act
        const kinds = await judge(ctx, [entry], NON_RACY);

        // Assert
        expect(kinds).toEqual(['noop']);
      });
    });
  });

  describe('Given a non-noop entry', () => {
    describe('When it is judged', () => {
      it('Then it is returned unchanged, in order', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const added: ChangesetEntry = {
          kind: 'add',
          path: 'n.txt' as FilePath,
          mode: FILE_MODE.REGULAR,
          id: ZERO_ID,
          previousId: undefined,
          previousMode: undefined,
        };

        // Act
        const result = await upgradeStaleNoops(ctx, [added], indexOf([]), ctx.layout.workDir ?? '');

        // Assert
        expect(result.entries).toEqual([added]);
      });
    });
  });

  describe('Given an entry whose file is absent', () => {
    describe('When it is judged', () => {
      it('Then it becomes an update keeping the index previous id and mode', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entry = bareEntry('gone.txt', FILE_MODE.REGULAR);

        // Act
        const {
          entries: [sut],
        } = await upgradeStaleNoops(
          ctx,
          [noopOf(entry)],
          indexOf([entry], NON_RACY),
          ctx.layout.workDir ?? '',
        );

        // Assert
        expect(sut).toMatchObject({
          kind: 'update',
          previousId: entry.id,
          previousMode: entry.mode,
        });
      });
    });
  });

  describe('Given a regular file standing where a leading directory should be', () => {
    describe('When the entry below it is judged', () => {
      it('Then it becomes an update', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(workOf(ctx, 'd'), BYTES('file\n'));
        const entry = bareEntry('d/x', FILE_MODE.REGULAR);

        // Act
        const kinds = await judge(ctx, [entry], NON_RACY);

        // Assert
        expect(kinds).toEqual(['update']);
      });
    });
  });

  describe('Given a file touched after the index recorded it', () => {
    describe('When it is judged', () => {
      it('Then it becomes an update', async () => {
        // Arrange
        const ctx = createMemoryContext();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FROZEN_NOW);
        const entry = await seed(ctx, 'a.txt', 'one\n');
        vi.setSystemTime(new Date(FROZEN_NOW.getTime() + 5000));
        await ctx.fs.write(workOf(ctx, 'a.txt'), BYTES('one\n'));

        // Act
        const kinds = await judge(ctx, [entry], NON_RACY);

        // Assert
        expect(kinds).toEqual(['update']);
      });
    });
  });

  describe('Given an executable entry whose file is not executable', () => {
    describe('When it is judged', () => {
      it('Then it becomes an update', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const seeded = await seed(ctx, 'a.sh', 'run\n');
        const entry = { ...seeded, mode: FILE_MODE.EXECUTABLE };

        // Act
        const kinds = await judge(ctx, [entry], NON_RACY);

        // Assert
        expect(kinds).toEqual(['update']);
      });
    });
  });

  describe('Given an assume-valid entry with an edited file', () => {
    describe('When it is judged', () => {
      it('Then it becomes an update', async () => {
        // Arrange
        const ctx = createMemoryContext();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FROZEN_NOW);
        const seeded = await seed(ctx, 'a.txt', 'one\n');
        const entry = { ...seeded, flags: { ...STAGE0_FLAGS, assumeValid: true } };
        vi.setSystemTime(new Date(FROZEN_NOW.getTime() + 5000));
        await ctx.fs.write(workOf(ctx, 'a.txt'), BYTES('edited\n'));

        // Act
        const kinds = await judge(ctx, [entry], NON_RACY);

        // Assert
        expect(kinds).toEqual(['update']);
      });
    });
  });

  describe('Given a racy entry in a still second', () => {
    describe('When its content is unchanged', () => {
      it('Then it stays a noop', async () => {
        // Arrange
        const ctx = createMemoryContext();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FROZEN_NOW);
        const entry = await seed(ctx, 'a.txt', 'one\n');

        // Act
        const kinds = await judge(ctx, [entry]);

        // Assert
        expect(kinds).toEqual(['noop']);
      });
    });

    describe('When its content changed to other bytes of the same size', () => {
      it('Then it becomes an update', async () => {
        // Arrange
        const ctx = createMemoryContext();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FROZEN_NOW);
        const entry = await seed(ctx, 'a.txt', 'one\n');
        await ctx.fs.write(workOf(ctx, 'a.txt'), BYTES('two\n'));

        // Act
        const kinds = await judge(ctx, [entry]);

        // Assert
        expect(kinds).toEqual(['update']);
      });
    });

    describe('When two racy entries are judged in one pass', () => {
      it('Then the attribute sources are read once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FROZEN_NOW);
        const first = await seed(ctx, 'a.txt', 'one\n');
        const second = await seed(ctx, 'b.txt', 'two\n');
        const readSpy = vi.spyOn(ctx.fs, 'lstatIfReachable');

        // Act
        await judge(ctx, [first, second]);

        // Assert
        const reads = readSpy.mock.calls.filter(([p]) => p.endsWith('info/attributes')).length;
        expect(reads).toBe(1);
      });
    });
  });

  describe('Given an up-to-date file reached through a leading symlink', () => {
    describe('When the entry is judged', () => {
      it('Then it stays a noop', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(workOf(ctx, 'held'));
        const seeded = await seed(ctx, 'held/x', 'one\n');
        await ctx.fs.symlink('held', workOf(ctx, 'd'));
        const entry = { ...seeded, path: 'd/x' as FilePath };

        // Act
        const kinds = await judge(ctx, [entry], NON_RACY);

        // Assert
        expect(kinds).toEqual(['noop']);
      });
    });
  });

  describe('Given an up-to-date file reached through a leading symlink and the entry-checkout rule', () => {
    describe('When the entry is judged', () => {
      it('Then it becomes an update', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(workOf(ctx, 'held'));
        const seeded = await seed(ctx, 'held/x', 'one\n');
        await ctx.fs.symlink('held', workOf(ctx, 'd'));
        const entry = { ...seeded, path: 'd/x' as FilePath };

        // Act
        const sut = await upgradeStaleNoops(
          ctx,
          [noopOf(entry)],
          indexOf([entry], NON_RACY),
          ctx.layout.workDir ?? '',
          'checkoutEntry',
        );

        // Assert
        expect(sut.entries.map((e) => e.kind)).toEqual(['update']);
      });
    });
  });

  describe('Given a skip-worktree entry with no file', () => {
    describe('When it is judged', () => {
      it('Then it stays a noop', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const bare = bareEntry('sparse.txt', FILE_MODE.REGULAR);
        const entry = { ...bare, flags: { ...STAGE0_FLAGS, skipWorktree: true } };

        // Act
        const kinds = await judge(ctx, [entry], NON_RACY);

        // Assert
        expect(kinds).toEqual(['noop']);
      });
    });
  });

  describe('Given a lossy-path entry with no file', () => {
    describe('When it is judged', () => {
      it('Then it stays a noop', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entry = {
          ...bareEntry('�.txt', FILE_MODE.REGULAR),
          pathBytes: Uint8Array.of(0xff, 0x2e, 0x74),
        };

        // Act
        const kinds = await judge(ctx, [entry], NON_RACY);

        // Assert
        expect(kinds).toEqual(['noop']);
      });
    });
  });

  describe('Given a gitlink entry', () => {
    describe('When an empty directory stands at its path', () => {
      it('Then it stays a noop', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(workOf(ctx, 'sub'));
        const entry = bareEntry('sub', FILE_MODE.GITLINK);

        // Act
        const kinds = await judge(ctx, [entry], NON_RACY);

        // Assert
        expect(kinds).toEqual(['noop']);
      });
    });

    describe('When a regular file stands at its path', () => {
      it('Then it becomes an update', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(workOf(ctx, 'sub'), BYTES('file\n'));
        const entry = bareEntry('sub', FILE_MODE.GITLINK);

        // Act
        const kinds = await judge(ctx, [entry], NON_RACY);

        // Assert
        expect(kinds).toEqual(['update']);
      });
    });
  });
});
