import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add, addAll } from '../../../../src/application/commands/add.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { parseResolveUndo } from '../../../../src/domain/git-index/resolve-undo.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';
import {
  indexExtensionsOf,
  resolveUndoExtension,
  withIndexExtensions,
} from '../primitives/helpers/index-extensions.js';
import { type IndexRow, seedIndex, stagesOf } from './add-index-fixtures.js';
import { seedRepo } from './fixtures.js';

type Ctx = ReturnType<typeof createMemoryContext>;
const FILES_WRITTEN_AT_MS = 1_700_000_000_000;
const INDEX_AGE_MS = 10_000;
const TOP_AT_ZERO = /^top@0:/;

const stagesAt = (all: ReadonlyArray<string>, path: string): string[] =>
  all
    .filter((line) => line.startsWith(`${path}@`))
    .map((line) => line.slice(path.length + 1, path.length + 2));

const fNames = (all: ReadonlyArray<string>, path: string): string[] =>
  all.filter((line) => line.startsWith(`${path}@`));

interface Shape {
  readonly title: string;
  readonly fRows: ReadonlyArray<IndexRow>;
  readonly fOnDisk: string;
  readonly fStages: string[];
}

const SHAPES: ReadonlyArray<Shape> = [
  {
    title: 'f unmerged at stages 1, 2 and 3',
    fRows: [
      { path: 'f', text: 'f-base', stage: 1 },
      { path: 'f', text: 'f-ours', stage: 2 },
      { path: 'f', text: 'f-theirs', stage: 3 },
    ],
    fOnDisk: 'f-merged',
    fStages: ['1', '2', '3'],
  },
  {
    title: 'f deleted by them (stages 1 and 2)',
    fRows: [
      { path: 'f', text: 'f-base', stage: 1 },
      { path: 'f', text: 'f-ours', stage: 2 },
    ],
    fOnDisk: 'f-ours',
    fStages: ['1', '2'],
  },
  {
    title: 'f deleted by us (stages 1 and 3)',
    fRows: [
      { path: 'f', text: 'f-base', stage: 1 },
      { path: 'f', text: 'f-theirs', stage: 3 },
    ],
    fOnDisk: 'f-theirs',
    fStages: ['1', '3'],
  },
];

const HRows: ReadonlyArray<IndexRow> = [
  { path: 'h', text: 'h-base', stage: 1 },
  { path: 'h', text: 'h-ours', stage: 2 },
  { path: 'h', text: 'h-theirs', stage: 3 },
];

const seedConflicted = async (shape: Shape) => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, {
    workingTree: {
      top: 'top-new',
      'd/e': 'e-new',
      f: shape.fOnDisk,
      h: 'h-merged',
      'tx/y': 'y-new',
    },
  });
  await seedIndex(ctx, [
    { path: 'top', text: 'top-old' },
    { path: 'd/e', text: 'e-old' },
    ...shape.fRows,
    ...HRows,
  ]);
  return ctx;
};

describe.each(SHAPES)('Given $title next to an unmerged h', (shape) => {
  describe('When add stages top', () => {
    it('Then f and h keep every stage and top is stage 0', async () => {
      // Arrange
      const ctx = await seedConflicted(shape);
      const before = await stagesOf(ctx);
      const sut = add;

      // Act
      await sut(ctx, ['top']);
      const result = await stagesOf(ctx);

      // Assert
      expect(stagesAt(result, 'f')).toEqual(shape.fStages);
      expect(stagesAt(result, 'h')).toEqual(['1', '2', '3']);
      expect(fNames(result, 'f')).toEqual(fNames(before, 'f'));
      expect(result.filter((l) => TOP_AT_ZERO.test(l))).toHaveLength(1);
    });
  });

  describe('When add stages f', () => {
    it('Then f is stage 0 and h keeps every stage', async () => {
      // Arrange
      const ctx = await seedConflicted(shape);
      const sut = add;

      // Act
      await sut(ctx, ['f']);
      const result = await stagesOf(ctx);

      // Assert
      expect(stagesAt(result, 'f')).toEqual(['0']);
      expect(stagesAt(result, 'h')).toEqual(['1', '2', '3']);
    });
  });

  describe('When add stages top and f', () => {
    it('Then f is stage 0 and h keeps every stage', async () => {
      // Arrange
      const ctx = await seedConflicted(shape);
      const sut = add;

      // Act
      await sut(ctx, ['top', 'f']);
      const result = await stagesOf(ctx);

      // Assert
      expect(stagesAt(result, 'f')).toEqual(['0']);
      expect(stagesAt(result, 'h')).toEqual(['1', '2', '3']);
    });
  });
});

