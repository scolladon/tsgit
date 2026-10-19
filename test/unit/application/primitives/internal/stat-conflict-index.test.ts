import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import { withConflictStopStats } from '../../../../../src/application/primitives/internal/stat-conflict-index.js';
import { stage0Entry } from '../../../../../src/application/primitives/internal/synthetic-index-entry.js';
import type { GitIndex, IndexEntry } from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const ID = 'a'.repeat(40) as ObjectId;
const OTHER_ID = 'b'.repeat(40) as ObjectId;
const PRIOR_STAT = {
  mtimeSeconds: 11,
  mtimeNanoseconds: 22,
  ctimeSeconds: 33,
  ino: 44,
  fileSize: 5,
};

const indexOf = (entries: ReadonlyArray<IndexEntry>): GitIndex => ({
  version: 2,
  entries,
  extensions: [],
  trailerSha: new Uint8Array(0),
});

const seed = async (files: ReadonlyArray<string>): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  for (const file of files) await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${file}`, 'x');
  return ctx;
};

describe('withConflictStopStats', () => {
  describe('Given a stage-0 entry for a path the merge wrote', () => {
    describe('When the stop stats are recorded', () => {
      it('Then the entry takes the stat of the file on disk', async () => {
        // Arrange
        const ctx = await seed(['w.txt']);
        const entry = stage0Entry('w.txt' as FilePath, ID, FILE_MODE.REGULAR);
        const sut = withConflictStopStats;

        // Act
        const [result] = await sut(ctx, [entry], indexOf([]), new Set(['w.txt' as FilePath]));

        // Assert
        const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/w.txt`);
        expect(result?.mtimeSeconds).toBe(Math.floor(stat.mtimeMs / 1000));
        expect(result?.ino).toBe(stat.ino);
        expect(result?.fileSize).toBe(stat.size);
        expect(result?.id).toBe(ID);
      });
    });
  });

  describe('Given an untouched clean path whose prior entry has the same content', () => {
    describe('When the stop stats are recorded', () => {
      it('Then the prior entry is kept', async () => {
        // Arrange
        const ctx = await seed(['k.txt']);
        const prior = { ...stage0Entry('k.txt' as FilePath, ID, FILE_MODE.REGULAR), ...PRIOR_STAT };
        const entry = stage0Entry('k.txt' as FilePath, ID, FILE_MODE.REGULAR);
        const sut = withConflictStopStats;

        // Act
        const [result] = await sut(ctx, [entry], indexOf([prior]), new Set());

        // Assert
        expect(result).toEqual(prior);
      });
    });
  });

  describe('Given an untouched clean path whose prior entry has other content', () => {
    describe('When the stop stats are recorded', () => {
      it('Then the zero-stat entry is kept', async () => {
        // Arrange
        const ctx = await seed(['k.txt']);
        const prior = {
          ...stage0Entry('k.txt' as FilePath, OTHER_ID, FILE_MODE.REGULAR),
          ...PRIOR_STAT,
        };
        const entry = stage0Entry('k.txt' as FilePath, ID, FILE_MODE.REGULAR);
        const sut = withConflictStopStats;

        // Act
        const [result] = await sut(ctx, [entry], indexOf([prior]), new Set());

        // Assert
        expect(result).toEqual(entry);
      });
    });
  });

  describe('Given an unmerged stage entry for a path the merge wrote', () => {
    describe('When the stop stats are recorded', () => {
      it('Then it stays zero-stat', async () => {
        // Arrange
        const ctx = await seed(['u.txt']);
        const entry: IndexEntry = {
          ...stage0Entry('u.txt' as FilePath, ID, FILE_MODE.REGULAR),
          flags: { ...stage0Entry('u.txt' as FilePath, ID, FILE_MODE.REGULAR).flags, stage: 2 },
        };
        const sut = withConflictStopStats;

        // Act
        const [result] = await sut(ctx, [entry], indexOf([]), new Set(['u.txt' as FilePath]));

        // Assert
        expect(result).toEqual(entry);
      });
    });
  });
  describe('Given an untouched clean path whose prior entry has the same blob in another mode', () => {
    describe('When the stop stats are recorded', () => {
      it('Then the zero-stat entry is kept', async () => {
        // Arrange
        const ctx = await seed(['k.txt']);
        const prior = {
          ...stage0Entry('k.txt' as FilePath, ID, FILE_MODE.EXECUTABLE),
          ...PRIOR_STAT,
        };
        const entry = stage0Entry('k.txt' as FilePath, ID, FILE_MODE.REGULAR);
        const sut = withConflictStopStats;

        // Act
        const [result] = await sut(ctx, [entry], indexOf([prior]), new Set());

        // Assert
        expect(result).toEqual(entry);
      });
    });
  });

  describe('Given a path the prior index held only as an unmerged stage with the same content', () => {
    describe('When the stop stats are recorded', () => {
      it('Then the stage-0 entry is kept, not the unmerged one', async () => {
        // Arrange
        const ctx = await seed(['k.txt']);
        const base = stage0Entry('k.txt' as FilePath, ID, FILE_MODE.REGULAR);
        const unmerged: IndexEntry = {
          ...base,
          ...PRIOR_STAT,
          flags: { ...base.flags, stage: 2 },
        };
        const sut = withConflictStopStats;

        // Act
        const [result] = await sut(ctx, [base], indexOf([unmerged]), new Set());

        // Assert
        expect(result).toEqual(base);
      });
    });
  });

  describe('Given a context with no work tree', () => {
    describe('When the stop stats are recorded', () => {
      it('Then it refuses with WORK_TREE_REQUIRED for the merge', async () => {
        // Arrange
        const base = await seed([]);
        const { workDir: _workDir, ...bareLayout } = base.layout;
        const ctx: Context = { ...base, layout: bareLayout };
        const sut = withConflictStopStats;

        // Act
        const act = sut(ctx, [], indexOf([]), new Set());

        // Assert
        await expect(act).rejects.toMatchObject({
          data: { code: 'WORK_TREE_REQUIRED', operation: 'merge' },
        });
      });
    });
  });
});
