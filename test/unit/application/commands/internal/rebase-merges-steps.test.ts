import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../../src/application/commands/branch.js';
import { checkout } from '../../../../../src/application/commands/checkout.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  labelHead,
  recreateMerge,
} from '../../../../../src/application/commands/internal/rebase-merges-steps.js';
import { mergeRun } from '../../../../../src/application/commands/merge.js';
import { readObject } from '../../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../../src/application/primitives/resolve-ref.js';
import type { CommitData, ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const AUTHOR = { name: 'Feat', email: 'feat@y', timestamp: 100, timezoneOffset: '+0000' };
const REFLOG_ACTION = 'rebase';

const newRepo = async (config = ''): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(
    `${ctx.layout.gitDir}/config`,
    `\n[user]\n\tname = Ada\n\temail = a@x\n${config}`,
  );
  return ctx;
};

const commitFile = async (ctx: Context, name: string, message = name): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, `${name}\n`);
  await add(ctx, [name]);
  return (await commit(ctx, { message, author: AUTHOR })).id;
};

const readCommit = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw new Error('not a commit');
  return obj.data;
};

const tip = (ctx: Context, name: string): Promise<ObjectId> =>
  resolveRef(ctx, `refs/heads/${name}` as RefName);

describe('labelHead', () => {
  describe('Given every ref update is logged and a commit at HEAD', () => {
    describe('When HEAD is labelled', () => {
      it('Then the label ref records the rebase (label) reflog message', async () => {
        // Arrange
        const ctx = await newRepo('[core]\n\tlogAllRefUpdates = always\n');
        await commitFile(ctx, 'base');
        const sut = labelHead;

        // Act
        await sut(ctx, 'foo');

        // Assert
        const entries = await readReflog(ctx, 'refs/rewritten/foo' as RefName);
        expect(entries.map((entry) => entry.message)).toEqual(["rebase (label) 'foo'"]);
      });
    });
  });
});

describe('recreateMerge', () => {
  describe('Given an original commit with a single parent equal to HEAD', () => {
    describe('When its merge is recreated over a label', () => {
      it('Then it merges rather than fast-forwarding to the original', async () => {
        // Arrange
        const ctx = await newRepo();
        const base = await commitFile(ctx, 'base');
        await branchCreate(ctx, { name: 'single' });
        await branchCreate(ctx, { name: 'side' });
        await checkout(ctx, { rev: 'single' });
        const source = await commitFile(ctx, 'x');
        await checkout(ctx, { rev: 'side' });
        const merged = await commitFile(ctx, 'y');
        await checkout(ctx, { rev: base });
        const step = {
          source,
          original: await readCommit(ctx, source),
          labels: ['side'],
          head: base,
          reflogAction: REFLOG_ACTION,
        };
        const sut = recreateMerge;

        // Act
        const result = await sut(ctx, step);

        // Assert
        if (result.kind !== 'committed') throw new Error(`expected committed, got ${result.kind}`);
        expect(result.id).not.toBe(source);
        const recreated = await readCommit(ctx, result.id);
        expect(recreated.parents).toEqual([base, merged]);
        expect(recreated.message).toBe('x\n');
      });
    });
  });

  describe('Given an original merge whose first parent is HEAD but whose second is not the label', () => {
    describe('When its merge is recreated over that label', () => {
      it('Then it merges HEAD with the label rather than fast-forwarding to the original', async () => {
        // Arrange
        const ctx = await newRepo();
        await commitFile(ctx, 'base');
        await branchCreate(ctx, { name: 'head-line' });
        await branchCreate(ctx, { name: 'side' });
        await branchCreate(ctx, { name: 'other' });
        await checkout(ctx, { rev: 'side' });
        await commitFile(ctx, 'y');
        await checkout(ctx, { rev: 'other' });
        const other = await commitFile(ctx, 'z');
        await checkout(ctx, { rev: 'head-line' });
        const head = await commitFile(ctx, 'h');
        await branchCreate(ctx, { name: 'original' });
        await checkout(ctx, { rev: 'original' });
        await mergeRun(ctx, { rev: 'side', fastForward: 'never', author: AUTHOR });
        const source = await tip(ctx, 'original');
        await checkout(ctx, { rev: head });
        const step = {
          source,
          original: await readCommit(ctx, source),
          labels: ['other'],
          head,
          reflogAction: REFLOG_ACTION,
        };
        const sut = recreateMerge;

        // Act
        const result = await sut(ctx, step);

        // Assert
        if (result.kind !== 'committed') throw new Error(`expected committed, got ${result.kind}`);
        expect(result.id).not.toBe(source);
        expect((await readCommit(ctx, result.id)).parents).toEqual([head, other]);
      });
    });
  });
});