describe('Given an unmerged f and h next to tracked top and d/e', () => {
  describe.each([
    { title: 'a directory pathspec', specs: ['d'] },
    { title: 'a glob pathspec', specs: ['t*'] },
    { title: 'a directory pathspec with an exclusion', specs: ['d', '!f'] },
  ])('When add walks $title', ({ specs }) => {
    it('Then f and h keep every stage', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      const sut = add;

      // Act
      await sut(ctx, specs);
      const result = await stagesOf(ctx);

      // Assert
      expect(stagesAt(result, 'f')).toEqual(['1', '2', '3']);
      expect(stagesAt(result, 'h')).toEqual(['1', '2', '3']);
    });
  });

  describe('When the bulk add hides f from the walk', () => {
    it('Then f keeps every stage while the rest is staged', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      const sut = addAll;

      // Act
      await sut(ctx, (path) => path === 'f');
      const result = await stagesOf(ctx);

      // Assert
      expect(stagesAt(result, 'f')).toEqual(['1', '2', '3']);
      expect(stagesAt(result, 'h')).toEqual(['0']);
    });
  });
});

describe('Given a stat-clean top and d/e beside an unmerged f and h', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('When add stages top', () => {
    it('Then the index file bytes are unchanged', async () => {
      // Arrange
      vi.useFakeTimers({ toFake: ['Date'], now: FILES_WRITTEN_AT_MS });
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      await add(ctx, ['top', 'd/e', 'f', 'h']);
      vi.setSystemTime(FILES_WRITTEN_AT_MS + INDEX_AGE_MS);
      const clean = (await readIndex(ctx)).entries;
      const unmerged = [1, 2, 3].flatMap((stage) =>
        clean
          .filter(({ path }) => path === 'f' || path === 'h')
          .map((entry) => ({ ...entry, flags: { ...STAGE0_FLAGS, stage: stage as 1 | 2 | 3 } })),
      );
      const entries = [
        ...clean.filter(({ path }) => path === 'top' || path === 'd/e'),
        ...unmerged,
      ];
      await ctx.fs.write(
        `${ctx.layout.gitDir}/index`,
        await serializeIndexFixtureAsync(
          { version: 2, entries, extensions: [], trailerSha: new Uint8Array(0) },
          ctx,
        ),
      );
      const indexPath = `${ctx.layout.gitDir}/index`;
      const before = await ctx.fs.read(indexPath);
      const sut = add;

      // Act
      await sut(ctx, ['top']);

      // Assert
      expect(await ctx.fs.read(indexPath)).toEqual(before);
    });
  });
});

describe('Given an unmerged f and h on disk next to tracked top and d/e', () => {
  describe.each([
    { title: 'add all', run: (ctx: Ctx) => add(ctx, [], { all: true }) },
    { title: 'add of the whole tree', run: (ctx: Ctx) => add(ctx, ['.']) },
  ])('When $title stages every path', ({ run }) => {
    it('Then every path is stage 0', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      const sut = run;

      // Act
      await sut(ctx);
      const result = await stagesOf(ctx);

      // Assert
      expect(result.map((line) => line.slice(0, line.indexOf(':')))).toEqual([
        'd/e@0',
        'f@0',
        'h@0',
        'top@0',
        'tx/y@0',
      ]);
    });
  });

  describe('When add renormalizes the whole tree', () => {
    it('Then every stage of f and h is kept', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      const before = await stagesOf(ctx);
      const sut = add;

      // Act
      await sut(ctx, ['.'], { renormalize: true });
      const result = await stagesOf(ctx);

      // Assert
      expect(result.filter((line) => /^[fh]@/.test(line))).toEqual(
        before.filter((line) => /^[fh]@/.test(line)),
      );
    });
  });
});

