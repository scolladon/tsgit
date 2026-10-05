import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import { octopusMerge } from '../../../../../src/application/commands/internal/octopus-merge.js';
import { flattenTree } from '../../../../../src/application/primitives/flatten-tree.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import {
  type AuthorIdentity,
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../src/ports/context.js';

const t: AuthorIdentity = { name: 't', email: 't@t', timestamp: 1, timezoneOffset: '+0000' };

const blob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode(content),
  });

type Files = Readonly<Record<string, readonly [content: string, mode?: FileMode]>>;

const commitOf = async (ctx: Context, files: Files, parents: ObjectId[]): Promise<ObjectId> => {
  const entries = await Promise.all(
    Object.entries(files).map(async ([name, [content, mode]]) =>
      treeEntry(mode ?? FILE_MODE.REGULAR, name, await blob(ctx, content)),
    ),
  );
  const tree = await writeTree(ctx, entries);
  return writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents, author: t, committer: t, message: 'c\n', extraHeaders: [] },
  });
};

const setup = async (
  ours: Files,
  theirs: Files,
  base: Files = { a: ['a\n'] },
): Promise<{ ctx: Context; head: ObjectId; remotes: { id: ObjectId; name: string }[] }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const root = await commitOf(ctx, base, []);
  const head = await commitOf(ctx, { ...base, ...ours }, [root]);
  const r1 = await commitOf(ctx, { ...base, r1: ['r1\n'] }, [root]);
  const r2 = await commitOf(ctx, { ...base, ...theirs }, [root]);
  return {
    ctx,
    head,
    remotes: [
      { id: r1, name: 'r1' },
      { id: r2, name: 'r2' },
    ],
  };
};

describe('octopusMerge', () => {
  describe('Given the last head adds a file the head added differently', () => {
    describe('When merged', () => {
      it('Then the path conflicts as add-add with both additions marked', async () => {
        // Arrange
        const { ctx, head, remotes } = await setup({ x: ['ours\n'] }, { x: ['theirs\n'] });
        const sut = octopusMerge;

        // Act
        const result = await sut(ctx, head, remotes);

        // Assert
        const conflict = result.kind === 'conflict' ? result.conflicts[0] : undefined;
        expect(conflict?.type).toBe('add-add');
        expect(conflict?.baseId).toBeUndefined();
        expect(new TextDecoder().decode(conflict?.conflictContent)).toBe(
          '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> r2\n',
        );
      });
    });
  });

  describe('Given the head edits a file whose mode the last head changed', () => {
    describe('When merged', () => {
      it("Then git-merge-one-file's permissions conflict leaves it conflicted with the merged bytes", async () => {
        // Arrange
        const { ctx, head, remotes } = await setup(
          { a: ['a2\n'] },
          { a: ['a\n', FILE_MODE.EXECUTABLE] },
        );
        const sut = octopusMerge;

        // Act
        const result = await sut(ctx, head, remotes);

        // Assert
        const conflict = result.kind === 'conflict' ? result.conflicts[0] : undefined;
        expect(conflict?.type).toBe('content');
        expect(conflict?.mergedMode).toBe(FILE_MODE.REGULAR);
        expect(new TextDecoder().decode(conflict?.conflictContent)).toBe('a2\n');
      });
    });
  });

  describe('Given both heads edit distinct lines of one file', () => {
    describe('When merged', () => {
      it('Then the merged blob is written and staged', async () => {
        // Arrange
        const base: Files = { f: ['1\n2\n3\n4\n5\n'] };
        const { ctx, head, remotes } = await setup(
          { f: ['1x\n2\n3\n4\n5\n'] },
          { f: ['1\n2\n3\n4\n5x\n'] },
          base,
        );
        const sut = octopusMerge;

        // Act
        const result = await sut(ctx, head, remotes);

        // Assert
        const merged = await blob(ctx, '1x\n2\n3\n4\n5x\n');
        const tree = result.kind === 'clean' ? result.tree : undefined;
        expect((await flattenTree(ctx, tree!)).entries.get('f' as FilePath)?.id).toBe(merged);
      });
    });
  });

  describe('Given a head id naming a blob', () => {
    describe('When merged', () => {
      it('Then it refuses the non-commit', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const notCommit = await blob(ctx, 'x');
        const sut = octopusMerge;

        // Act
        const caught = await sut(ctx, notCommit, []).catch((error: unknown) => error);

        // Assert
        expect((caught as TsgitError).data).toMatchObject({
          code: 'UNEXPECTED_OBJECT_TYPE',
          expected: 'commit',
          actual: 'blob',
        });
      });
    });
  });
});
