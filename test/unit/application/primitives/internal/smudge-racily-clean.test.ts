import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { init } from '../../../../../src/application/commands/init.js';
import { acquireIndexLock } from '../../../../../src/application/primitives/internal/index-lock.js';
import * as gitattributes from '../../../../../src/application/primitives/internal/read-gitattributes.js';
import { smudgeRacilyClean } from '../../../../../src/application/primitives/internal/smudge-racily-clean.js';
import {
  invalidateIndexCache,
  readIndex,
} from '../../../../../src/application/primitives/read-index.js';
import { STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import type { IndexEntry } from '../../../../../src/domain/git-index/index-entry.js';
import { permissionDenied, TsgitError } from '../../../../../src/domain/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { asBareContext } from '../../commands/fixtures.js';

const MS_PER_SECOND = 1000;
const TICK_MS = 1_700_000_000_100;
const NEXT_SECOND_MS = TICK_MS + MS_PER_SECOND;
const TRACKED = 'f.txt' as FilePath;
const SAME_SIZE_REWRITE = 'm2\n';
const OTHER_ID = 'b'.repeat(40) as ObjectId;

const workPath = (ctx: Context, path: string): string => `${ctx.layout.workDir}/${path}`;

const write = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(workPath(ctx, path), content);

/** A repository whose index holds `f.txt` staged at `TICK_MS` as `m1`. */
const trackedRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await write(ctx, TRACKED, 'm1\n');
  await add(ctx, [TRACKED]);
  return ctx;
};

const entriesAsRead = async (ctx: Context): Promise<ReadonlyArray<IndexEntry>> =>
  (await readIndex(ctx)).entries;

const readPaths = (spy: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) =>
  spy.mock.calls.map(([path]) => path);

