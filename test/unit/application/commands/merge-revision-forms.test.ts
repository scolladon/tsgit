import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const commitFile = async (ctx: Context, path: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, `${path}\n`);
  await add(ctx, [path]);
  await commit(ctx, { message: path, author });
};

/** base; side: g, h + annotated tag v1 at its tip; main: m. HEAD on main. */
const seed = async (): Promise<{ ctx: Context; tagOid: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Ada\n\temail = a@x\n');
  await commitFile(ctx, 'f');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  await commitFile(ctx, 'g');
  await commitFile(ctx, 'h');
  await tagCreate(ctx, { name: 'v1', message: 'v1' });
  await checkout(ctx, { rev: 'main' });
  await commitFile(ctx, 'm');
  return { ctx, tagOid: await resolveRef(ctx, 'refs/tags/v1' as RefName) };
};

const subjectOf = async (ctx: Context, id: ObjectId): Promise<string> => {
  const object = await readObject(ctx, id);
  if (object.type !== 'commit') throw new Error(`not a commit: ${id}`);
  return object.data.message.split('\n')[0] ?? '';
};

describe('merge names each revision form as git does', () => {
  describe.each([
    [
      'the full oid of an annotated tag',
      (tag: ObjectId) => tag,
      (tag: ObjectId) => `Merge tag '${tag}'`,
    ],
    [
      'an abbreviated annotated-tag oid',
      (tag: ObjectId) => tag.slice(0, 7),
      (tag: ObjectId) => `Merge tag '${tag.slice(0, 7)}'`,
    ],
    ['<branch>~1', () => 'side~1', () => "Merge branch 'side' (early part)"],
    ['<branch>^', () => 'side^', () => "Merge branch 'side' (early part)"],
    ['<branch>~0', () => 'side~0', () => "Merge branch 'side'"],
    [
      'the tag oid stepped back as <oid>~1',
      (tag: ObjectId) => `${tag}~1`,
      (tag: ObjectId) => `Merge commit '${tag}~1'`,
    ],
  ])('Given %s', (_label, argOf, subject) => {
    describe('When merge', () => {
      it("Then it merges with git's title", async () => {
        // Arrange
        const { ctx, tagOid } = await seed();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: argOf(tagOid), author });

        // Assert
        expect(result.kind).toBe('merge');
        if (result.kind !== 'merge') return;
        expect(await subjectOf(ctx, result.id)).toBe(subject(tagOid));
      });
    });
  });

  describe.each(['@{-1}', '-'])('Given the previous branch named as %s', (arg) => {
    describe('When merge', () => {
      it('Then it merges that branch under its name', async () => {
        // Arrange
        const { ctx } = await seed();
        await checkout(ctx, { rev: 'side' });
        await checkout(ctx, { rev: 'main' });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: arg, author });

        // Assert
        expect(result.kind).toBe('merge');
        if (result.kind !== 'merge') return;
        expect(await subjectOf(ctx, result.id)).toBe("Merge branch 'side'");
      });
    });
  });

  describe('Given a lone dash among several revisions', () => {
    describe('When merge', () => {
      it('Then the dash is no shorthand and names nothing to merge', async () => {
        // Arrange
        const { ctx } = await seed();
        await checkout(ctx, { rev: 'side' });
        await checkout(ctx, { rev: 'main' });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: ['-', 'side'], author }).then(
          () => undefined,
          (e: unknown) => (e as TsgitError).data,
        );

        // Assert
        expect(result).toEqual({ code: 'REF_NOT_FOUND', name: '-' });
      });
    });
  });

  describe('Given the id of a tree', () => {
    describe('When merge', () => {
      it('Then it is not something we can merge', async () => {
        // Arrange
        const { ctx } = await seed();
        const side = await resolveRef(ctx, 'refs/heads/side' as RefName);
        const tree = (await readObject(ctx, side)) as { data: { tree: ObjectId } };
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: tree.data.tree, author }).then(
          () => undefined,
          (e: unknown) => (e as TsgitError).data,
        );

        // Assert
        expect(result).toEqual({ code: 'REF_NOT_FOUND', name: tree.data.tree });
      });
    });
  });
});
