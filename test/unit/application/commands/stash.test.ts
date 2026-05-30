import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { stashDrop, stashList, stashPush } from '../../../../src/application/commands/stash.js';
import { flattenTree } from '../../../../src/application/primitives/flatten-tree.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readStashStack } from '../../../../src/application/primitives/stash-ref.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const write = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);

const read = (ctx: Context, path: string): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.workDir}/${path}`);

const commitFile = async (ctx: Context, path: string, content: string, message: string) => {
  await write(ctx, path, content);
  await add(ctx, [path]);
  return commit(ctx, { message, author });
};

const treeContent = async (ctx: Context, treeId: ObjectId, path: string): Promise<string> => {
  const flat = await flattenTree(ctx, treeId);
  const entry = flat.entries.get(path as FilePath);
  if (entry === undefined) return '<absent>';
  const blob = await readObject(ctx, entry.id);
  if (blob.type !== 'blob') return '<not-blob>';
  return new TextDecoder().decode(blob.content);
};

const commitOf = async (ctx: Context, id: ObjectId) => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw new Error('not a commit');
  return obj.data;
};

const setupRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await commitFile(ctx, 'a.txt', 'committed\n', 'initial commit');
  return ctx;
};

describe('stash push', () => {
  describe('Given a clean working tree', () => {
    describe('When push runs', () => {
      it('Then it reports no local changes and writes no stash ref', async () => {
        // Arrange
        const ctx = await setupRepo();

        // Act
        const sut = await stashPush(ctx, {});

        // Assert
        expect(sut).toEqual({ kind: 'no-local-changes' });
        expect(await readStashStack(ctx)).toEqual([]);
      });
    });
  });

  describe('Given an unstaged working-tree change', () => {
    describe('When push runs', () => {
      it('Then it saves a stash and resets the working tree to HEAD', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'modified\n');

        // Act
        const sut = await stashPush(ctx, {});

        // Assert
        expect(sut.kind).toBe('saved');
        expect(await read(ctx, 'a.txt')).toBe('committed\n');
        const stack = await readStashStack(ctx);
        expect(stack).toHaveLength(1);
      });
    });
  });

  describe('Given an unstaged change saved as a stash', () => {
    describe('When the W commit is inspected', () => {
      it('Then it has [base, index] parents and its tree carries the modified content', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'modified\n');

        // Act
        const sut = await stashPush(ctx, {});

        // Assert
        if (sut.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, sut.stash);
        expect(w.parents).toHaveLength(2);
        expect(await treeContent(ctx, w.tree, 'a.txt')).toBe('modified\n');
      });
    });
  });

  describe('Given the default stash message format', () => {
    describe('When push runs on branch main', () => {
      it('Then the reflog message reads "WIP on main: <abbrev> <subject>"', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'modified\n');

        // Act
        await stashPush(ctx, {});

        // Assert
        const stack = await readStashStack(ctx);
        const message = stack[0]?.message ?? '';
        expect(message.startsWith('WIP on main: ')).toBe(true);
        expect(message.endsWith(' initial commit')).toBe(true);
      });
    });
  });

  describe('Given a custom stash message', () => {
    describe('When push runs with a message', () => {
      it('Then the reflog message reads "On main: <message>"', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'modified\n');

        // Act
        await stashPush(ctx, { message: 'wip before refactor' });

        // Assert
        const stack = await readStashStack(ctx);
        expect(stack[0]?.message).toBe('On main: wip before refactor');
      });
    });
  });

  describe('Given a staged change', () => {
    describe('When push runs (default)', () => {
      it('Then the index is reset to HEAD and the index commit carries the staged content', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'staged\n');
        await add(ctx, ['a.txt']);

        // Act
        const sut = await stashPush(ctx, {});

        // Assert
        if (sut.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, sut.stash);
        const indexCommit = await commitOf(ctx, w.parents[1] as ObjectId);
        expect(await treeContent(ctx, indexCommit.tree, 'a.txt')).toBe('staged\n');
        // Index reset to HEAD: working file restored to committed content.
        expect(await read(ctx, 'a.txt')).toBe('committed\n');
      });
    });
  });

  describe('Given a staged change with keepIndex', () => {
    describe('When push runs', () => {
      it('Then the staged content survives in the index and working tree', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'staged\n');
        await add(ctx, ['a.txt']);

        // Act
        await stashPush(ctx, { keepIndex: true });

        // Assert
        expect(await read(ctx, 'a.txt')).toBe('staged\n');
        const idx = await readIndex(ctx);
        const entry = idx.entries.find((e) => e.path === 'a.txt');
        const blob = await readObject(ctx, entry?.id as ObjectId);
        expect(blob.type === 'blob' && new TextDecoder().decode(blob.content)).toBe('staged\n');
      });
    });
  });

  describe('Given untracked files with includeUntracked', () => {
    describe('When push runs', () => {
      it('Then the untracked file is captured (3-parent W) and removed from the working tree', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'modified\n');
        await write(ctx, 'new.txt', 'untracked\n');

        // Act
        const sut = await stashPush(ctx, { includeUntracked: true });

        // Assert
        if (sut.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, sut.stash);
        expect(w.parents).toHaveLength(3);
        expect(
          await treeContent(ctx, (await commitOf(ctx, w.parents[2] as ObjectId)).tree, 'new.txt'),
        ).toBe('untracked\n');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/new.txt`)).toBe(false);
      });
    });
  });

  describe('Given untracked files without includeUntracked', () => {
    describe('When push runs with only untracked files', () => {
      it('Then there is nothing to stash', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'new.txt', 'untracked\n');

        // Act
        const sut = await stashPush(ctx, {});

        // Assert
        expect(sut).toEqual({ kind: 'no-local-changes' });
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/new.txt`)).toBe(true);
      });
    });
  });

  describe('Given an unborn HEAD (no initial commit)', () => {
    describe('When push runs', () => {
      it('Then it throws NO_INITIAL_COMMIT', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await write(ctx, 'a.txt', 'x\n');
        await add(ctx, ['a.txt']);

        // Act
        const act = stashPush(ctx, {});

        // Assert
        await act.catch((err: TsgitError) => {
          expect(err.data).toEqual({ code: 'NO_INITIAL_COMMIT' });
        });
        await expect(act).rejects.toBeInstanceOf(TsgitError);
      });
    });
  });
});

const pushChange = async (ctx: Context, content: string): Promise<ObjectId> => {
  await write(ctx, 'a.txt', content);
  const result = await stashPush(ctx, {});
  if (result.kind !== 'saved') throw new Error('expected saved');
  return result.stash;
};

describe('stash list', () => {
  describe('Given an empty stack', () => {
    describe('When list runs', () => {
      it('Then it yields no entries', async () => {
        // Arrange
        const ctx = await setupRepo();

        // Act
        const sut = await stashList(ctx);

        // Assert
        expect(sut).toEqual({ entries: [] });
      });
    });
  });

  describe('Given two stashes', () => {
    describe('When list runs', () => {
      it('Then entries are newest-first with stash@{N} selectors', async () => {
        // Arrange
        const ctx = await setupRepo();
        const first = await pushChange(ctx, 'one\n');
        const second = await pushChange(ctx, 'two\n');

        // Act
        const sut = await stashList(ctx);

        // Assert
        expect(sut.entries.map((e) => e.selector)).toEqual(['stash@{0}', 'stash@{1}']);
        expect(sut.entries.map((e) => e.stash)).toEqual([second, first]);
      });
    });
  });
});

describe('stash drop', () => {
  describe('Given a three-entry stack', () => {
    describe('When the middle entry is dropped', () => {
      it('Then it is removed and the stack re-indexes', async () => {
        // Arrange — newest-first after pushes: third@0, second@1, first@2
        const ctx = await setupRepo();
        const first = await pushChange(ctx, 'one\n');
        const second = await pushChange(ctx, 'two\n');
        const third = await pushChange(ctx, 'three\n');

        // Act
        const sut = await stashDrop(ctx, { index: 1 });

        // Assert
        expect(sut).toEqual({ dropped: second, remaining: 2 });
        expect((await stashList(ctx)).entries.map((e) => e.stash)).toEqual([third, first]);
      });
    });
  });

  describe('Given a single-entry stack', () => {
    describe('When the only entry is dropped', () => {
      it('Then the stack is emptied', async () => {
        // Arrange
        const ctx = await setupRepo();
        await pushChange(ctx, 'one\n');

        // Act
        const sut = await stashDrop(ctx, {});

        // Assert
        expect(sut.remaining).toBe(0);
        expect((await stashList(ctx)).entries).toEqual([]);
      });
    });

    describe('When an out-of-range entry is dropped', () => {
      it('Then it throws STASH_NOT_FOUND', async () => {
        // Arrange
        const ctx = await setupRepo();
        await pushChange(ctx, 'one\n');

        // Act
        const act = stashDrop(ctx, { index: 9 });

        // Assert
        await act.catch((err: TsgitError) => {
          expect(err.data).toEqual({ code: 'STASH_NOT_FOUND', index: 9, stackSize: 1 });
        });
        await expect(act).rejects.toBeInstanceOf(TsgitError);
      });
    });
  });
});
