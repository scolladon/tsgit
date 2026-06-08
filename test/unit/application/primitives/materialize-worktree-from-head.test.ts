import { describe, expect, it } from 'vitest';

import { materializeWorktreeFromHead } from '../../../../src/application/primitives/materialize-worktree-from-head.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const IDENTITY = {
  name: 'Test',
  email: 'test@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const ENCODER = new TextEncoder();

/** Seed a context with HEAD → refs/heads/main → commit → tree({file.txt, dir/nested}). */
const seedHeadCommit = async (): Promise<{ ctx: Context; head: ObjectId }> => {
  const ctx = await buildSeededContext();
  const blob = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: ENCODER.encode('hello\n'),
  });
  const nested = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: ENCODER.encode('deep\n'),
  });
  const subtree = await writeTree(ctx, [
    { name: 'nested' as FilePath, id: nested, mode: FILE_MODE.REGULAR },
  ]);
  const tree = await writeTree(ctx, [
    { name: 'dir' as FilePath, id: subtree, mode: FILE_MODE.DIRECTORY },
    { name: 'file.txt' as FilePath, id: blob, mode: FILE_MODE.REGULAR },
  ]);
  const head = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree,
      parents: [],
      author: IDENTITY,
      committer: IDENTITY,
      message: 'seed',
      extraHeaders: [],
    },
  });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${head}\n`);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return { ctx, head };
};

describe('Given a freshly-cloned gitdir whose HEAD points at a commit', () => {
  describe('When materializeWorktreeFromHead runs', () => {
    it('Then it writes the HEAD tree into the working tree (nested paths included)', async () => {
      // Arrange
      const { ctx } = await seedHeadCommit();
      // Act
      const sut = await materializeWorktreeFromHead(ctx);
      // Assert
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/file.txt`)).toBe('hello\n');
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/dir/nested`)).toBe('deep\n');
      expect(sut.written).toBe(2);
      expect(sut.deleted).toBe(0);
    });

    it('Then it writes the module index recording both tree paths', async () => {
      // Arrange
      const { ctx } = await seedHeadCommit();
      // Act
      await materializeWorktreeFromHead(ctx);
      // Assert
      const index = await readIndex(ctx);
      const paths = index.entries.map((e) => e.path).sort();
      expect(paths).toEqual(['dir/nested', 'file.txt']);
    });

    it('Then it leaves HEAD untouched and writes no reflog entry', async () => {
      // Arrange
      const { ctx } = await seedHeadCommit();
      // Act
      await materializeWorktreeFromHead(ctx);
      // Assert
      expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/main\n');
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/HEAD`)).toBe(false);
    });
  });

  describe('When the working tree already matches HEAD (re-run)', () => {
    it('Then it is idempotent — no paths re-written the second time', async () => {
      // Arrange
      const { ctx } = await seedHeadCommit();
      await materializeWorktreeFromHead(ctx);
      // Act
      const sut = await materializeWorktreeFromHead(ctx);
      // Assert
      expect(sut.written).toBe(0);
      expect(sut.deleted).toBe(0);
    });
  });
});