describe('smudgeRacilyClean', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TICK_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Given a racy carried-over entry whose file was rewritten with the same stat', () => {
    describe('When the index is written', () => {
      it('Then the entry is smudged to size 0 and keeps every other field', async () => {
        // Arrange
        const ctx = await trackedRepo();
        await write(ctx, TRACKED, SAME_SIZE_REWRITE);
        const entries = await entriesAsRead(ctx);
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(ctx, entries);

        // Assert
        expect(result).toEqual([{ ...entries[0], fileSize: 0 }]);
      });
    });
  });

  describe('Given core.autocrlf true, a racily-clean entry for an LF blob and its CRLF checkout', () => {
    describe('When smudging racily-clean entries', () => {
      it('Then the entry is kept (size unchanged) because the comparison converts the worktree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tautocrlf = true\n');
        await write(ctx, TRACKED, 'a\r\nb\r\n');
        await add(ctx, [TRACKED]);
        await write(ctx, TRACKED, 'a\r\nb\r\n');
        const entries = await entriesAsRead(ctx);
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(ctx, entries);

        // Assert
        expect(entries[0]?.fileSize).toBe(6);
        expect(result).toEqual(entries);
      });
    });
  });

  describe('Given a racy carried-over entry whose content is unchanged', () => {
    describe('When the index is written', () => {
      it('Then the entry is kept as is', async () => {
        // Arrange
        const ctx = await trackedRepo();
        const entries = await entriesAsRead(ctx);
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(ctx, entries);

        // Assert
        expect(result).toEqual(entries);
      });
    });
  });

  describe('Given a carried-over entry older than the index as read', () => {
    describe('When the index is written', () => {
      it('Then the entry is kept without touching its working file', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await write(ctx, TRACKED, 'm1\n');
        vi.setSystemTime(NEXT_SECOND_MS);
        await add(ctx, [TRACKED]);
        const entries = await entriesAsRead(ctx);
        invalidateIndexCache(ctx);
        const probe = vi.spyOn(ctx.fs, 'lstatIfReachable');
        const read = vi.spyOn(ctx.fs, 'read');
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(ctx, entries);

        // Assert
        expect(result).toEqual(entries);
        expect(readPaths(probe)).not.toContain(workPath(ctx, TRACKED));
        expect(read).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a racy entry whose id differs from the index as read', () => {
    describe('When the index is written', () => {
      it('Then the freshly built entry is kept as is', async () => {
        // Arrange
        const ctx = await trackedRepo();
        await write(ctx, TRACKED, SAME_SIZE_REWRITE);
        const [asRead] = await entriesAsRead(ctx);
        const entries = [{ ...(asRead as IndexEntry), id: OTHER_ID }];
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(ctx, entries);

        // Assert
        expect(result).toEqual(entries);
      });
    });
  });

  describe('Given a racy entry at a path the index as read does not hold, its own path dropped', () => {
    describe('When the index is written', () => {
      it('Then the new entry is kept as is', async () => {
        // Arrange
        const ctx = await trackedRepo();
        const [asRead] = await entriesAsRead(ctx);
        await write(ctx, 'g.txt', 'm1\n');
        const entries = [{ ...(asRead as IndexEntry), id: OTHER_ID, path: 'g.txt' as FilePath }];
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(ctx, entries);

        // Assert
        expect(result).toEqual(entries);
      });
    });
  });

  describe('Given a racy carried-over entry whose working file changed size', () => {
    describe('When the index is written', () => {
      it('Then the entry is kept without reading the file', async () => {
        // Arrange
        const ctx = await trackedRepo();
        await write(ctx, TRACKED, 'm22\n');
        const entries = await entriesAsRead(ctx);
        const read = vi.spyOn(ctx.fs, 'read');
        const build = vi.spyOn(gitattributes, 'maybeBuildAttributeProvider');
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(ctx, entries);

        // Assert
        expect(result).toEqual(entries);
        expect(readPaths(read)).not.toContain(workPath(ctx, TRACKED));
        expect(build).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a racy carried-over entry whose working file is gone', () => {
    describe('When the index is written', () => {
      it('Then the entry is kept as is', async () => {
        // Arrange
        const ctx = await trackedRepo();
        const entries = await entriesAsRead(ctx);
        await ctx.fs.rm(workPath(ctx, TRACKED));
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(ctx, entries);

        // Assert
        expect(result).toEqual(entries);
      });
    });
  });

  describe('Given a racy carried-over entry whose working file is of another mode', () => {
    describe('When the index is written', () => {
      it('Then the entry is kept as is', async () => {
        // Arrange
        const ctx = await trackedRepo();
        const [asRead] = await entriesAsRead(ctx);
        const executable = { ...(asRead as IndexEntry), mode: FILE_MODE.EXECUTABLE };
        const lock = await acquireIndexLock(ctx);
        await lock.commit([executable]);
        await write(ctx, TRACKED, SAME_SIZE_REWRITE);
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(ctx, [executable]);

        // Assert
        expect(result).toEqual([executable]);
      });
    });
  });

  describe('Given a racy carried-over gitlink', () => {
    describe('When the index is written', () => {
      it('Then the gitlink is kept without probing its working path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const gitlink: IndexEntry = {
          ctimeSeconds: Math.floor(TICK_MS / MS_PER_SECOND),
          ctimeNanoseconds: 0,
          mtimeSeconds: Math.floor(TICK_MS / MS_PER_SECOND),
          mtimeNanoseconds: 0,
          dev: 0,
          ino: 0,
          mode: FILE_MODE.GITLINK,
          uid: 0,
          gid: 0,
          fileSize: 0,
          id: OTHER_ID,
          flags: STAGE0_FLAGS,
          path: 'sub' as FilePath,
        };
        const lock = await acquireIndexLock(ctx);
        await lock.commit([gitlink]);
        const entries = await entriesAsRead(ctx);
        const probe = vi.spyOn(ctx.fs, 'lstatIfReachable');
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(ctx, entries);

        // Assert
        expect(result).toEqual(entries);
        expect(readPaths(probe)).not.toContain(workPath(ctx, 'sub'));
      });
    });
  });

  describe('Given no index file yet', () => {
    describe('When the first index is written', () => {
      it('Then the entries are kept without reading any index', async () => {
        // Arrange
        const ctx = await trackedRepo();
        await write(ctx, TRACKED, SAME_SIZE_REWRITE);
        const entries = await entriesAsRead(ctx);
        await ctx.fs.rm(`${ctx.layout.gitDir}/index`);
        const read = vi.spyOn(ctx.fs, 'read');
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(ctx, entries);

        // Assert
        expect(result).toEqual(entries);
        expect(read).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a bare repository', () => {
    describe('When the index is written', () => {
      it('Then the entries are kept as is', async () => {
        // Arrange
        const ctx = await trackedRepo();
        await write(ctx, TRACKED, SAME_SIZE_REWRITE);
        const entries = await entriesAsRead(ctx);
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(asBareContext(ctx), entries);

        // Assert
        expect(result).toEqual(entries);
      });
    });
  });

  describe('Given a corrupt index as read', () => {
    describe('When the index is written', () => {
      it('Then nothing is carried over and the entries are kept as is', async () => {
        // Arrange
        const ctx = await trackedRepo();
        await write(ctx, TRACKED, SAME_SIZE_REWRITE);
        const entries = await entriesAsRead(ctx);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/index`,
          'not an index, long enough to hold a trailer',
        );
        const sut = smudgeRacilyClean;

        // Act
        const result = await sut(ctx, entries);

        // Assert
        expect(result).toEqual(entries);
      });
    });
  });

  describe('Given an index as read that cannot be opened', () => {
    describe('When the index is written', () => {
      it('Then the refusal propagates', async () => {
        // Arrange
        const ctx = await trackedRepo();
        const entries = await entriesAsRead(ctx);
        invalidateIndexCache(ctx);
        const indexFile = `${ctx.layout.gitDir}/index`;
        vi.spyOn(ctx.fs, 'read').mockRejectedValue(permissionDenied(indexFile));
        const sut = smudgeRacilyClean;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, entries);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({ code: 'PERMISSION_DENIED', path: indexFile });
      });
    });
  });
});
