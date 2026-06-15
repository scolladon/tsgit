import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  stashApply,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
} from '../../../../src/application/commands/stash.js';
import { flattenTree } from '../../../../src/application/primitives/flatten-tree.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { pushStashRef, readStashStack } from '../../../../src/application/primitives/stash-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
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

const headId = async (ctx: Context): Promise<ObjectId> =>
  (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)).trim() as ObjectId;

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

  describe('Given a tracked file deleted from the working tree', () => {
    describe('When push runs', () => {
      it('Then the deletion is stashed (absent from the W tree) and the file is restored', async () => {
        // Arrange
        const ctx = await setupRepo();
        await ctx.fs.rm(`${ctx.layout.workDir}/a.txt`);

        // Act
        const sut = await stashPush(ctx, {});

        // Assert
        if (sut.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, sut.stash);
        // The W tree drops the deleted path; the reset restores it from HEAD.
        expect(await treeContent(ctx, w.tree, 'a.txt')).toBe('<absent>');
        expect(await read(ctx, 'a.txt')).toBe('committed\n');
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

        // Assert — full message pins the 7-char abbrev exactly.
        const head = await headId(ctx);
        const stack = await readStashStack(ctx);
        expect(stack[0]?.message).toBe(`WIP on main: ${head.slice(0, 7)} initial commit`);
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
        // The index commit's parent is the base (HEAD) commit.
        expect(w.parents[0]).toBe(await headId(ctx));
        const indexCommit = await commitOf(ctx, w.parents[1] as ObjectId);
        expect(indexCommit.parents).toEqual([await headId(ctx)]);
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
        const uTree = (await commitOf(ctx, w.parents[2] as ObjectId)).tree;
        expect(await treeContent(ctx, uTree, 'new.txt')).toBe('untracked\n');
        // The untracked commit holds ONLY untracked files — the tracked `a.txt` is excluded.
        expect(await treeContent(ctx, uTree, 'a.txt')).toBe('<absent>');
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

const commit2 = async (ctx: Context, content: string, message: string): Promise<void> => {
  await write(ctx, 'a.txt', content);
  await add(ctx, ['a.txt']);
  await commit(ctx, { message, author });
};

describe('stash apply', () => {
  describe('Given a stash of an unstaged change applied onto a clean tree', () => {
    describe('When apply runs', () => {
      it('Then the change returns to the working tree and stays unstaged', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'modified\n');
        const saved = await stashPush(ctx, {});
        if (saved.kind !== 'saved') throw new Error('expected saved');

        // Act
        const sut = await stashApply(ctx, {});

        // Assert
        expect(sut).toEqual({ kind: 'applied', stash: saved.stash });
        expect(await read(ctx, 'a.txt')).toBe('modified\n');
        // Index still at HEAD → the change is unstaged.
        const idx = await readIndex(ctx);
        const entry = idx.entries.find((e) => e.path === 'a.txt');
        const blob = await readObject(ctx, entry?.id as ObjectId);
        expect(blob.type === 'blob' && new TextDecoder().decode(blob.content)).toBe('committed\n');
        // Stash retained after apply.
        expect((await stashList(ctx)).entries).toHaveLength(1);
      });
    });
  });

  describe('Given a stash of a staged change applied with restoreIndex', () => {
    describe('When apply runs', () => {
      it('Then the staged content is reinstated in the index', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'staged\n');
        await add(ctx, ['a.txt']);
        await stashPush(ctx, {});

        // Act
        await stashApply(ctx, { restoreIndex: true });

        // Assert
        const idx = await readIndex(ctx);
        const entry = idx.entries.find((e) => e.path === 'a.txt');
        const blob = await readObject(ctx, entry?.id as ObjectId);
        expect(blob.type === 'blob' && new TextDecoder().decode(blob.content)).toBe('staged\n');
      });
    });
  });

  describe('Given an empty stack', () => {
    describe('When apply runs', () => {
      it('Then it throws STASH_NOT_FOUND', async () => {
        // Arrange
        const ctx = await setupRepo();

        // Act
        const act = stashApply(ctx, {});

        // Assert
        await act.catch((err: TsgitError) => {
          expect(err.data).toEqual({ code: 'STASH_NOT_FOUND', index: 0, stackSize: 0 });
        });
        await expect(act).rejects.toBeInstanceOf(TsgitError);
      });
    });
  });

  describe('Given refs/stash points at a non-stash commit (single parent)', () => {
    describe('When apply runs', () => {
      it('Then it refuses with INVALID_COMMIT', async () => {
        // Arrange — push a malformed W with only a [base] parent.
        const ctx = await setupRepo();
        const baseCommit = await commitFile(ctx, 'b.txt', 'x\n', 'second');
        const malformed = await writeObject(ctx, {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: (await commitOf(ctx, baseCommit.id)).tree,
            parents: [baseCommit.id],
            author,
            committer: author,
            message: 'not a stash',
            extraHeaders: [],
          },
        });
        await pushStashRef(ctx, malformed, 'bogus');

        // Act
        const act = stashApply(ctx, {});

        // Assert
        await act.catch((err: TsgitError) => {
          expect(err.data.code).toBe('INVALID_COMMIT');
        });
        await expect(act).rejects.toBeInstanceOf(TsgitError);
      });
    });
  });

  describe('Given the working tree diverged on the stashed path', () => {
    describe('When apply runs and the merge conflicts', () => {
      it('Then markers are written, the index is unmerged, and the stash is retained', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'stashed\n');
        await stashPush(ctx, {});
        await commit2(ctx, 'current\n', 'diverge');

        // Act
        const sut = await stashApply(ctx, {});

        // Assert
        expect(sut.kind).toBe('conflict');
        if (sut.kind !== 'conflict') return;
        expect(sut.conflicts.map((c) => c.path)).toEqual(['a.txt']);
        expect(await read(ctx, 'a.txt')).toContain('<<<<<<<');
        const idx = await readIndex(ctx);
        expect(idx.entries.filter((e) => e.path === 'a.txt').map((e) => e.flags.stage)).toEqual([
          1, 2, 3,
        ]);
        expect((await stashList(ctx)).entries).toHaveLength(1);
      });

      it('Then the markers are labelled Updated upstream / Stashed changes', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'stashed\n');
        await stashPush(ctx, {});
        await commit2(ctx, 'current\n', 'diverge');

        // Act
        await stashApply(ctx, {});

        // Assert
        const file = await read(ctx, 'a.txt');
        expect(file).toContain('<<<<<<< Updated upstream\n');
        expect(file).toContain('>>>>>>> Stashed changes\n');
      });
    });
  });

  describe('Given a dirty working file on the stashed path', () => {
    describe('When apply runs', () => {
      it('Then it refuses with STASH_APPLY_WOULD_OVERWRITE and writes nothing', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'stashed\n');
        await stashPush(ctx, {});
        await write(ctx, 'a.txt', 'local edit\n');

        // Act
        const act = stashApply(ctx, {});

        // Assert
        await act.catch((err: TsgitError) => {
          expect(err.data).toEqual({ code: 'STASH_APPLY_WOULD_OVERWRITE', paths: ['a.txt'] });
        });
        await expect(act).rejects.toBeInstanceOf(TsgitError);
        expect(await read(ctx, 'a.txt')).toBe('local edit\n');
      });
    });
  });

  describe('Given a dangling symlink squatting a stashed untracked path', () => {
    describe('When apply runs', () => {
      it('Then it refuses with STASH_APPLY_WOULD_OVERWRITE naming the dangling path', async () => {
        // Arrange — stash an untracked file, then squat its path with a dangling
        // symlink (its target does not exist). The lstat-based presence probe sees
        // the link where a target-following probe would not.
        const ctx = await setupRepo();
        await write(ctx, 'new.txt', 'untracked\n');
        await stashPush(ctx, { includeUntracked: true });
        await ctx.fs.symlink('/nonexistent/target', `${ctx.layout.workDir}/new.txt`);

        // Act
        const act = stashApply(ctx, {});

        // Assert
        await act.catch((err: TsgitError) => {
          expect(err.data).toEqual({ code: 'STASH_APPLY_WOULD_OVERWRITE', paths: ['new.txt'] });
        });
        await expect(act).rejects.toBeInstanceOf(TsgitError);
      });
    });
  });

  describe('Given an include-untracked stash applied onto a clean tree', () => {
    describe('When apply runs', () => {
      it('Then the untracked file is restored', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'new.txt', 'untracked\n');
        await stashPush(ctx, { includeUntracked: true });

        // Act
        await stashApply(ctx, {});

        // Assert
        expect(await read(ctx, 'new.txt')).toBe('untracked\n');
      });
    });
  });

  describe('Given an untracked file already present at a stashed untracked path', () => {
    describe('When apply runs', () => {
      it('Then it refuses with STASH_APPLY_WOULD_OVERWRITE', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'new.txt', 'untracked\n');
        await stashPush(ctx, { includeUntracked: true });
        await write(ctx, 'new.txt', 'in the way\n');

        // Act
        const act = stashApply(ctx, {});

        // Assert
        await act.catch((err: TsgitError) => {
          expect(err.data).toEqual({ code: 'STASH_APPLY_WOULD_OVERWRITE', paths: ['new.txt'] });
        });
        await expect(act).rejects.toBeInstanceOf(TsgitError);
      });
    });
  });
});