describe('Given an unmerged f deleted from the working tree', () => {
  describe('When add all stages the deletion', () => {
    it('Then every stage of f is gone and h keeps its own', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      await ctx.fs.rm(`${ctx.layout.workDir}/f`);
      const sut = add;

      // Act
      const result = await sut(ctx, [], { all: true });
      const stages = await stagesOf(ctx);

      // Assert
      expect(result.removed).toEqual(['f']);
      expect(stagesAt(stages, 'f')).toEqual([]);
    });
  });
});

describe.each([SHAPES[1], SHAPES[2]] as Shape[])(
  'Given $title whose working file equals its last stage',
  (shape) => {
    describe('When add stages f', () => {
      it('Then f is reported as modified', async () => {
        // Arrange
        const ctx = await seedConflicted(shape);
        const sut = add;

        // Act
        const result = await sut(ctx, ['f']);

        // Assert
        expect(result.modified).toEqual(['f']);
      });
    });
  },
);

describe.each([SHAPES[1], SHAPES[2]] as Shape[])(
  'Given $title whose working file equals its last stage, walked by add all',
  (shape) => {
    describe('When add stages every path', () => {
      it('Then f is reported as modified', async () => {
        // Arrange
        const ctx = await seedConflicted(shape);
        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.modified).toContain('f');
      });
    });
  },
);

describe('Given a merged top rewritten with identical bytes', () => {
  describe('When add stages top', () => {
    it('Then modified is empty', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, { workingTree: { top: 'top-old' } });
      await seedIndex(ctx, [{ path: 'top', text: 'top-old' }]);
      const sut = add;

      // Act
      const result = await sut(ctx, ['top']);

      // Assert
      expect(result.modified).toEqual([]);
    });
  });
});

describe('Given f unmerged at stages 1, 2 and 3 with a merged file on disk', () => {
  describe('When add stages f', () => {
    it('Then f is reported as modified', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      const sut = add;

      // Act
      const result = await sut(ctx, ['f']);

      // Assert
      expect(result.modified).toEqual(['f']);
    });
  });
});

const SHA1_DIGEST = 20;

const recordedStages = async (
  ctx: Ctx,
): Promise<ReadonlyArray<readonly [string, ReadonlyArray<number>]>> => {
  const reuc = (await indexExtensionsOf(ctx)).get('REUC');
  if (reuc === undefined) return [];
  const records = parseResolveUndo(reuc, SHA1_DIGEST) ?? [];
  return records.map((record) => [record.path, record.stages.map(({ stage }) => stage)]);
};

describe.each(SHAPES)('Given $title next to an unmerged h, resolve-undo', (shape) => {
  describe('When add stages f', () => {
    it('Then REUC records f with the stages it had', async () => {
      // Arrange
      const ctx = await seedConflicted(shape);
      const sut = add;

      // Act
      await sut(ctx, ['f']);
      const result = await recordedStages(ctx);

      // Assert
      expect(result).toEqual([['f', shape.fStages.map(Number)]]);
    });
  });
});

describe('Given f and h unmerged', () => {
  describe('When add stages f then h', () => {
    it('Then REUC records f and h', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      const sut = add;

      // Act
      await sut(ctx, ['f']);
      await sut(ctx, ['h']);
      const result = await recordedStages(ctx);

      // Assert
      expect(result).toEqual([
        ['f', [1, 2, 3]],
        ['h', [1, 2, 3]],
      ]);
    });
  });

  describe('When add all stages the deletion of f', () => {
    it('Then REUC records f and h', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      await ctx.fs.rm(`${ctx.layout.workDir}/f`);
      const sut = add;

      // Act
      await sut(ctx, [], { all: true });
      const result = await recordedStages(ctx);

      // Assert
      expect(result).toEqual([
        ['f', [1, 2, 3]],
        ['h', [1, 2, 3]],
      ]);
    });
  });

  describe('When add stages only top', () => {
    it('Then no REUC is written', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      const sut = add;

      // Act
      await sut(ctx, ['top']);
      const result = await recordedStages(ctx);

      // Assert
      expect(result).toEqual([]);
    });
  });

  describe('When add walks a directory that leaves f and h unmerged', () => {
    it('Then no REUC is written', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      const sut = add;

      // Act
      await sut(ctx, ['d']);
      const result = await recordedStages(ctx);

      // Assert
      expect(result).toEqual([]);
    });
  });
});

