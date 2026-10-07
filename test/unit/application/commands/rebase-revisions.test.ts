import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { rebaseRun } from '../../../../src/application/commands/rebase.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR = { name: 'Ada', email: 'a@x', timestamp: 1_700_000_000, timezoneOffset: '+0000' };

const commitFile = async (ctx: Context, name: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, `${name}\n`);
  await add(ctx, [name]);
  return (await commit(ctx, { message: name, author: AUTHOR, committer: AUTHOR })).id;
};

/** main: a-b-c-d, `side` at b, annotated `ta` at c. */
const seedLinear = async (): Promise<{ ctx: Context; commits: ReadonlyArray<ObjectId> }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Ada\n\temail = a@x\n');
  const commits: ObjectId[] = [];
  for (const name of ['a', 'b', 'c', 'd']) commits.push(await commitFile(ctx, name));
  await branchCreate(ctx, { name: 'side', startPoint: commits[1] as ObjectId });
  await tagCreate(ctx, { name: 'ta', target: commits[2] as ObjectId, message: 't' });
  return { ctx, commits };
};

const headParent = async (ctx: Context): Promise<ObjectId | undefined> => {
  const head = await readObject(ctx, await resolveRef(ctx, 'HEAD' as RefName));
  return head.type === 'commit' ? head.data.parents[0] : undefined;
};

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as TsgitError).data;
  }
};

describe('rebaseRun revisions', () => {
  describe('Given an upstream spelt as a revision expression', () => {
    describe.each(['HEAD~1', 'main^', 'ta'])('When rebasing onto %s', (upstream) => {
      it('Then it resolves the revision to its commit and is up to date', async () => {
        // Arrange
        const { ctx } = await seedLinear();
        const sut = rebaseRun;

        // Act
        const result = await sut(ctx, { upstream });

        // Assert
        expect(result).toEqual({ kind: 'up-to-date' });
      });
    });
  });

  describe('Given an upstream naming no commit', () => {
    describe.each(['absent', 'HEAD^{tree}', 'HEAD~1:a'])('When rebasing onto %s', (upstream) => {
      it('Then it refuses the upstream as invalid', async () => {
        // Arrange
        const { ctx } = await seedLinear();

        // Act
        const result = await refusalOf(() => rebaseRun(ctx, { upstream }));

        // Assert
        expect(result).toEqual({
          code: 'REBASE_REVISION_INVALID',
          reason: 'invalid-upstream',
          revision: upstream,
        });
      });
    });
  });

  describe('Given an onto naming no commit', () => {
    describe.each(['absent', 'HEAD~1:a'])('When rebasing with onto %s', (onto) => {
      it('Then it refuses the onto as no valid commit', async () => {
        // Arrange
        const { ctx } = await seedLinear();

        // Act
        const result = await refusalOf(() => rebaseRun(ctx, { upstream: 'HEAD~1', onto }));

        // Assert
        expect(result).toEqual({
          code: 'REBASE_REVISION_INVALID',
          reason: 'invalid-onto',
          revision: onto,
        });
      });
    });
  });

  describe('Given an onto spelt as a symmetric range', () => {
    describe.each(['side...main', '...side', 'side...'])('When rebasing with onto %s', (onto) => {
      it('Then it replays onto the sole merge base of its sides', async () => {
        // Arrange
        const { ctx, commits } = await seedLinear();

        // Act
        await rebaseRun(ctx, { upstream: 'HEAD~1', onto });
        const result = await headParent(ctx);

        // Assert
        expect(result).toBe(commits[1]);
      });
    });
  });

  describe('Given a symmetric-range onto whose sides share no single merge base', () => {
    describe.each(['absent...main', 'main...absent', 'main...criss'])(
      'When rebasing with onto %s',
      (onto) => {
        it('Then it refuses the onto as needing exactly one merge base', async () => {
          // Arrange
          const { ctx } = await seedLinear();
          await seedCrissCross(ctx);

          // Act
          const result = await refusalOf(() => rebaseRun(ctx, { upstream: 'HEAD~1', onto }));

          // Assert
          expect(result).toEqual({
            code: 'REBASE_REVISION_INVALID',
            reason: 'onto-merge-base-not-unique',
            revision: onto,
          });
        });
      },
    );
  });

  describe('Given a branch tracking main, When rebased onto its @{u}', () => {
    it('Then it replays the branch onto main', async () => {
      // Arrange
      const { ctx, commits } = await seedLinear();
      await checkout(ctx, { rev: 'side', createBranch: { name: 'feat' } });
      await commitFile(ctx, 'f');
      await ctx.fs.appendUtf8(
        `${ctx.layout.gitDir}/config`,
        '\n[branch "feat"]\n\tremote = .\n\tmerge = refs/heads/main\n',
      );

      // Act
      await rebaseRun(ctx, { upstream: '@{u}' });
      const result = await headParent(ctx);

      // Assert
      expect(result).toBe(commits[3]);
    });
  });
});

/** `criss` and `main` each merge the other's side: two merge bases. */
const seedCrissCross = async (ctx: Context): Promise<void> => {
  await checkout(ctx, { rev: 'side', createBranch: { name: 'criss' } });
  await commitFile(ctx, 'x');
  await mergeRun(ctx, { rev: 'main~1', message: 'm1' });
  await checkout(ctx, { rev: 'main' });
  await mergeRun(ctx, { rev: 'criss~1', message: 'm2' });
};