describe('stash pop', () => {
  describe('Given a clean apply', () => {
    describe('When pop runs', () => {
      it('Then the change is applied and the stash is dropped', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'modified\n');
        await stashPush(ctx, {});

        // Act
        const sut = await stashPop(ctx, {});

        // Assert
        expect(sut.kind).toBe('applied');
        expect(await read(ctx, 'a.txt')).toBe('modified\n');
        expect((await stashList(ctx)).entries).toEqual([]);
      });
    });
  });

  describe('Given a conflicting apply', () => {
    describe('When pop runs', () => {
      it('Then the conflict is reported and the stash is retained', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'stashed\n');
        await stashPush(ctx, {});
        await commit2(ctx, 'current\n', 'diverge');

        // Act
        const sut = await stashPop(ctx, {});

        // Assert
        expect(sut.kind).toBe('conflict');
        expect((await stashList(ctx)).entries).toHaveLength(1);
      });
    });
  });
});

const makeBare = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');
  return ctx;
};

const codeAndOp = async (p: Promise<unknown>): Promise<{ code?: string; operation?: string }> => {
  try {
    await p;
    return {};
  } catch (err) {
    return (err as { data?: { code?: string; operation?: string } }).data ?? {};
  }
};

describe('stash on a bare repository', () => {
  describe('Given a bare repo', () => {
    describe('When push runs', () => {
      it('Then it throws BARE_REPOSITORY with operation=stash', async () => {
        // Arrange
        const ctx = await makeBare();

        // Act + Assert
        const data = await codeAndOp(stashPush(ctx, {}));
        expect(data.code).toBe('BARE_REPOSITORY');
        expect(data.operation).toBe('stash');
      });
    });

    describe('When apply runs', () => {
      it('Then it throws BARE_REPOSITORY with operation=stash apply', async () => {
        // Arrange
        const ctx = await makeBare();

        // Act + Assert
        const data = await codeAndOp(stashApply(ctx, {}));
        expect(data.code).toBe('BARE_REPOSITORY');
        expect(data.operation).toBe('stash apply');
      });
    });

    describe('When drop runs', () => {
      it('Then it throws BARE_REPOSITORY with operation=stash drop', async () => {
        // Arrange
        const ctx = await makeBare();

        // Act + Assert
        const data = await codeAndOp(stashDrop(ctx, {}));
        expect(data.code).toBe('BARE_REPOSITORY');
        expect(data.operation).toBe('stash drop');
      });
    });
  });
});

