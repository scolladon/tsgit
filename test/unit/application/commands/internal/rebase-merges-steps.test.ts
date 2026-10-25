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
  resetToLabel,
} from '../../../../../src/application/commands/internal/rebase-merges-steps.js';
import { mergeRun } from '../../../../../src/application/commands/merge.js';
import { readIndex } from '../../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../../src/application/primitives/resolve-ref.js';
import {
  type CommitData,
  type ObjectId,
  type RefName,
  zeroOid,
} from '../../../../../src/domain/objects/index.js';
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
  describe('Given every ref update is logged and a label created then re-pointed', () => {
    describe('When HEAD is labelled twice', () => {
      it('Then the reflog opens from the zero oid and the re-point starts from the previous value', async () => {
        // Arrange
        const ctx = await newRepo('[core]\n\tlogAllRefUpdates = always\n');
        const first = await commitFile(ctx, 'base');
        const sut = labelHead;
        await sut(ctx, 'foo');
        const second = await commitFile(ctx, 'next');

        // Act
        await sut(ctx, 'foo');

        // Assert
        const entries = await readReflog(ctx, 'refs/rewritten/foo' as RefName);
        expect(entries.map(({ oldId, newId, message }) => ({ oldId, newId, message }))).toEqual([
          { oldId: zeroOid(ctx.hashConfig), newId: first, message: "rebase (label) 'foo'" },
          { oldId: first, newId: second, message: "rebase (label) 'foo'" },
        ]);
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

describe('recreateMerge fast-forward over an occupant', () => {
  describe('Given an untracked file where the original merge adds a path', () => {
    describe('When its merge is kept by fast-forward', () => {
      it('Then it is refused naming the path, with the file and HEAD untouched', async () => {
        // Arrange
        const ctx = await newRepo();
        const base = await commitFile(ctx, 'base');
        await branchCreate(ctx, { name: 'side' });
        await branchCreate(ctx, { name: 'head-line' });
        await checkout(ctx, { rev: 'side' });
        await commitFile(ctx, 's');
        await checkout(ctx, { rev: 'head-line' });
        const head = await commitFile(ctx, 'h');
        await branchCreate(ctx, { name: 'original' });
        await checkout(ctx, { rev: 'original' });
        await mergeRun(ctx, { rev: 'side', fastForward: 'never', author: AUTHOR });
        const source = await tip(ctx, 'original');
        await checkout(ctx, { rev: head });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/s`, 'occupant\n');
        const step = {
          source,
          original: await readCommit(ctx, source),
          labels: ['side'],
          head,
          reflogAction: REFLOG_ACTION,
        };
        const sut = recreateMerge;

        // Act
        const data = await sut(ctx, step).then(
          () => undefined,
          (err: unknown) => (err as { data: unknown }).data,
        );

        // Assert
        expect(data).toEqual({ code: 'WORKING_TREE_DIRTY', localChanges: [], untracked: ['s'] });
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/s`)).toBe('occupant\n');
        expect(await resolveRef(ctx, 'HEAD' as RefName)).toBe(head);
        expect(base).not.toBe(head);
      });
    });
  });
});

describe('resetToLabel', () => {
  describe('Given an untracked file where the label tree adds a path', () => {
    describe('When the reset step runs', () => {
      it('Then it is refused naming the path, with the file, HEAD and index untouched', async () => {
        // Arrange
        const ctx = await newRepo();
        const base = await commitFile(ctx, 'base');
        const labelled = await commitFile(ctx, 'a');
        await labelHead(ctx, 'x');
        await checkout(ctx, { rev: base });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a`, 'occupant\n');
        const sut = resetToLabel;

        // Act
        const result = await sut(ctx, 'x', REFLOG_ACTION);

        // Assert
        expect(result).toEqual({ kind: 'refused', localChanges: [], untracked: ['a'] });
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a`)).toBe('occupant\n');
        expect(await resolveRef(ctx, 'HEAD' as RefName)).toBe(base);
        expect((await readIndex(ctx)).entries.map((e) => e.path)).toEqual(['base']);
        expect(labelled).not.toBe(base);
      });
    });
  });

  describe('Given a label whose tree can be materialised', () => {
    describe('When the reset step runs', () => {
      it('Then HEAD moves to the label and the outcome carries it', async () => {
        // Arrange
        const ctx = await newRepo();
        const base = await commitFile(ctx, 'base');
        const labelled = await commitFile(ctx, 'a');
        await labelHead(ctx, 'x');
        await checkout(ctx, { rev: base });
        const sut = resetToLabel;

        // Act
        const result = await sut(ctx, 'x', REFLOG_ACTION);

        // Assert
        expect(result).toEqual({ kind: 'moved', head: labelled });
        expect(await resolveRef(ctx, 'HEAD' as RefName)).toBe(labelled);
      });
    });
  });
});