describe('Given f and h unmerged beside a seeded REUC record for another path', () => {
  describe('When add stages f', () => {
    it('Then REUC keeps the prior record beside f', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      const index = await readIndex(ctx);
      await withIndexExtensions(ctx, [
        ...index.extensions,
        resolveUndoExtension('a', 'b'.repeat(40), SHA1_DIGEST),
      ]);
      const sut = add;

      // Act
      await sut(ctx, ['f']);
      const result = await recordedStages(ctx);

      // Assert
      expect(result).toEqual([
        ['a', [1]],
        ['f', [1, 2, 3]],
      ]);
    });
  });

  describe('When add stages top', () => {
    it('Then REUC keeps the prior record untouched', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      const index = await readIndex(ctx);
      await withIndexExtensions(ctx, [
        ...index.extensions,
        resolveUndoExtension('a', 'b'.repeat(40), SHA1_DIGEST),
      ]);
      const sut = add;

      // Act
      await sut(ctx, ['top']);
      const result = await recordedStages(ctx);

      // Assert
      expect(result).toEqual([['a', [1]]]);
    });
  });
});

describe('Given a malformed seeded REUC and an unmerged h', () => {
  describe('When add stages h', () => {
    it('Then REUC holds h only', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      const index = await readIndex(ctx);
      const malformed = { signature: 'REUC', data: Uint8Array.of(0x61, 0x00, 0x39, 0x00) };
      await withIndexExtensions(ctx, [...index.extensions, malformed]);
      const sut = add;

      // Act
      await sut(ctx, ['h']);
      const result = await recordedStages(ctx);

      // Assert
      expect(result).toEqual([['h', [1, 2, 3]]]);
    });
  });
});

describe('Given f resolved once with a record, and a seeded record for f stages', () => {
  describe('When add stages f again and then the whole tree', () => {
    it('Then the f record bytes are unchanged', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      const sut = add;
      await sut(ctx, ['f']);
      const before = (await indexExtensionsOf(ctx)).get('REUC');

      // Act
      await sut(ctx, ['f']);
      await sut(ctx, ['top']);
      const result = (await indexExtensionsOf(ctx)).get('REUC');

      // Assert
      expect(result).toEqual(before);
    });
  });
});

describe('Given a re-created unmerged f beside a seeded record for f at stages 1, 2 and 3', () => {
  describe('When add stages f', () => {
    it('Then the new ids replace stages 1 and 2 and the stale stage 3 stays', async () => {
      // Arrange
      const ctx = await seedConflicted(SHAPES[0] as Shape);
      await add(ctx, ['f']);
      const resolvedAt = await readIndex(ctx);
      const seeded = (await indexExtensionsOf(ctx)).get('REUC') as Uint8Array;
      const old = parseResolveUndo(seeded, SHA1_DIGEST)?.[0];
      await seedIndex(ctx, [
        { path: 'f', text: 'f-new-base', stage: 1 },
        { path: 'f', text: 'f-new-ours', stage: 2 },
      ]);
      await withIndexExtensions(ctx, resolvedAt.extensions);
      const sut = add;

      // Act
      await sut(ctx, ['f']);
      const result = parseResolveUndo(
        (await indexExtensionsOf(ctx)).get('REUC') as Uint8Array,
        SHA1_DIGEST,
      )?.[0];

      // Assert
      const stage = (n: number) => result?.stages.find((s) => s.stage === n)?.id;
      const oldStage = (n: number) => old?.stages.find((s) => s.stage === n)?.id;
      expect(result?.stages.map((s) => s.stage)).toEqual([1, 2, 3]);
      expect(stage(1)).not.toBe(oldStage(1));
      expect(stage(2)).not.toBe(oldStage(2));
      expect(stage(3)).toBe(oldStage(3));
    });
  });
});
