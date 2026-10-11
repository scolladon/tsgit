import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../../src/application/commands/branch.js';
import { checkout } from '../../../../../src/application/commands/checkout.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import { rebaseMergesTodo } from '../../../../../src/application/commands/internal/rebase-merges-todo.js';
import { mergeRun } from '../../../../../src/application/commands/merge.js';
import { resolveRef } from '../../../../../src/application/primitives/resolve-ref.js';
import type { ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const AUTHOR = { name: 'Feat', email: 'feat@y', timestamp: 100, timezoneOffset: '+0000' };
const ABBREV = 10;

const newRepo = async (config = ''): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(
    `${ctx.layout.gitDir}/config`,
    `\n[user]\n\tname = Ada\n\temail = a@x\n${config}`,
  );
  return ctx;
};

const commitFile = async (
  ctx: Context,
  name: string,
  body = `${name}\n`,
  message = name,
): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, body);
  await add(ctx, [name]);
  return (await commit(ctx, { message, author: AUTHOR })).id;
};

const tip = (ctx: Context, name: string): Promise<ObjectId> =>
  resolveRef(ctx, `refs/heads/${name}` as RefName);

const todoOf = async (ctx: Context, rebaseCousins = false) =>
  rebaseMergesTodo(ctx, {
    upstream: await tip(ctx, 'main'),
    head: await tip(ctx, 'topic'),
    rebaseCousins,
  });

describe('rebaseMergesTodo', () => {
  describe('Given a merged side branch whose merge message does not name it', () => {
    describe('When the todo is generated', () => {
      it('Then the label is the branch name, as git decorates it', async () => {
        // Arrange
        const ctx = await newRepo();
        await commitFile(ctx, 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { rev: 'topic' });
        await commitFile(ctx, 'c1');
        await branchCreate(ctx, { name: 'side' });
        await checkout(ctx, { rev: 'side' });
        await commitFile(ctx, 'y');
        await checkout(ctx, { rev: 'topic' });
        await commitFile(ctx, 'c2');
        await mergeRun(ctx, {
          rev: 'side',
          fastForward: 'never',
          author: AUTHOR,
          message: 'Merge feature work\n',
        });
        await checkout(ctx, { rev: 'main' });
        await commitFile(ctx, 'u1');
        await checkout(ctx, { rev: 'topic' });
        const sut = todoOf;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.filter((line) => line.action === 'label').map((line) => line.label)).toEqual([
          'onto',
          'branch-point',
          'side',
        ]);
        expect(result.at(-1)).toMatchObject({ action: 'merge', labels: ['side'] });
      });
    });
  });

  describe('Given a block forking from a commit outside the range and core.abbrev set', () => {
    describe('When the todo is generated without rebasing cousins', () => {
      it('Then the block resets to the fork abbreviated as configured, with its subject', async () => {
        // Arrange
        const ctx = await newRepo(`[core]\n\tabbrev = ${ABBREV}\n`);
        const base = await commitFile(ctx, 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { rev: 'topic' });
        await commitFile(ctx, 'c1');
        await checkout(ctx, { rev: 'main' });
        await commitFile(ctx, 'm1');
        await branchCreate(ctx, { name: 'side' });
        await checkout(ctx, { rev: 'side' });
        await commitFile(ctx, 's1');
        await checkout(ctx, { rev: 'topic' });
        await mergeRun(ctx, {
          rev: 'side',
          fastForward: 'never',
          author: AUTHOR,
          message: 'Merge feature work\n',
        });
        await checkout(ctx, { rev: 'main' });
        await commitFile(ctx, 'u1');
        await checkout(ctx, { rev: 'topic' });
        const sut = todoOf;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.filter((line) => line.action === 'reset')).toMatchObject([
          { label: 'onto' },
          { label: base.slice(0, ABBREV), subject: 'base' },
        ]);
      });
    });
  });

  describe('Given a topic commit whose patch the upstream already carries', () => {
    describe('When the todo is generated', () => {
      it('Then only the commit upstream lacks is picked', async () => {
        // Arrange
        const ctx = await newRepo();
        await commitFile(ctx, 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { rev: 'topic' });
        await commitFile(ctx, 'p', 'same\n', 'p1');
        const t2 = await commitFile(ctx, 't2');
        await checkout(ctx, { rev: 'main' });
        await commitFile(ctx, 'p', 'same\n', 'p-again');
        await commitFile(ctx, 'u1');
        await checkout(ctx, { rev: 'topic' });
        const sut = todoOf;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([
          { action: 'label', label: 'onto' },
          { action: 'reset', label: 'onto' },
          { action: 'pick', oid: t2, subject: 't2' },
        ]);
      });
    });
  });

  describe('Given a topic commit that starts empty', () => {
    describe('When the todo is generated', () => {
      it('Then the empty commit is picked, as git keeps it by default', async () => {
        // Arrange
        const ctx = await newRepo();
        await commitFile(ctx, 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { rev: 'topic' });
        const t1 = await commitFile(ctx, 't1');
        const empty = (await commit(ctx, { message: 'empty', author: AUTHOR, allowEmpty: true }))
          .id;
        await checkout(ctx, { rev: 'main' });
        await commitFile(ctx, 'u1');
        await checkout(ctx, { rev: 'topic' });
        const sut = todoOf;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.filter((line) => line.action === 'pick')).toEqual([
          { action: 'pick', oid: t1, subject: 't1' },
          { action: 'pick', oid: empty, subject: 'empty' },
        ]);
      });
    });
  });
});
