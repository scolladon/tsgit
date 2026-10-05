import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { tagCreate, tagDelete } from '../../../../src/application/commands/tag.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateConfigEntries } from '../../../../src/application/primitives/update-config.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const MAIN = 'refs/heads/main' as RefName;

const commitFile = async (ctx: Context, path: string, message: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, `${message}\n`);
  await add(ctx, [path]);
  return (await commit(ctx, { message, author })).id;
};

interface Seeded {
  readonly ctx: Context;
  readonly main: ObjectId;
  readonly feature: ObjectId;
}

/** `feature` one commit ahead of `main`; `diverged` adds a commit of main's own. */
const seed = async (diverged: boolean): Promise<Seeded> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await commitFile(ctx, 'base.txt', 'base');
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  const feature = await commitFile(ctx, 'feature.txt', 'feature');
  await checkout(ctx, { rev: 'main' });
  if (diverged) await commitFile(ctx, 'main.txt', 'main');
  return { ctx, main: await resolveRef(ctx, MAIN), feature };
};

const configureMergeFf = (ctx: Context, value: string | null): Promise<void> =>
  value === null
    ? ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[merge]\n\tff\n',
      )
    : updateConfigEntries(ctx, [{ section: 'merge', key: 'ff', value }]);

describe('merge reads merge.ff, as git does', () => {
  describe.each([
    ['false', 'merge'],
    ['no', 'merge'],
    ['off', 'merge'],
    ['0', 'merge'],
    ['', 'merge'],
    ['true', 'fast-forward'],
    ['yes', 'fast-forward'],
    ['2', 'fast-forward'],
    ['only', 'fast-forward'],
    ['ONLY', 'fast-forward'],
    ['bogus', 'fast-forward'],
    [null, 'fast-forward'],
  ] as const)('Given merge.ff=%s over a fast-forwardable head', (value, kind) => {
    describe('When merge runs without a fast-forward policy', () => {
      it(`Then the merge concludes as a ${kind}`, async () => {
        // Arrange
        const { ctx } = await seed(false);
        await configureMergeFf(ctx, value);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', author });

        // Assert
        expect(result.kind).toBe(kind);
      });
    });
  });

  describe('Given merge.ff=only over a diverged head', () => {
    describe('When merge runs without a fast-forward policy', () => {
      it('Then it refuses with NON_FAST_FORWARD', async () => {
        // Arrange
        const { ctx, main, feature } = await seed(true);
        await configureMergeFf(ctx, 'only');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', author }).catch((error: unknown) => error);

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'NON_FAST_FORWARD',
          ref: MAIN,
          local: main,
          remote: feature,
        });
      });
    });

    describe('When merge runs with fastForward never', () => {
      it('Then the caller policy wins and a merge commit is made', async () => {
        // Arrange
        const { ctx } = await seed(true);
        await configureMergeFf(ctx, 'only');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', fastForward: 'never', author });

        // Assert
        expect(result.kind).toBe('merge');
      });
    });
  });

  describe('Given merge.ff=false over a fast-forwardable head', () => {
    describe('When merge runs with fastForward allow', () => {
      it('Then the caller policy wins and the merge fast-forwards', async () => {
        // Arrange
        const { ctx } = await seed(false);
        await configureMergeFf(ctx, 'false');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', fastForward: 'allow', author });

        // Assert
        expect(result.kind).toBe('fast-forward');
      });
    });
  });

  describe('Given merge.ff=only and a throwaway annotated tag over a fast-forwardable head', () => {
    describe('When merge runs without a fast-forward policy', () => {
      it('Then the configured ff-only keeps the fast-forward', async () => {
        // Arrange
        const { ctx, feature } = await seed(false);
        await updateConfigEntries(ctx, [
          { section: 'user', key: 'name', value: author.name },
          { section: 'user', key: 'email', value: author.email },
        ]);
        const tag = await tagCreate(ctx, { name: 'v1', target: 'feature', message: 'v1' });
        await tagDelete(ctx, { name: 'v1' });
        await configureMergeFf(ctx, 'only');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: tag.id, author });

        // Assert
        expect(result).toEqual({ kind: 'fast-forward', id: feature, branch: MAIN });
      });
    });
  });
});
