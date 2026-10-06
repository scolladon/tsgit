import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { detectMergeRenames } from '../../../../src/application/primitives/detect-merge-renames.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { FlatTree } from '../../../../src/domain/diff/flat-tree.js';
import { FILE_MODE, type FilePath, type ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const LINES = '1\n2\n3\n4\n5\n6\n7\n8\n';
const EDITED = '1\n2\n3\n4\n5\n6\nseven\n8\n';
const OTHER_LINES = 'a\nb\nc\nd\ne\nf\ng\nh\n';

const blob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const flat = (pairs: ReadonlyArray<readonly [string, ObjectId]>): FlatTree => ({
  entries: new Map(
    pairs.map(([path, id]) => [path as FilePath, { id, mode: FILE_MODE.REGULAR }] as const),
  ),
});

const withConfig = async (ctx: Context, config: string): Promise<Context> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  return ctx;
};

/** theirs renames `big` to `big2`, ours edits `big` — git's rename-vs-modify. */
const renameVsModify = async (ctx: Context, renamed = LINES) => {
  const original = await blob(ctx, LINES);
  const edited = await blob(ctx, EDITED);
  const moved = await blob(ctx, renamed);
  return {
    base: flat([['big', original]]),
    ours: flat([['big', edited]]),
    theirs: flat([['big2', moved]]),
  };
};

const BIG_TO_BIG2 = [{ oldPath: 'big', newPath: 'big2' }];
const BIG_AND_X = [...BIG_TO_BIG2, { oldPath: 'x', newPath: 'x2' }];

