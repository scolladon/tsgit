import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { branchCreate, branchDelete } from '../../../../../src/application/commands/branch.js';
import { checkout } from '../../../../../src/application/commands/checkout.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import { resolveCommitIsh } from '../../../../../src/application/commands/internal/commit-ish.js';
import { resolveSequencerRevisions } from '../../../../../src/application/commands/internal/sequencer-revisions.js';
import { rebaseRun } from '../../../../../src/application/commands/rebase.js';
import { errorDataCode } from '../../../../../src/domain/error-data-code.js';
import type { AuthorIdentity, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const commitFile = async (ctx: Context, name: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, `${name}\n`);
  await add(ctx, [name]);
  return (await commit(ctx, { message: name, author })).id;
};

/** feature one commit past main's base; HEAD went main → feature → main. */
const switchedRepo = async (): Promise<{ ctx: Context; feature: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname = Ada\n\temail = a@x\n');
  await commitFile(ctx, 'base.txt');
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  const feature = await commitFile(ctx, 'feature.txt');
  await checkout(ctx, { rev: 'main' });
  return { ctx, feature };
};

describe('Given HEAD switched main → feature → main', () => {
  describe.each(['-', '@{-1}'])('When cherry-pick / revert read %s', (arg) => {
    it('Then the prior checkout tip is the one commit listed', async () => {
      // Arrange
      const { ctx, feature } = await switchedRepo();
      const sut = resolveSequencerRevisions;

      // Act
      const result = await sut(ctx, [arg]);

      // Assert
      expect(result).toEqual({ kind: 'listed', commits: [feature] });
    });
  });

  describe('When a commit-ish @{-1} is resolved', () => {
    it('Then it is the prior checkout tip', async () => {
      // Arrange
      const { ctx, feature } = await switchedRepo();
      const sut = resolveCommitIsh;

      // Act
      const result = await sut(ctx, '@{-1}');

      // Assert
      expect(result).toBe(feature);
    });
  });

  describe('When a commit-ish @{-1} is resolved after feature was deleted', () => {
    it('Then it refuses with REF_NOT_FOUND under @{-1}', async () => {
      // Arrange
      const { ctx } = await switchedRepo();
      await branchDelete(ctx, { name: 'feature', force: true });
      const sut = resolveCommitIsh;

      // Act
      let result: unknown;
      try {
        await sut(ctx, '@{-1}');
      } catch (error) {
        result = error;
      }

      // Assert
      expect(errorDataCode(result)).toBe('REF_NOT_FOUND');
      expect((result as { data: { name: string } }).data.name).toBe('@{-1}');
    });
  });

  describe('When a commit-ish @{-1} is resolved after a detached hop', () => {
    it('Then it is the commit HEAD was detached at', async () => {
      // Arrange
      const { ctx, feature } = await switchedRepo();
      await checkout(ctx, { rev: feature, detach: true });
      await checkout(ctx, { rev: 'main' });
      const sut = resolveCommitIsh;

      // Act
      const result = await sut(ctx, '@{-1}');

      // Assert
      expect(result).toBe(feature);
    });
  });

  describe('When cherry-pick / revert read - after the first revision', () => {
    it('Then that - is not the previous checkout', async () => {
      // Arrange
      const { ctx } = await switchedRepo();
      const sut = resolveSequencerRevisions;

      // Act
      let result: unknown;
      try {
        await sut(ctx, ['main', '-']);
      } catch (error) {
        result = error;
      }

      // Assert
      expect(errorDataCode(result)).toBe('REF_NOT_FOUND');
    });
  });

  describe('When rebase onto -', () => {
    it('Then main is replayed onto the prior checkout', async () => {
      // Arrange
      const { ctx, feature } = await switchedRepo();
      await commitFile(ctx, 'main.txt');
      const sut = rebaseRun;

      // Act
      const result = await sut(ctx, { upstream: '-' });

      // Assert
      expect(result.kind).toBe('rebased');
      const tip = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)).trim();
      expect(tip).not.toBe(feature);
    });
  });
});
