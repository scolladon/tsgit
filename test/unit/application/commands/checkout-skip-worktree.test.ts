import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import type { GitIndex } from '../../../../src/domain/git-index/index.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const SKIP_WORKTREE_PATH = 'sw.txt';
const PLAIN_PATH = 'n.txt';

/** Commits both files, marks `sw.txt` skip-worktree, then dirties both in the working tree. */
const seedSkipWorktree = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${SKIP_WORKTREE_PATH}`, 'sw');
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${PLAIN_PATH}`, 'n');
  await add(ctx, [SKIP_WORKTREE_PATH, PLAIN_PATH]);
  await commit(ctx, { message: 'first', author });
  const index = await readIndex(ctx);
  const marked: GitIndex = {
    ...index,
    entries: index.entries.map((entry) =>
      entry.path === SKIP_WORKTREE_PATH
        ? { ...entry, flags: { ...entry.flags, skipWorktree: true } }
        : entry,
    ),
  };
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, await serializeIndexFixtureAsync(marked, ctx));
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${SKIP_WORKTREE_PATH}`, 'sw-dirty');
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${PLAIN_PATH}`, 'n-dirty');
  return ctx;
};

type SeededCtx = Awaited<ReturnType<typeof seedSkipWorktree>>;

const workText = (ctx: SeededCtx, path: string) => ctx.fs.readUtf8(`${ctx.layout.workDir}/${path}`);

const skipWorktreeOf = async (ctx: SeededCtx, path: string) =>
  (await readIndex(ctx)).entries.find((entry) => entry.path === path)?.flags.skipWorktree;

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    if (err instanceof TsgitError) return err.data;
    throw err;
  }
  return undefined;
};

const SOURCES = [
  { sourceLabel: 'the index', options: {} },
  { sourceLabel: 'HEAD', options: { source: 'HEAD' } },
];

describe.each(SOURCES)(
  'checkout path restore from $sourceLabel over skip-worktree entries',
  ({ options }) => {
    describe.each([
      { spec: ['sw*'], unmatched: ['sw*'] },
      { spec: ['sw.txt'], unmatched: ['sw.txt'] },
      { spec: ['sw.txt', 'n.txt'], unmatched: ['sw.txt'] },
      { spec: ['sw*', 'n*'], unmatched: ['sw*'] },
    ])('Given a skip-worktree file and a plain one, both modified', ({ spec, unmatched }) => {
      describe(`When ${'$spec'} is restored`, () => {
        it('Then it refuses and leaves both files and the bit alone', async () => {
          // Arrange
          const ctx = await seedSkipWorktree();
          const sut = checkout;

          // Act
          const data = await refusalOf(() => sut(ctx, { paths: spec, ...options }));

          // Assert
          const [pattern] = unmatched;
          expect(data).toEqual({ code: 'PATHSPEC_NO_MATCH', pattern, patterns: unmatched });
          expect(await workText(ctx, SKIP_WORKTREE_PATH)).toBe('sw-dirty');
          expect(await workText(ctx, PLAIN_PATH)).toBe('n-dirty');
          expect(await skipWorktreeOf(ctx, SKIP_WORKTREE_PATH)).toBe(true);
        });
      });
    });

    describe.each([{ spec: ['*.txt'] }, { spec: ['.'] }])(
      'Given a skip-worktree file and a plain one, both modified',
      ({ spec }) => {
        describe(`When ${'$spec'} is restored`, () => {
          it('Then only the plain file is restored and the bit stays', async () => {
            // Arrange
            const ctx = await seedSkipWorktree();
            const sut = checkout;

            // Act
            await sut(ctx, { paths: spec, ...options });

            // Assert
            expect(await workText(ctx, PLAIN_PATH)).toBe('n');
            expect(await workText(ctx, SKIP_WORKTREE_PATH)).toBe('sw-dirty');
            expect(await skipWorktreeOf(ctx, SKIP_WORKTREE_PATH)).toBe(true);
          });
        });
      },
    );
  },
);