describe('stash push — HEAD resolution errors', () => {
  describe('Given a cyclic HEAD ref chain', () => {
    describe('When push runs', () => {
      it('Then the underlying ref error is re-thrown, not mapped to NO_INITIAL_COMMIT', async () => {
        // Arrange — HEAD → main → main (self-cycle).
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, 'ref: refs/heads/main\n');

        // Act + Assert
        const data = await codeAndOp(stashPush(ctx, {}));
        expect(data.code).not.toBe('NO_INITIAL_COMMIT');
        expect(data.code).toBe('REF_CYCLE_DETECTED');
      });
    });
  });
});

describe('stash lock hygiene', () => {
  describe('Given a no-op push on a clean tree', () => {
    describe('When a real push follows on the same repo', () => {
      it('Then the second push succeeds (the first released the index lock)', async () => {
        // Arrange
        const ctx = await setupRepo();
        expect((await stashPush(ctx, {})).kind).toBe('no-local-changes');

        // Act
        await write(ctx, 'a.txt', 'modified\n');
        const sut = await stashPush(ctx, {});

        // Assert
        expect(sut.kind).toBe('saved');
      });
    });
  });

  describe('Given a clean apply', () => {
    describe('When a push follows on the same repo', () => {
      it('Then the push succeeds (apply released the index lock)', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'modified\n');
        await stashPush(ctx, {});
        expect((await stashApply(ctx, {})).kind).toBe('applied');

        // Act — index lock must be free for this push.
        await write(ctx, 'a.txt', 'again\n');
        const sut = await stashPush(ctx, {});

        // Assert
        expect(sut.kind).toBe('saved');
      });
    });
  });
});

