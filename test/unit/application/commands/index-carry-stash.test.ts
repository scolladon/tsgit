import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { rm } from '../../../../src/application/commands/rm.js';
import { stashApply, stashPop, stashPush } from '../../../../src/application/commands/stash.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { updateConfigEntries } from '../../../../src/application/primitives/update-config.js';
import type { CacheTreeEntry } from '../../../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../src/domain/git-index/index-parser.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import {
  cacheTreeExtension,
  indexExtensionsOf,
  resolveUndoExtension,
  UNKNOWN_EXTENSION,
  UNTR_EXTENSION,
  withIndexExtensions,
} from '../primitives/helpers/index-extensions.js';

const SHA1_DIGEST = 20;
const TREE_ID = 'c'.repeat(40) as ObjectId;
const BLOB_ID = 'b'.repeat(40);
const T0 = 1_700_000_000_000;
const SECOND = 1000;
const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const FILES: Readonly<Record<string, string>> = {
  a: 'a\n',
  b: 'b\n',
  'd/c': 'c\n',
  'd/e/f': 'f\n',
  'x/y': 'y\n',
};

const node = (
  path: string,
  entryCount: number,
  subtreeCount: number,
  children: ReadonlyArray<CacheTreeEntry> = [],
): CacheTreeEntry => ({ path, entryCount, subtreeCount, id: TREE_ID, children });

const fullTree = (): CacheTreeEntry =>
  node('', 5, 2, [node('d', 2, 1, [node('e', 1, 0)]), node('x', 1, 0)]);

const advance = (seconds: number): void => {
  vi.setSystemTime(Date.now() + seconds * SECOND);
};

const write = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);

const carryAllExtensions = async (ctx: Context): Promise<void> => {
  await withIndexExtensions(ctx, [
    cacheTreeExtension(fullTree(), SHA1_DIGEST),
    resolveUndoExtension('m', BLOB_ID, SHA1_DIGEST),
    UNTR_EXTENSION,
    UNKNOWN_EXTENSION,
  ]);
  advance(1);
};

/** One commit holding FILES, then the extensions injected; left on `main`. */
const repoWithExtensions = async (): Promise<Context> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const ctx = createMemoryContext();
  await init(ctx);
  await updateConfigEntries(ctx, [
    { section: 'user', key: 'name', value: AUTHOR.name },
    { section: 'user', key: 'email', value: AUTHOR.email },
  ]);
  for (const [path, content] of Object.entries(FILES)) await write(ctx, path, content);
  await add(ctx, Object.keys(FILES));
  advance(1);
  await commit(ctx, { message: 'c1', author: AUTHOR, committer: AUTHOR });
  advance(1);
  return ctx;
};

const SEEDED_BYTES: ReadonlyMap<string, Uint8Array> = new Map([
  ['REUC', resolveUndoExtension('m', BLOB_ID, SHA1_DIGEST).data],
  ['UNTR', UNTR_EXTENSION.data],
]);

/** The carried signatures; a kept REUC or UNTR must still hold the seeded bytes. */
const carriedSignatures = async (ctx: Context): Promise<ReadonlyArray<string>> => {
  const extensions = await indexExtensionsOf(ctx);
  for (const [signature, bytes] of SEEDED_BYTES) {
    if (extensions.has(signature)) expect(extensions.get(signature)).toEqual(bytes);
  }
  return [...extensions.keys()];
};

const chains = async (ctx: Context): Promise<ReadonlyArray<boolean | undefined>> => {
  const extensions = await indexExtensionsOf(ctx);
  const root = parseCacheTree(extensions.get('TREE') as Uint8Array, SHA1_DIGEST);
  const valid = new Map<string, boolean>();
  const visit = (entry: CacheTreeEntry, prefix: string): void => {
    valid.set(prefix, entry.entryCount >= 0);
    for (const child of entry.children)
      visit(child, prefix === '' ? child.path : `${prefix}/${child.path}`);
  };
  visit(root, '');
  return [valid.get(''), valid.get('d'), valid.get('d/e'), valid.get('x')];
};

const ALL_VALID = [true, true, true, true];

afterEach(() => {
  vi.useRealTimers();
});

