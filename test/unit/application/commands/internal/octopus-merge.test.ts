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

  describe('Given the head added an empty file the last head added with content', () => {
    describe('When merged', () => {
      it('Then the path conflicts although the empty side merges cleanly, as git-merge-one-file does', async () => {
        // Arrange
        const { ctx, head, remotes } = await setup({ x: [''] }, { x: ['theirs\n'] });
        const sut = octopusMerge;

        // Act
        const result = await sut(ctx, head, remotes);

        // Assert
        const conflict = result.kind === 'conflict' ? result.conflicts[0] : undefined;
        expect(conflict?.type).toBe('add-add');
        expect(new TextDecoder().decode(conflict?.conflictContent)).toBe('theirs\n');
      });
    });
  });

  describe('Given conflicts on a path the base held and on a path both heads added', () => {
    describe('When merged', () => {
      it('Then the conflicts come in path order', async () => {
        // Arrange
        const { ctx, head, remotes } = await setup(
          { z: ['ours-z\n'], a: ['ours-a\n'] },
          { z: ['theirs-z\n'], a: ['theirs-a\n'] },
          { z: ['1\n'] },
        );
        const sut = octopusMerge;

        // Act
        const result = await sut(ctx, head, remotes);

        // Assert
        const paths = result.kind === 'conflict' ? result.conflicts.map((c) => c.path) : [];
        expect(paths).toEqual(['a', 'z']);
      });
    });
  });

  describe('Given a last head built on the head after another head was merged', () => {
    describe('When merged', () => {
      it('Then it is merged in rather than fast-forwarded to, keeping the earlier head', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const root = await commitOf(ctx, { a: ['a\n'] }, []);
        const head = await commitOf(ctx, { a: ['a\n'], h: ['h\n'] }, [root]);
        const first = await commitOf(ctx, { a: ['a\n'], r1f: ['r1\n'] }, [root]);
        const last = await commitOf(ctx, { a: ['a\n'], h: ['h\n'], r2f: ['r2\n'] }, [head]);
        const sut = octopusMerge;

        // Act
        const result = await sut(ctx, head, [
          { id: first, name: 'r1' },
          { id: last, name: 'r2' },
        ]);

        // Assert
        const tree = result.kind === 'clean' ? result.tree : undefined;
        const paths = tree === undefined ? [] : [...(await flattenTree(ctx, tree)).entries.keys()];
        expect(paths).toEqual(['a', 'h', 'r1f', 'r2f']);
      });
    });
  });

  describe('Given a last head whose history crosses the running result with two merge bases', () => {
    describe('When merged', () => {
      it('Then both bases take part, leaving the path they disagree on conflicted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const root = await commitOf(ctx, { f: ['0\n'] }, []);
        const left = await commitOf(ctx, { f: ['1\n'] }, [root]);
        const right = await commitOf(ctx, { f: ['2\n'] }, [root]);
        const head = await commitOf(ctx, { f: ['1\n'] }, [left, right]);
        const crossed = await commitOf(ctx, { f: ['2\n'] }, [right, left]);
        const first = await commitOf(ctx, { f: ['0\n'], z: ['z\n'] }, [root]);
        const sut = octopusMerge;

        // Act
        const result = await sut(ctx, head, [
          { id: first, name: 'r1' },
          { id: crossed, name: 'crossed' },
        ]);

        // Assert
        const conflict = result.kind === 'conflict' ? result.conflicts[0] : undefined;
        expect(conflict).toMatchObject({ type: 'add-add', path: 'f' });
        expect(conflict?.baseId).toBeUndefined();
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
