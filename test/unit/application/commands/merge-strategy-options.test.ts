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

const SIMILAR = LINES.replace('1\n', 'one\n');

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

  describe('Given an option git knows that tsgit does not run yet', () => {
    describe('When ort merges', () => {
      it('Then it refuses as unsupported', async () => {
        // Arrange
        const ctx = await renameVsEdit(LINES);
        const sut = mergeRun;

        // Act
        const result = await errorData(
          sut(ctx, { rev: 'side', strategyOptions: ['subtree'], author }),
        );

        // Assert
        expect(result).toEqual({
          code: 'UNSUPPORTED_OPERATION',
          operation: 'merge',
          reason: '-Xsubtree',
        });
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
});