describe('stash carries index extensions', () => {
  describe('Given worktree-only edits and an index carrying extensions', () => {
    describe('When stash push resets the work tree', () => {
      it('Then REUC and the unknown extension are dropped and no cache-tree chain is invalid', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'edited\n');
        await carryAllExtensions(ctx);

        // Act
        const sut = stashPush;
        await sut(ctx, {});

        // Assert
        expect(await carriedSignatures(ctx)).toEqual(['TREE', 'UNTR']);
        expect(await chains(ctx)).toEqual(ALL_VALID);
      });
    });

    describe('When stash push includes untracked files', () => {
      it('Then REUC and the unknown extension are dropped and no cache-tree chain is invalid', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'edited\n');
        await write(ctx, 'untracked', 'u\n');
        await carryAllExtensions(ctx);

        // Act
        const sut = stashPush;
        await sut(ctx, { includeUntracked: true });

        // Assert
        expect(await carriedSignatures(ctx)).toEqual(['TREE', 'UNTR']);
        expect(await chains(ctx)).toEqual(ALL_VALID);
      });
    });
  });

  describe('Given a stash conflicting with a later commit and an index carrying extensions', () => {
    describe('When stash apply stops on the conflict', () => {
      it('Then REUC and the unknown extension are dropped', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'edited\n');
        await stashPush(ctx, {});
        advance(1);
        await write(ctx, 'x/y', 'committed\n');
        await add(ctx, ['x/y']);
        advance(1);
        await commit(ctx, { message: 'c2', author: AUTHOR, committer: AUTHOR });
        advance(1);
        await carryAllExtensions(ctx);

        // Act
        const sut = stashApply;
        await sut(ctx, {});

        // Assert
        expect(await carriedSignatures(ctx)).toEqual(['TREE', 'UNTR']);
      });
    });
  });

  describe('Given a clean stash of a worktree-only edit and an index carrying extensions', () => {
    describe('When stash apply merges cleanly', () => {
      it('Then REUC and the unknown extension are dropped', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'edited\n');
        await stashPush(ctx, {});
        advance(1);
        await carryAllExtensions(ctx);

        // Act
        const sut = stashApply;
        await sut(ctx, {});

        // Assert
        expect(await carriedSignatures(ctx)).toEqual(['TREE', 'UNTR']);
      });
    });
  });

  describe('Given a stash of a staged edit and a staged new file', () => {
    describe('When stash apply merges cleanly without restoring the index', () => {
      it('Then the edited path returns to its pre-apply entry with zero stat and the new file keeps its stat', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'a', 'edited\n');
        await write(ctx, 'n', 'n\n');
        await add(ctx, ['a', 'n']);
        advance(1);
        await stashPush(ctx, {});
        advance(1);
        const before = (await readIndex(ctx)).entries.find((e) => e.path === 'a');

        // Act
        const sut = stashApply;
        await sut(ctx, {});

        // Assert
        const entries = (await readIndex(ctx)).entries;
        const edited = entries.find((e) => e.path === 'a');
        const added = entries.find((e) => e.path === 'n');
        expect(edited).toEqual({
          ...before,
          ctimeSeconds: 0,
          ctimeNanoseconds: 0,
          mtimeSeconds: 0,
          mtimeNanoseconds: 0,
          dev: 0,
          ino: 0,
          uid: 0,
          gid: 0,
          fileSize: 0,
        });
        expect(added?.fileSize).toBe(2);
      });
    });
  });

  describe('Given a stash that turns the file a into a directory holding a/x', () => {
    describe('When stash apply merges cleanly without restoring the index', () => {
      it('Then the index holds a/x and not a so write-tree stays possible', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/a`);
        await write(ctx, 'a/x', 'x\n');
        await rm(ctx, ['a'], { cached: true });
        await add(ctx, ['a/x']);
        advance(1);
        await stashPush(ctx, {});
        advance(1);

        // Act
        const sut = stashApply;
        await sut(ctx, {});

        // Assert
        const paths = (await readIndex(ctx)).entries.map((e) => e.path);
        expect(paths).toEqual(['a/x', 'b', 'd/c', 'd/e/f', 'x/y']);
      });
    });
  });

  describe('Given a stash of a worktree-only edit and an index carrying extensions', () => {
    describe('When stash apply merges cleanly', () => {
      it('Then the cache-tree is invalid along the restored path only', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'edited\n');
        await stashPush(ctx, {});
        advance(1);
        await carryAllExtensions(ctx);

        // Act
        const sut = stashApply;
        await sut(ctx, {});

        // Assert
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });

    describe('When stash pop --index finds nothing staged', () => {
      it('Then it behaves like apply and invalidates the cache-tree along the restored path', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'edited\n');
        await stashPush(ctx, {});
        advance(1);
        await carryAllExtensions(ctx);

        // Act
        const sut = stashPop;
        await sut(ctx, { restoreIndex: true });

        // Assert
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });

  describe('Given a stash of a worktree-only edit and a later staged change', () => {
    describe('When stash pop --index finds nothing staged by the stash', () => {
      it('Then the index is not rebuilt and the cache-tree is invalid along the restored path only', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'edited\n');
        await stashPush(ctx, {});
        advance(1);
        await write(ctx, 'a', 'later\n');
        await add(ctx, ['a']);
        advance(1);
        await carryAllExtensions(ctx);

        // Act
        const sut = stashPop;
        await sut(ctx, { restoreIndex: true });

        // Assert
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });

  describe('Given a stash of a staged change and an edit, and the same change staged again', () => {
    describe('When stash pop --index finds the index already equal to the stash index', () => {
      it('Then the index is not rebuilt and the cache-tree is invalid along the restored edit only', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'staged\n');
        await add(ctx, ['x/y']);
        await write(ctx, 'a', 'edited\n');
        advance(1);
        await stashPush(ctx, {});
        advance(1);
        await write(ctx, 'x/y', 'staged\n');
        await add(ctx, ['x/y']);
        advance(1);
        await carryAllExtensions(ctx);

        // Act
        const sut = stashPop;
        await sut(ctx, { restoreIndex: true });

        // Assert
        expect(await chains(ctx)).toEqual([false, true, true, true]);
      });
    });
  });

  describe('Given a stash whose index added a new file', () => {
    describe('When stash apply merges cleanly without restoring the index', () => {
      it('Then the new file stays staged and the edit stays unstaged', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'edited\n');
        await write(ctx, 'n', 'n\n');
        await add(ctx, ['n']);
        advance(1);
        await stashPush(ctx, {});
        advance(1);

        // Act
        const sut = stashApply;
        await sut(ctx, {});

        // Assert
        const paths = (await readIndex(ctx)).entries.map((e) => e.path);
        expect(paths).toContain('n');
        expect(paths).toHaveLength(Object.keys(FILES).length + 1);
      });
    });
  });

  describe('Given a stash of a staged change and an index carrying extensions', () => {
    describe('When stash pop reinstates the index', () => {
      it('Then REUC and the unknown extension are dropped and the repaired TREE is fully valid', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'staged\n');
        await add(ctx, ['x/y']);
        advance(1);
        await stashPush(ctx, {});
        advance(1);
        await carryAllExtensions(ctx);

        // Act
        const sut = stashPop;
        await sut(ctx, { restoreIndex: true });

        // Assert
        expect(await carriedSignatures(ctx)).toEqual(['TREE', 'UNTR']);
        expect(await chains(ctx)).toEqual([true, true, true, true]);
      });
    });
  });

  describe('Given a staged edit and an unstaged edit and an index carrying extensions', () => {
    describe('When stash push --keep-index resets to HEAD and restores the index', () => {
      it('Then the cache-tree is invalid along the kept staged path only', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'staged\n');
        await add(ctx, ['x/y']);
        await write(ctx, 'a', 'unstaged\n');
        await carryAllExtensions(ctx);

        // Act
        const sut = stashPush;
        await sut(ctx, { keepIndex: true });

        // Assert
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });

  describe('Given a staged edit and an index carrying extensions', () => {
    describe('When stash push resets the index to HEAD without keeping it', () => {
      it('Then no cache-tree chain is invalid', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'staged\n');
        await add(ctx, ['x/y']);
        await carryAllExtensions(ctx);

        // Act
        const sut = stashPush;
        await sut(ctx, {});

        // Assert
        expect(await chains(ctx)).toEqual(ALL_VALID);
      });
    });
  });

  describe('Given a staged new file and an index carrying extensions', () => {
    describe('When stash push --keep-index keeps the new file staged', () => {
      it('Then the cache-tree is invalid along the new path and valid elsewhere', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'd/e/n', 'n\n');
        await add(ctx, ['d/e/n']);
        await carryAllExtensions(ctx);

        // Act
        const sut = stashPush;
        await sut(ctx, { keepIndex: true });

        // Assert
        expect(await chains(ctx)).toEqual([false, false, false, true]);
      });
    });
  });

  describe('Given a staged deletion and an index carrying extensions', () => {
    describe('When stash push --keep-index keeps the deletion staged', () => {
      it('Then the cache-tree is invalid along the deleted path and valid elsewhere', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await rm(ctx, ['d/c']);
        await carryAllExtensions(ctx);

        // Act
        const sut = stashPush;
        await sut(ctx, { keepIndex: true });

        // Assert
        expect(await chains(ctx)).toEqual([false, false, true, true]);
      });
    });
  });

  describe('Given a staged mode change with the same blob and an index carrying extensions', () => {
    describe('When stash push --keep-index keeps the mode change staged', () => {
      it('Then the cache-tree is invalid along the mode-changed path only', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        const baseLstat = ctx.fs.lstat;
        const execFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop !== 'lstat') return Reflect.get(target, prop, receiver);
            return async (path: string) => {
              const real = await baseLstat(path);
              return path.endsWith('/x/y') ? { ...real, mode: real.mode | 0o111 } : real;
            };
          },
        });
        await add({ ...ctx, fs: execFs }, ['x/y']);
        await carryAllExtensions(ctx);

        // Act
        const sut = stashPush;
        await sut(ctx, { keepIndex: true });

        // Assert
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });

  describe('Given an unstaged edit only and an index carrying extensions', () => {
    describe('When stash push --keep-index finds the index equal to HEAD', () => {
      it('Then no cache-tree chain is invalid', async () => {
        // Arrange
        const ctx = await repoWithExtensions();
        await write(ctx, 'x/y', 'edited\n');
        await carryAllExtensions(ctx);

        // Act
        const sut = stashPush;
        await sut(ctx, { keepIndex: true });

        // Assert
        expect(await chains(ctx)).toEqual(ALL_VALID);
      });
    });
  });
});