describe('stash apply — index staging', () => {
  describe('Given a staged change applied without restoreIndex', () => {
    describe('When apply runs', () => {
      it('Then the change returns unstaged (the index is NOT reinstated)', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'staged\n');
        await add(ctx, ['a.txt']);
        await stashPush(ctx, {});

        // Act — no restoreIndex.
        await stashApply(ctx, {});

        // Assert — working tree carries the change, but the index stays at HEAD.
        expect(await read(ctx, 'a.txt')).toBe('staged\n');
        const idx = await readIndex(ctx);
        const entry = idx.entries.find((e) => e.path === 'a.txt');
        const blob = await readObject(ctx, entry?.id as ObjectId);
        expect(blob.type === 'blob' && new TextDecoder().decode(blob.content)).toBe('committed\n');
      });
    });
  });
});

describe('stash pop — selector', () => {
  describe('Given a two-entry stack', () => {
    describe('When pop targets index 1', () => {
      it('Then the older entry is applied and dropped, leaving the newer', async () => {
        // Arrange
        const ctx = await setupRepo();
        const older = await pushChange(ctx, 'older\n');
        const newer = await pushChange(ctx, 'newer\n');

        // Act
        const sut = await stashPop(ctx, { index: 1 });

        // Assert — older applied to the working tree + dropped; newer remains at index 0.
        expect(sut.kind).toBe('applied');
        if (sut.kind === 'applied') expect(sut.dropped).toBe(older);
        expect(await read(ctx, 'a.txt')).toBe('older\n');
        const stack = await stashList(ctx);
        expect(stack.entries.map((e) => e.stash)).toEqual([newer]);
      });
    });
  });
});

describe('stash push — ignored files', () => {
  describe('Given a gitignored file with includeUntracked', () => {
    describe('When push runs', () => {
      it('Then the ignored file is neither stashed nor removed', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, '.gitignore', 'ignored.txt\n');
        await write(ctx, 'ignored.txt', 'secret\n');
        await write(ctx, 'tracked-untracked.txt', 'keep\n');

        // Act
        const sut = await stashPush(ctx, { includeUntracked: true });

        // Assert
        if (sut.kind !== 'saved') throw new Error('expected saved');
        const u = (await commitOf(ctx, (await commitOf(ctx, sut.stash)).parents[2] as ObjectId))
          .tree;
        expect(await treeContent(ctx, u, 'tracked-untracked.txt')).toBe('keep\n');
        // The ignored file is excluded from the stash and left on disk.
        expect(await treeContent(ctx, u, 'ignored.txt')).toBe('<absent>');
        expect(await read(ctx, 'ignored.txt')).toBe('secret\n');
      });
    });
  });
});
