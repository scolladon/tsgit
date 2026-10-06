import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'a',
  email: 'a@x',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0130',
};
const HEAD = 'HEAD' as RefName;

const commitFile = async (ctx: Context, file: string, message: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${file}`, file);
  await add(ctx, [file]);
  return (await commit(ctx, { message, author })).id;
};

interface Repo {
  readonly ctx: Context;
  readonly one: ObjectId;
  readonly two: ObjectId;
  readonly main: ObjectId;
}

/** feature adds `one` then `two` over `base`; main adds `on-main` unless `fastForwardable`. */
const repo = async (fastForwardable = false): Promise<Repo> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const base = await commitFile(ctx, 'a.txt', 'base');
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  const one = await commitFile(ctx, 'one.txt', 'one');
  const two = await commitFile(ctx, 'two.txt', 'two');
  await checkout(ctx, { rev: 'main' });
  const main = fastForwardable ? base : await commitFile(ctx, 'c.txt', 'on-main');
  return { ctx, one, two, main };
};

const lastNote = async (ctx: Context): Promise<string | undefined> =>
  (await readReflog(ctx, HEAD)).at(-1)?.message;

const treeOf = async (ctx: Context, id: ObjectId): Promise<ObjectId | undefined> => {
  const read = await readObject(ctx, id);
  return read.type === 'commit' ? read.data.tree : undefined;
};

const errorData = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (e: unknown) => (e as TsgitError).data,
  );

/** main and feature both rewrite a.txt, on different lines. */
const bothEdit = async (conflicting: boolean): Promise<Repo> => {
  const built = await repo();
  const { ctx } = built;
  const edit = async (branch: string, body: string): Promise<ObjectId> => {
    await checkout(ctx, { rev: branch });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, body);
    await add(ctx, ['a.txt']);
    return (await commit(ctx, { message: `edit on ${branch}`, author })).id;
  };
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, '1\n2\n3\n4\n5\n6\n');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'lines', author });
  await branchCreate(ctx, { name: 'edits' });
  const two = await edit('edits', conflicting ? '1\nX\n3\n4\n5\n6\n' : '1\nX\n3\n4\n5\n6\n');
  const main = await edit('main', conflicting ? '1\nY\n3\n4\n5\n6\n' : '1\n2\n3\n4\n5\nY\n');
  return { ...built, two, main };
};

describe('merge strategy', () => {
  describe('Given a strategy git does not know', () => {
    describe('When merged', () => {
      it("Then it refuses with git's available strategies, before writing anything", async () => {
        // Arrange
        const { ctx } = await repo();
        const sut = mergeRun;

        // Act
        const result = await errorData(sut(ctx, { rev: 'feature', strategy: 'bogus', author }));

        // Assert
        expect(result).toEqual({
          code: 'UNKNOWN_MERGE_STRATEGY',
          strategy: 'bogus',
          available: ['octopus', 'ours', 'recursive', 'resolve', 'subtree'],
        });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
      });
    });
  });

  describe.each([
    ['ort', "Merge made by the 'ort' strategy."],
    ['recursive', "Merge made by the 'recursive' strategy."],
    ['resolve', 'In-index merge'],
    ['octopus', 'In-index merge'],
  ])('Given HEAD diverged from a branch and strategy %s', (strategy, note) => {
    describe('When merged', () => {
      it("Then the default merge's tree is committed under the strategy's reflog note", async () => {
        // Arrange
        const { ctx, two, main } = await repo();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', strategy, author });

        // Assert
        expect(result.kind === 'merge' && result.parents).toEqual([main, two]);
        expect(await lastNote(ctx)).toBe(`merge feature: ${note}`);
      });
    });
  });

  describe('Given both sides edit one file on different lines and strategy resolve', () => {
    describe('When merged', () => {
      it("Then the file merges and the reflog names the 'resolve' strategy", async () => {
        // Arrange
        const { ctx } = await bothEdit(false);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'edits', strategy: 'resolve', author });

        // Assert
        expect(result.kind).toBe('merge');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`)).toBe('1\nX\n3\n4\n5\nY\n');
        expect(await lastNote(ctx)).toBe("merge edits: Merge made by the 'resolve' strategy.");
      });
    });
  });

  describe('Given both sides edit one line and strategy resolve', () => {
    describe('When merged', () => {
      it('Then it stops on the conflict with MERGE_HEAD', async () => {
        // Arrange
        const { ctx, two, main } = await bothEdit(true);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'edits', strategy: 'resolve', author });

        // Assert
        expect(result).toEqual({
          kind: 'conflict',
          conflicts: [{ path: 'a.txt', type: 'content' }],
          mergeHead: two,
          origHead: main,
        });
      });
    });
  });

  describe('Given both sides edit one file and strategy octopus on one head', () => {
    describe('When merged', () => {
      it('Then the strategy fails as git does and HEAD stays', async () => {
        // Arrange
        const { ctx, main } = await bothEdit(false);
        const sut = mergeRun;

        // Act
        const result = await errorData(sut(ctx, { rev: 'edits', strategy: 'octopus', author }));

        // Assert
        expect(result).toEqual({ code: 'MERGE_STRATEGY_FAILED', strategy: 'octopus' });
        expect(await resolveRef(ctx, HEAD)).toBe(main);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given unrelated histories and strategy resolve', () => {
    describe('When merged with allowUnrelatedHistories', () => {
      it('Then the strategy fails as git-merge-resolve does on a baseless merge', async () => {
        // Arrange
        const { ctx, main, one } = await repo();
        const tree = (await treeOf(ctx, one))!;
        const root = { tree, parents: [], author, committer: author, message: 'root\n' };
        const other = await createCommit(ctx, { ...root, extraHeaders: [] });
        await updateRef(ctx, 'refs/heads/other' as RefName, other, { reflogMessage: 'root' });
        const sut = mergeRun;

        // Act
        const result = await errorData(
          sut(ctx, { rev: 'other', strategy: 'resolve', allowUnrelatedHistories: true, author }),
        );

        // Assert
        expect(result).toEqual({ code: 'MERGE_STRATEGY_FAILED', strategy: 'resolve' });
        expect(await resolveRef(ctx, HEAD)).toBe(main);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given strategy ours', () => {
    describe.each([
      ['diverged from', false],
      ['fast-forwardable to', true],
    ])('When HEAD %s the branch is merged', (_label, fastForwardable) => {
      it("Then HEAD's tree is committed with both parents", async () => {
        // Arrange
        const { ctx, two, main } = await repo(fastForwardable);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', strategy: 'ours', author });

        // Assert
        expect(result.kind === 'merge' && result.parents).toEqual([main, two]);
        const merged = result.kind === 'merge' ? result.id : main;
        expect(await treeOf(ctx, merged)).toBe(await treeOf(ctx, main));
        expect(await lastNote(ctx)).toBe("merge feature: Merge made by the 'ours' strategy.");
      });
    });

    describe('When two heads are merged', () => {
      it("Then HEAD's tree is committed with every parent", async () => {
        // Arrange
        const { ctx, one, two, main } = await repo();
        await branchCreate(ctx, { name: 'other', startPoint: one });
        await checkout(ctx, { rev: 'other' });
        const other = await commitFile(ctx, 'o.txt', 'oo');
        await checkout(ctx, { rev: 'main' });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: ['feature', 'other'], strategy: 'ours', author });

        // Assert
        expect(result.kind === 'merge' && result.parents).toEqual([main, two, other]);
        const merged = result.kind === 'merge' ? result.id : main;
        expect(await treeOf(ctx, merged)).toBe(await treeOf(ctx, main));
      });
    });
  });

  describe('Given strategy subtree over sides that already line up', () => {
    describe('When merged', () => {
      it('Then ort merges them without a shift, as git does', async () => {
        // Arrange
        const { ctx } = await repo();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', strategy: 'subtree', author });

        // Assert
        expect(result.kind).toBe('merge');
      });
    });
  });

  describe('Given strategy ort and two heads', () => {
    describe('When merged', () => {
      it('Then the strategy fails as git does', async () => {
        // Arrange
        const { ctx, one } = await repo();
        await branchCreate(ctx, { name: 'other', startPoint: one });
        await checkout(ctx, { rev: 'other' });
        await commitFile(ctx, 'o.txt', 'oo');
        await checkout(ctx, { rev: 'main' });
        const sut = mergeRun;

        // Act
        const result = await errorData(
          sut(ctx, { rev: ['feature', 'other'], strategy: 'ort', author }),
        );

        // Assert
        expect(result).toEqual({ code: 'MERGE_STRATEGY_FAILED', strategy: 'ort' });
      });
    });
  });
});
