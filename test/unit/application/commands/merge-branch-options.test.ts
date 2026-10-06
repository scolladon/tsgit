import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { type MergeRunInput, mergeRun } from '../../../../src/application/commands/merge.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR = { name: 'Ada', email: 'a@x', timestamp: 100, timezoneOffset: '+0000' };

const commitFile = async (ctx: Context, name: string, body: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, body);
  await add(ctx, [name]);
  return (await commit(ctx, { message: `${name} ${body.trim()}`, author: AUTHOR })).id;
};

/** side rewrites f off main; main stays put, so `side` fast-forwards unless told otherwise. */
const seed = async (config: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(
    `${ctx.layout.gitDir}/config`,
    `\n[user]\n\tname = Ada\n\temail = a@x\n${config}`,
  );
  await commitFile(ctx, 'f', 'base\n');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  await commitFile(ctx, 'f', 'side\n');
  await checkout(ctx, { rev: 'main' });
  return ctx;
};

const mergeOptions = (branch: string, value: string): string =>
  `[branch "${branch}"]\n\tmergeoptions = ${value}\n`;

const refusal = (ctx: Context, input: MergeRunInput): Promise<unknown> =>
  mergeRun(ctx, input)
    .then(() => undefined)
    .catch((e: unknown) => (e as TsgitError).data);

const headMessage = async (ctx: Context, id: ObjectId): Promise<string> => {
  const read = await readObject(ctx, id);
  return read.type === 'commit' ? read.data.message : '';
};

describe('mergeRun with branch.<b>.mergeoptions', () => {
  describe.each([
    ['--no-ff on the current branch', mergeOptions('main', '--no-ff'), {}, 'merge'],
    [
      '--no-ff with the caller allowing a fast-forward',
      mergeOptions('main', '--no-ff'),
      { fastForward: 'allow' },
      'fast-forward',
    ],
    ['--no-ff on another branch', mergeOptions('Main', '--no-ff'), {}, 'fast-forward'],
    [
      '--squash with the caller committing nothing else',
      mergeOptions('main', "'--squash'"),
      {},
      'squashed',
    ],
    ['no value', '[branch "main"]\n\tmergeoptions\n', {}, 'fast-forward'],
  ] as const)('Given %s', (_, config, given, kind) => {
    describe('When merged', () => {
      it('Then the branch options apply under the caller’s', async () => {
        // Arrange
        const ctx = await seed(config);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side', author: AUTHOR, ...given });

        // Assert
        expect(result.kind).toBe(kind);
      });
    });
  });

  describe('Given -m and --no-ff in mergeoptions and a caller message', () => {
    describe('When merged', () => {
      it('Then the messages join as paragraphs, the branch’s first', async () => {
        // Arrange
        const ctx = await seed(mergeOptions('main', "--no-ff -m 'from branch'"));
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side', author: AUTHOR, message: 'from caller' });

        // Assert
        expect(result.kind === 'merge' && (await headMessage(ctx, result.id))).toBe(
          'from branch\n\nfrom caller\n',
        );
      });
    });
  });

  describe.each([
    [
      'an unclosed quote',
      "'--no-ff",
      { code: 'BAD_BRANCH_MERGE_OPTIONS', branch: 'main', reason: 'unclosed quote' },
    ],
    ['an unknown option', '--bogus', { code: 'UNKNOWN_OPTION', option: '--bogus' }],
    [
      'an unknown strategy',
      '-s bogus',
      { code: 'UNKNOWN_MERGE_STRATEGY', strategy: 'bogus', available: expect.any(Array) },
    ],
  ])('Given mergeoptions with %s', (_, value, expected) => {
    describe('When merged', () => {
      it('Then it refuses before writing any merge state', async () => {
        // Arrange
        const ctx = await seed(mergeOptions('main', value));
        const sut = refusal;

        // Act
        const result = await sut(ctx, { rev: 'side' });

        // Assert
        expect(result).toEqual(expected);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
      });
    });
  });
});
