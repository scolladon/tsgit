import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { type MergeRunInput, mergeRun } from '../../../../src/application/commands/merge.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
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

/** main and side diverge: side adds `s` and rewrites `f`; main adds `m` and, when `conflict`, rewrites `f` too. */
const diverged = async (config: string, conflict: boolean): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(
    `${ctx.layout.gitDir}/config`,
    `\n[user]\n\tname = Ada\n\temail = a@x\n${config}`,
  );
  await commitFile(ctx, 'f', 'base\n');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  await commitFile(ctx, 's', 's\n');
  await commitFile(ctx, 'f', 'side\n');
  await checkout(ctx, { rev: 'main' });
  await commitFile(ctx, 'm', 'm\n');
  if (conflict) await commitFile(ctx, 'f', 'main\n');
  return ctx;
};

const lastReflogNote = async (ctx: Context): Promise<string | undefined> =>
  (await readReflog(ctx, 'HEAD' as RefName)).at(-1)?.message;

describe('mergeRun with branch.<b>.mergeoptions over the caller’s options', () => {
  describe.each([
    [
      'a strategy that cannot merge, then the caller’s ort',
      mergeOptions('main', '-s octopus'),
      { strategy: 'ort' },
      "merge side: Merge made by the 'ort' strategy.",
    ],
    [
      'ours, then the caller’s ort',
      mergeOptions('main', '-s ours'),
      { strategy: 'ort' },
      "merge side: Merge made by the 'ours' strategy.",
    ],
    [
      'ours alone',
      mergeOptions('main', '-s ours'),
      {},
      "merge side: Merge made by the 'ours' strategy.",
    ],
  ] as const)('Given a branch strategy of %s', (_, config, given, note) => {
    describe('When merged', () => {
      it('Then the strategies run in order, the branch’s first', async () => {
        // Arrange
        const ctx = await diverged(config, false);
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: 'side', author: AUTHOR, ...given });

        // Assert
        expect(await lastReflogNote(ctx)).toBe(note);
      });
    });
  });

  describe('Given a branch -Xours and a caller -X option', () => {
    describe('When a conflicting merge runs', () => {
      it('Then both options apply and the conflict resolves to our side', async () => {
        // Arrange
        const ctx = await diverged(mergeOptions('main', '-Xours'), true);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, {
          rev: 'side',
          author: AUTHOR,
          strategyOptions: ['patience'],
        });

        // Assert
        expect(result.kind).toBe('merge');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('main\n');
      });
    });
  });
});