describe('detectMergeRenames', () => {
  describe('Given theirs renames a path ours modified', () => {
    describe('When renames are detected', () => {
      it('Then the exact rename is paired on their side', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { base, ours, theirs } = await renameVsModify(ctx);
        const sut = detectMergeRenames;

        // Act
        const result = await sut(ctx, base, ours, theirs);

        // Assert
        expect(result).toEqual({ ours: [], theirs: BIG_TO_BIG2 });
      });
    });
  });

  describe('Given ours renames with an edit a path theirs modified', () => {
    describe('When renames are detected', () => {
      it('Then the similar rename is paired on our side', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { base, ours, theirs } = await renameVsModify(ctx, '1\n2\n3\n4\n5\n6\n7\neight\n');
        const sut = detectMergeRenames;

        // Act
        const result = await sut(ctx, base, theirs, ours);

        // Assert
        expect(result).toEqual({ ours: BIG_TO_BIG2, theirs: [] });
      });
    });
  });

  describe('Given the other side left the renamed source untouched', () => {
    describe('When renames are detected', () => {
      it('Then the source is irrelevant and nothing is paired', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { base, theirs } = await renameVsModify(ctx);
        const sut = detectMergeRenames;

        // Act
        const result = await sut(ctx, base, base, theirs);

        // Assert
        expect(result).toEqual({ ours: [], theirs: [] });
      });
    });
  });

  describe('Given the other side also deleted the renamed source', () => {
    describe('When renames are detected', () => {
      it('Then the rename is still paired', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { base, theirs } = await renameVsModify(ctx);
        const sut = detectMergeRenames;

        // Act
        const result = await sut(ctx, base, flat([]), theirs);

        // Assert
        expect(result).toEqual({ ours: [], theirs: BIG_TO_BIG2 });
      });
    });
  });

  describe('Given an empty file renamed on one side and edited on the other', () => {
    describe('When renames are detected', () => {
      it('Then the empty blob is never a rename source', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const empty = await blob(ctx, '');
        const edited = await blob(ctx, 'x\n');
        const sut = detectMergeRenames;

        // Act
        const result = await sut(
          ctx,
          flat([['empty', empty]]),
          flat([['empty', edited]]),
          flat([['empty2', empty]]),
        );

        // Assert
        expect(result).toEqual({ ours: [], theirs: [] });
      });
    });
  });

  describe('Given a rename limit of 1 and an empty file added beside an inexact rename', () => {
    describe('When renames are detected', () => {
      it('Then the empty addition does not count against the limit', async () => {
        // Arrange
        const ctx = await withConfig(createMemoryContext(), '[merge]\n\trenameLimit = 1\n');
        const { base, ours, theirs } = await renameVsModify(ctx, `0\n${LINES}`);
        const empty = await blob(ctx, '');
        const withEmpty = flat([
          ...[...theirs.entries].map(([p, e]) => [p, e.id] as const),
          ['e', empty],
        ]);
        const sut = detectMergeRenames;

        // Act
        const result = await sut(ctx, base, ours, withEmpty);

        // Assert
        expect(result.theirs).toEqual(BIG_TO_BIG2);
      });
    });
  });

  describe('Given no merge base', () => {
    describe('When renames are detected', () => {
      it('Then nothing is paired', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { ours, theirs } = await renameVsModify(ctx);
        const sut = detectMergeRenames;

        // Act
        const result = await sut(ctx, undefined, ours, theirs);

        // Assert
        expect(result).toEqual({ ours: [], theirs: [] });
      });
    });
  });

  describe('Given a side that only deletes the relevant source', () => {
    describe('When renames are detected', () => {
      it('Then nothing is paired', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { base, ours } = await renameVsModify(ctx);
        const sut = detectMergeRenames;

        // Act
        const result = await sut(ctx, base, ours, flat([]));

        // Assert
        expect(result).toEqual({ ours: [], theirs: [] });
      });
    });
  });

  describe.each([
    ['[merge]\n\trenames = false\n', []],
    ['[diff]\n\trenames = false\n', []],
    ['[diff]\n\trenames = false\n[merge]\n\trenames = true\n', BIG_TO_BIG2],
    ['[merge]\n\trenames = copies\n', BIG_TO_BIG2],
    ['[merge]\n\trenames = Copy\n', BIG_TO_BIG2],
    ['[merge]\n\trenameLimit = 0\n', BIG_TO_BIG2],
  ])('Given the config %j', (config, expected) => {
    describe('When renames are detected', () => {
      it('Then detection follows it', async () => {
        // Arrange
        const ctx = await withConfig(createMemoryContext(), config);
        const { base, ours, theirs } = await renameVsModify(ctx);
        const sut = detectMergeRenames;

        // Act
        const result = await sut(ctx, base, ours, theirs);

        // Assert
        expect(result.theirs).toEqual(expected);
      });
    });
  });

  describe.each([
    ['', BIG_AND_X],
    ['[merge]\n\trenameLimit = 1\n', []],
    ['[diff]\n\trenameLimit = 1\n', []],
    ['[diff]\n\trenameLimit = 1\n[merge]\n\trenameLimit = 2\n', BIG_AND_X],
  ])('Given %j and two inexact renames', (config, expected) => {
    describe('When renames are detected', () => {
      it('Then the inexact pass runs only within the limit', async () => {
        // Arrange
        const ctx = await withConfig(createMemoryContext(), config);
        const [big, other, bigEdit, otherEdit, bigMoved, otherMoved] = await Promise.all(
          [LINES, OTHER_LINES, EDITED, `${OTHER_LINES}i\n`, `0\n${LINES}`, `z\n${OTHER_LINES}`].map(
            (content) => blob(ctx, content),
          ),
        );
        const sut = detectMergeRenames;

        // Act
        const result = await sut(
          ctx,
          flat([
            ['big', big as ObjectId],
            ['x', other as ObjectId],
          ]),
          flat([
            ['big', bigEdit as ObjectId],
            ['x', otherEdit as ObjectId],
          ]),
          flat([
            ['big2', bigMoved as ObjectId],
            ['x2', otherMoved as ObjectId],
          ]),
        );

        // Assert
        expect(result.theirs).toEqual(expected);
      });
    });
  });

  describe.each([
    ['[merge]\n\trenames = bogus\n', { code: 'CONFIG_BAD_BOOLEAN_VALUE', key: 'merge.renames' }],
    ['[diff]\n\trenames = bogus\n', { code: 'CONFIG_BAD_BOOLEAN_VALUE', key: 'diff.renames' }],
    [
      '[merge]\n\trenameLimit = bogus\n',
      { code: 'CONFIG_BAD_NUMERIC_VALUE', key: 'merge.renamelimit', reason: 'invalid unit' },
    ],
    [
      '[diff]\n\trenameLimit = 4294967296\n',
      { code: 'CONFIG_BAD_NUMERIC_VALUE', key: 'diff.renamelimit', reason: 'out of range' },
    ],
    ['[merge]\n\trenames\n', { code: 'CONFIG_MISSING_VALUE', key: 'merge.renames' }],
    ['[merge]\n\trenameLimit\n', { code: 'CONFIG_MISSING_VALUE', key: 'merge.renamelimit' }],
  ])('Given the config %j', (config, expected) => {
    describe('When renames are detected', () => {
      it('Then the merge is refused as git refuses it', async () => {
        // Arrange
        const ctx = await withConfig(createMemoryContext(), config);
        const { base, ours, theirs } = await renameVsModify(ctx);
        const sut = detectMergeRenames;

        // Act
        const result = await sut(ctx, base, ours, theirs).catch((e: unknown) => e);

        // Assert
        expect((result as { data: unknown }).data).toEqual(expect.objectContaining(expected));
      });
    });
  });

  describe.each([
    ['', { detect: false }, []],
    ['[merge]\n\trenames = false\n', { detect: true }, BIG_TO_BIG2],
    ['', { detect: true, threshold: 46200 }, BIG_TO_BIG2],
    ['', { detect: true, threshold: 46800 }, []],
  ])('Given the config %j and the overrides %j', (config, overrides, expected) => {
    describe('When a 77%-similar rename is detected', () => {
      it('Then the overrides decide over the config', async () => {
        // Arrange
        const ctx = await withConfig(createMemoryContext(), config);
        const { base, ours, theirs } = await renameVsModify(ctx, 'one\n2\n3\n4\n5\n6\n7\n8\n');
        const sut = detectMergeRenames;

        // Act
        const result = await sut(ctx, base, ours, theirs, overrides);

        // Assert
        expect(result.theirs).toEqual(expected);
      });
    });
  });
});
