import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
import { add } from '../../../../src/application/commands/add.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { acquireIndexLock } from '../../../../src/application/primitives/internal/index-lock.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

type Stage = 1 | 2 | 3;
const EVERY_STAGE: ReadonlyArray<Stage> = [1, 2, 3];

const write = (ctx: Context, rel: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${rel}`, content);

const stagesOf = (entry: IndexEntry, stages: ReadonlyArray<Stage>): IndexEntry[] =>
  stages.map((stage) => ({ ...entry, flags: { ...entry.flags, stage } }));

/** Commits `f`, `g` and `keep`, then replaces each named path's entry by the given stages. */
const seed = async (
  unmerged: Readonly<Record<string, ReadonlyArray<Stage>>>,
): Promise<{ ctx: Context; runner: MemoryHookRunner; seeded: number }> => {
  const runner = new MemoryHookRunner();
  const ctx = createMemoryContext({ hooks: runner });
  await init(ctx);
  for (const rel of ['f', 'g', 'keep']) await write(ctx, rel, `${rel}\n`);
  await add(ctx, ['f', 'g', 'keep']);
  await commit(ctx, { message: 'base', author, committer: author });
  const index = await readIndex(ctx);
  const entries = index.entries.flatMap((entry) => {
    const stages = unmerged[entry.path];
    return stages === undefined ? [entry] : stagesOf(entry, stages);
  });
  const lock = await acquireIndexLock(ctx);
  await lock.commit(entries, 'replace');
  await lock.release();
  return { ctx, runner, seeded: runner.calls.length };
};

const failureOf = async (run: Promise<unknown>): Promise<unknown> => {
  try {
    await run;
  } catch (err) {
    return (err as { data: unknown }).data;
  }
  return undefined;
};

describe('checkout path restore from the index', () => {
  describe('Given stages 1-3 of f', () => {
    describe('When the paths f and keep are restored from the index', () => {
      it('Then it refuses naming f, leaves the index and fires no hook', async () => {
        // Arrange
        const { ctx, runner, seeded } = await seed({ f: EVERY_STAGE });
        const before = await readIndex(ctx);

        // Act
        const sut = await failureOf(checkout(ctx, { paths: ['f', 'keep'] }));

        // Assert
        expect(sut).toMatchObject({ code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['f'] });
        expect((await readIndex(ctx)).entries).toEqual(before.entries);
        expect(runner.calls).toHaveLength(seeded);
      });
    });

    describe('When the path keep alone is restored from the index', () => {
      it('Then it proceeds and keeps the stages of f', async () => {
        // Arrange
        const { ctx, runner, seeded } = await seed({ f: EVERY_STAGE });

        // Act
        await checkout(ctx, { paths: ['keep'] });

        // Assert
        const stages = (await readIndex(ctx)).entries.map((e) => `${e.path}:${e.flags.stage}`);
        expect(stages).toEqual(['f:1', 'f:2', 'f:3', 'g:0', 'keep:0']);
        expect(runner.calls).toHaveLength(seeded + 1);
      });
    });

    describe('When f is restored from HEAD', () => {
      it('Then it proceeds and collapses f to one entry', async () => {
        // Arrange
        const { ctx } = await seed({ f: EVERY_STAGE });

        // Act
        await checkout(ctx, { source: 'HEAD', paths: ['f'] });

        // Assert
        const stages = (await readIndex(ctx)).entries.map((e) => `${e.path}:${e.flags.stage}`);
        expect(stages).toEqual(['f:0', 'g:0', 'keep:0']);
      });
    });

    describe('When an unmatched path and f are restored from the index', () => {
      it('Then the unmatched pathspec is refused first', async () => {
        // Arrange
        const { ctx } = await seed({ f: EVERY_STAGE });

        // Act
        const sut = await failureOf(checkout(ctx, { paths: ['nosuch', 'f'] }));

        // Assert
        expect(sut).toMatchObject({ code: 'PATHSPEC_NO_MATCH', pattern: 'nosuch' });
      });
    });
  });

  describe('Given stages 2-3 of f and g', () => {
    describe('When every path is restored from the index', () => {
      it('Then it refuses naming each path once in index order', async () => {
        // Arrange
        const { ctx } = await seed({ f: [2, 3], g: [2, 3] });

        // Act
        const sut = await failureOf(checkout(ctx, { paths: ['.'] }));

        // Assert
        expect(sut).toMatchObject({ code: 'MERGE_HAS_CONFLICTS', count: 2, paths: ['f', 'g'] });
      });
    });
  });
});
