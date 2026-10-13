import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { rm } from '../../../../src/application/commands/rm.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'a',
  email: 'a@x',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const LINES = '1\n2\n3\n4\n5\n6\n7\n8\n';

const write = (ctx: Context, file: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${file}`, content);

const commitAll = async (ctx: Context, files: ReadonlyArray<string>, message: string) => {
  await add(ctx, [...files]);
  await commit(ctx, { message, author });
};

/** `side` renames `big` to `big2` (77% similar after `moved`); main edits `big`. */
const renameVsEdit = async (moved: string, config = ''): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  await write(ctx, 'big', LINES);
  await commitAll(ctx, ['big'], 'base');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  await rm(ctx, ['big']);
  await write(ctx, 'big2', moved);
  await commitAll(ctx, ['big2'], 'move');
  await checkout(ctx, { rev: 'main' });
  await write(ctx, 'big', LINES.replace('7\n', 'seven\n'));
  await commitAll(ctx, ['big'], 'edit');
  return ctx;
};

/** Both sides rewrite line 7 of `big`: `side` to SEVEN, main to seven. */
const bothEditLineSeven = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await write(ctx, 'big', LINES);
  await commitAll(ctx, ['big'], 'base');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  await write(ctx, 'big', LINES.replace('7\n', 'SEVEN\n'));
  await commitAll(ctx, ['big'], 'side');
  await checkout(ctx, { rev: 'main' });
  await write(ctx, 'big', LINES.replace('7\n', 'seven\n'));
  await commitAll(ctx, ['big'], 'main');
  return ctx;
};

/** A seed whose content merge differs under histogram, myers and patience. */
const algorithmSensitive = async (config: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  await write(ctx, 'f', 'b\na\nc\na\nb\n');
  await commitAll(ctx, ['f'], 'base');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  await write(ctx, 'f', 'a\na\na\nb\nc\n');
  await commitAll(ctx, ['f'], 'side');
  await checkout(ctx, { rev: 'main' });
  await write(ctx, 'f', 'b\na\na\nc\na\nb\n');
  await commitAll(ctx, ['f'], 'main');
  return ctx;
};

const HISTOGRAM_MERGE = 'a\na\n<<<<<<< HEAD\n=======\na\nb\n>>>>>>> side\nc\n';
const MYERS_MERGE = 'a\na\n<<<<<<< HEAD\nc\n=======\n>>>>>>> side\na\nb\nc\n';
const PATIENCE_MERGE = 'a\na\na\nb\n<<<<<<< HEAD\na\na\n=======\n>>>>>>> side\nc\n';

const SIMILAR = LINES.replace('1\n', 'one\n');

/** Base `f` in CRLF; `side` adds `* text=auto` and renormalizes `f`, editing line 1 or not; main edits line 3 or deletes `f`. */
const renormalizingHistory = async (
  config: string,
  mainChange: 'edit' | 'delete',
): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  await write(ctx, 'f', 'a\r\nb\r\nc\r\n');
  await commitAll(ctx, ['f'], 'base');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  await write(ctx, '.gitattributes', '* text=auto\n');
  await write(ctx, 'f', mainChange === 'edit' ? 'A\nb\nc\n' : 'a\nb\nc\n');
  await commitAll(ctx, ['.gitattributes', 'f'], 'side');
  await checkout(ctx, { rev: 'main' });
  if (mainChange === 'delete') {
    await rm(ctx, ['f']);
    await commit(ctx, { message: 'main', author });
    return ctx;
  }
  await write(ctx, 'f', 'a\r\nb\r\nC\r\n');
  await commitAll(ctx, ['f'], 'main');
  return ctx;
};

const errorData = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (e: unknown) => (e as TsgitError).data,
  );

describe('merge strategy options', () => {
  describe.each([
    ['find-renames=77', SIMILAR, '', 'merge'],
    ['find-renames=78', SIMILAR, '', 'conflict'],
    ['rename-threshold=70', SIMILAR, '', 'merge'],
    ['no-renames', LINES, '', 'conflict'],
    ['find-renames', LINES, '[merge]\n\trenames = false\n', 'merge'],
  ])('Given -X %s over a rename against an edit', (option, moved, config, expected) => {
    describe('When merged', () => {
      it(`Then the merge ${expected === 'merge' ? 'follows the rename' : 'stops on modify/delete'}`, async () => {
        // Arrange
        const ctx = await renameVsEdit(moved, config);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side', strategyOptions: [option], author });

        // Assert
        expect(result.kind).toBe(expected);
      });
    });
  });

  describe('Given an option no strategy parses', () => {
    describe('When ort merges', () => {
      it('Then it refuses with the option', async () => {
        // Arrange
        const ctx = await renameVsEdit(LINES);
        const sut = mergeRun;

        // Act
        const result = await errorData(
          sut(ctx, { rev: 'side', strategyOptions: ['find-renames', 'bogus'], author }),
        );

        // Assert
        expect(result).toEqual({ code: 'UNKNOWN_STRATEGY_OPTION', option: 'bogus' });
      });
    });

    describe('When the merge fast-forwards', () => {
      it('Then no strategy runs and the option is never read', async () => {
        // Arrange
        const ctx = await renameVsEdit(LINES);
        await branchCreate(ctx, { name: 'ahead' });
        await checkout(ctx, { rev: 'ahead' });
        await write(ctx, 'g', 'g\n');
        await commitAll(ctx, ['g'], 'ahead');
        await checkout(ctx, { rev: 'main' });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'ahead', strategyOptions: ['bogus'], author });

        // Assert
        expect(result.kind).toBe('fast-forward');
      });
    });
  });

  describe.each([
    ['ours', LINES.replace('7\n', 'seven\n')],
    ['theirs', LINES.replace('7\n', 'SEVEN\n')],
  ])('Given -X %s over an edit both sides made to one line', (option, expected) => {
    describe('When merged', () => {
      it('Then the merge commits that side of the line', async () => {
        // Arrange
        const ctx = await bothEditLineSeven();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side', strategyOptions: [option], author });

        // Assert
        expect(result.kind).toBe('merge');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/big`)).toBe(expected);
      });
    });
  });

  describe.each([
    ['-X renormalize', '', ['renormalize'], 'merge'],
    ['no option', '', [], 'conflict'],
    ['merge.renormalize=true', '[merge]\n\trenormalize = true\n', [], 'merge'],
    [
      'merge.renormalize=true and -X no-renormalize',
      '[merge]\n\trenormalize = true\n',
      ['no-renormalize'],
      'conflict',
    ],
    [
      'merge.renormalize=false and -X renormalize',
      '[merge]\n\trenormalize = false\n',
      ['renormalize'],
      'merge',
    ],
  ] as const)('Given %s', (_label, config, strategyOptions, expected) => {
    describe('When ort merges', () => {
      it(`Then the merge is a ${expected}`, async () => {
        // Arrange
        const ctx = await renormalizingHistory(config, 'edit');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side', strategyOptions, author });

        // Assert
        expect(result.kind).toBe(expected);
      });
    });
  });

  describe('Given the CRLF history and -X renormalize', () => {
    describe('When ort merges', () => {
      it('Then f holds the line-1 edit and the line-3 edit in LF', async () => {
        // Arrange
        const ctx = await renormalizingHistory('', 'edit');
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: 'side', strategyOptions: ['renormalize'], author });

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('A\nb\nC\n');
      });
    });
  });

  describe.each([[[]], [['renormalize']]] as const)(
    'Given merge.renormalize = foo and -X %j',
    (strategyOptions) => {
      describe('When ort merges', () => {
        it('Then it refuses the unparsable boolean', async () => {
          // Arrange
          const ctx = await renormalizingHistory('[merge]\n\trenormalize = foo\n', 'edit');
          const sut = mergeRun;

          // Act
          const result = (await errorData(sut(ctx, { rev: 'side', strategyOptions, author }))) as {
            readonly code: string;
            readonly key: string;
            readonly value: string;
          };

          // Assert
          expect(result.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
          expect(result.key).toBe('merge.renormalize');
          expect(result.value).toBe('foo');
        });
      });
    },
  );

  describe('Given the history where side only renormalizes f and main deletes it', () => {
    describe('When ort merges with -X renormalize', () => {
      it('Then the merge is clean and f stays deleted', async () => {
        // Arrange
        const ctx = await renormalizingHistory('', 'delete');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side', strategyOptions: ['renormalize'], author });

        // Assert
        expect(result.kind).toBe('merge');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/f`)).toBe(false);
      });
    });
  });

  describe('Given strategy resolve with an option and a file-level merge to make', () => {
    describe('When merged', () => {
      it("Then resolve fails as git's read-tree refuses the option", async () => {
        // Arrange
        const ctx = await renameVsEdit(LINES);
        const sut = mergeRun;

        // Act
        const result = await errorData(
          sut(ctx, { rev: 'side', strategy: 'resolve', strategyOptions: ['no-renames'], author }),
        );

        // Assert
        expect(result).toEqual({ code: 'MERGE_STRATEGY_FAILED', strategy: 'resolve' });
      });
    });
  });

  describe.each([
    ['unset', '', [], HISTOGRAM_MERGE],
    ['myers', '[diff]\n\talgorithm = myers\n', [], MYERS_MERGE],
    ['Default', '[diff]\n\talgorithm = Default\n', [], MYERS_MERGE],
    ['PATIENCE', '[diff]\n\talgorithm = PATIENCE\n', [], PATIENCE_MERGE],
    ['myers under -X histogram', '[diff]\n\talgorithm = myers\n', ['histogram'], HISTOGRAM_MERGE],
  ] as const)('Given diff.algorithm %s', (_label, config, strategyOptions, expected) => {
    describe('When ort merges content both sides changed', () => {
      it('Then the content merge diffs with the algorithm git picks', async () => {
        // Arrange
        const ctx = await algorithmSensitive(config);
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: 'side', strategyOptions, author });

        // Assert
        const result = await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`);
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given diff.algorithm names no algorithm', () => {
    describe('When merged', () => {
      it('Then it refuses naming the key, value and line, before any merge state', async () => {
        // Arrange
        const ctx = await algorithmSensitive(
          '[core]\n\tbare = false\n[diff]\n\talgorithm = bogus\n',
        );
        const sut = mergeRun;

        // Act
        const result = await errorData(sut(ctx, { rev: 'side', author }));

        // Assert
        expect(result).toEqual({
          code: 'CONFIG_UNKNOWN_VALUE',
          key: 'diff.algorithm',
          value: 'bogus',
          source: `${ctx.layout.gitDir}/config`,
          line: 4,
        });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given a valueless diff.algorithm', () => {
    describe('When merged', () => {
      it('Then it refuses as a missing value', async () => {
        // Arrange
        const ctx = await algorithmSensitive('[diff]\n\talgorithm\n');
        const sut = mergeRun;

        // Act
        const result = await errorData(sut(ctx, { rev: 'side', author }));

        // Assert
        expect(result).toEqual({
          code: 'CONFIG_MISSING_VALUE',
          key: 'diff.algorithm',
          source: `${ctx.layout.gitDir}/config`,
          line: 2,
        });
      });
    });
  });
});
