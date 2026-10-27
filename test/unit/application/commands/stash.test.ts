import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { hardResetWorktreeToCommit } from '../../../../src/application/commands/internal/reset-worktree.js';
import {
  applyAutostash,
  createAutostash,
  restoreSnapshot,
  snapshotLocalChanges,
  stashApply,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
} from '../../../../src/application/commands/stash.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import * as flattenTreeMod from '../../../../src/application/primitives/flatten-tree.js';
import { flattenTree } from '../../../../src/application/primitives/flatten-tree.js';
import { hashBlob } from '../../../../src/application/primitives/hash-blob.js';
import * as convertBlobMod from '../../../../src/application/primitives/internal/convert-blob.js';
import { indexEntryFromStat } from '../../../../src/application/primitives/internal/index-entry-from-stat.js';
import * as writeFileMod from '../../../../src/application/primitives/internal/write-working-tree-file.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { pushStashRef, readStashStack } from '../../../../src/application/primitives/stash-ref.js';
import { MAX_WORKING_TREE_BLOB_BYTES } from '../../../../src/application/primitives/types.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type {
  AuthorIdentity,
  FilePath,
  ObjectId,
  RefName,
} from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../../../src/ports/command-runner.js';
import { type Context, createSession } from '../../../../src/ports/context.js';
import { refuseReadOnSymlink, serializeIndexFixtureAsync } from '../primitives/fixtures.js';
import { asBareContext } from './fixtures.js';

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

/**
 * Push a stash W whose untracked-tree parent is `untrackedTree` directly —
 * bypasses `stashPush`'s own walk (which can never produce a hostile shape,
 * since every walked entry is validated before it is ever hashed) to
 * simulate a crafted/foreign stash exactly as one could arrive via a
 * hand-edited `refs/stash` or a hostile remote's object stream.
 */
const pushHostileUntrackedStash = async (ctx: Context, untrackedTree: ObjectId): Promise<void> => {
  const head = await headId(ctx);
  const headTree = (await commitOf(ctx, head)).tree;
  const untrackedParent = await createCommit(ctx, {
    tree: untrackedTree,
    parents: [],
    author,
    committer: author,
    message: 'untracked files on main',
    extraHeaders: [],
  });
  const indexParent = await createCommit(ctx, {
    tree: headTree,
    parents: [head],
    author,
    committer: author,
    message: 'index on main',
    extraHeaders: [],
  });
  const w = await createCommit(ctx, {
    tree: headTree,
    parents: [head, indexParent, untrackedParent],
    author,
    committer: author,
    message: 'WIP on main',
    extraHeaders: [],
  });
  await pushStashRef(ctx, w, 'WIP on main');
};

const refusalDataOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return (err as TsgitError).data;
  }
  return undefined;
};

const lstatOrUndefined = async (ctx: Context, path: string) =>
  ctx.fs.lstat(`${ctx.layout.workDir}/${path}`).catch(() => undefined);

/** Pushes untracked `a`, `m/z`, `u`, `z` with `-u`, leaving a clean tree. */
const stashFourUntracked = async (): Promise<Context> => {
  const ctx = await setupRepo();
  for (const name of ['a', 'm/z', 'u', 'z']) await write(ctx, name, `${name}\n`);
  await stashPush(ctx, { includeUntracked: true });
  return ctx;
};

const NOT_WRITTEN = ['m/z', 'u', 'z'];

const GITLINK_A = 'a'.repeat(40) as ObjectId;
const GITLINK_C = 'c'.repeat(40) as ObjectId;

const checkOutSubmoduleAt = async (ctx: Context, head: ObjectId): Promise<void> => {
  const moduleDir = `${ctx.layout.gitDir}/modules/sub`;
  await ctx.fs.mkdir(`${ctx.layout.workDir}/sub`);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.git`, 'gitdir: ../.git/modules/sub\n');
  await ctx.fs.writeUtf8(`${moduleDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.mkdir(`${moduleDir}/objects`);
  await ctx.fs.writeUtf8(`${moduleDir}/refs/heads/main`, `${head}\n`);
};

const replaceIndexEntries = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
): Promise<void> => {
  await ctx.fs.write(
    `${ctx.layout.gitDir}/index`,
    await serializeIndexFixtureAsync(
      { version: 2, entries, extensions: [], trailerSha: new Uint8Array(0) },
      ctx,
    ),
  );
};

const stageGitlink = async (
  ctx: Context,
  mode: string,
  id: ObjectId,
  path = 'sub',
): Promise<void> => {
  const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/sub`);
  const tracked = await readIndex(ctx);
  await replaceIndexEntries(ctx, [
    ...tracked.entries.filter((entry) => entry.path !== path),
    indexEntryFromStat(stat, mode as IndexEntry['mode'], id, path as FilePath),
  ]);
};

const unstagePath = async (ctx: Context, path: string): Promise<void> => {
  const tracked = await readIndex(ctx);
  await replaceIndexEntries(
    ctx,
    tracked.entries.filter((entry) => entry.path !== path),
  );
};

/** HEAD commits the gitlink `sub` at A; the checkout inside `sub` sits at `checkedOut`. */
const setupRepoWithSubmodule = async (checkedOut: ObjectId): Promise<Context> => {
  const ctx = await setupRepo();
  await checkOutSubmoduleAt(ctx, GITLINK_A);
  await stageGitlink(ctx, FILE_MODE.GITLINK, GITLINK_A);
  await commit(ctx, { message: 'add submodule', author });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/modules/sub/refs/heads/main`, `${checkedOut}\n`);
  return ctx;
};

describe('stash push', () => {
  describe('Given three committed files sharing a directory', () => {
    describe('When push runs', () => {
      it('Then the directory is lstat-ed once per pass: the opening refresh, the classification, the restore, the index refresh', async () => {
        // Arrange — the clock stands still, so the index and the files share one second and
        // every entry is racily clean: the refresh pass always runs.
        vi.useFakeTimers({ toFake: ['Date'] });
        const ctx = createMemoryContext();
        await init(ctx);
        for (const name of ['d/a', 'd/b', 'd/c']) await commitFile(ctx, name, `${name}\n`, name);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/d/a`, 'edited\n');
        const lstat = vi.spyOn(ctx.fs, 'lstat');
        const sut = stashPush;

        // Act
        try {
          await sut(ctx, {});
        } finally {
          vi.useRealTimers();
        }

        // Assert
        // Four passes walk the tree, each with its own leading-path memo: the opening refresh,
        // the classification of the tracked entries, the restore that writes HEAD back, and the
        // racy-clean comparison that refreshes the index; none lstat-s the directory more than once.
        expect(
          lstat.mock.calls.filter(([path]) => path === `${ctx.layout.workDir}/d`),
        ).toHaveLength(4);
      });
    });
  });

  describe('Given only the work tree differs from an unchanged index', () => {
    describe('When the stash is pushed', () => {
      it('Then HEAD is not flattened to look for index-lost paths', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'edited\n');
        const headTree = (await commitOf(ctx, await headId(ctx))).tree;
        const flatten = vi.spyOn(flattenTreeMod, 'flattenEscapedTree');
        const sut = stashPush;

        // Act
        await sut(ctx, {});

        // Assert
        expect(flatten.mock.calls.filter(([, tree]) => tree === headTree)).toEqual([]);
        flatten.mockRestore();
      });
    });
  });

  describe('Given a gitlink newly staged and nothing else changed', () => {
    describe('When push runs', () => {
      it('Then it reports no local changes', async () => {
        // Arrange
        const ctx = await setupRepoWithSubmodule(GITLINK_A);
        await stageGitlink(ctx, FILE_MODE.GITLINK, GITLINK_C, 'other');

        // Act
        const result = await stashPush(ctx, {});

        // Assert
        expect(result).toEqual({ kind: 'no-local-changes' });
      });
    });
  });

  describe('Given a committed gitlink removed from the index and nothing else changed', () => {
    describe('When push runs', () => {
      it('Then it reports no local changes', async () => {
        // Arrange
        const ctx = await setupRepoWithSubmodule(GITLINK_A);
        await unstagePath(ctx, 'sub');

        // Act
        const result = await stashPush(ctx, {});

        // Assert
        expect(result).toEqual({ kind: 'no-local-changes' });
      });
    });
  });

  describe('Given a gitlink staged at a new id and nothing else changed', () => {
    describe('When push runs', () => {
      it('Then it reports no local changes', async () => {
        // Arrange
        const ctx = await setupRepoWithSubmodule(GITLINK_C);
        await stageGitlink(ctx, FILE_MODE.GITLINK, GITLINK_C);

        // Act
        const result = await stashPush(ctx, {});

        // Assert
        expect(result).toEqual({ kind: 'no-local-changes' });
      });
    });
  });

  describe('Given a regular file in the index where HEAD holds a gitlink', () => {
    describe('When push runs', () => {
      it('Then a stash is made, since a type change is a local change', async () => {
        // Arrange
        const ctx = await setupRepoWithSubmodule(GITLINK_A);
        await ctx.fs.rm(`${ctx.layout.workDir}/sub/.git`);
        await ctx.fs.rm(`${ctx.layout.workDir}/sub`);
        await write(ctx, 'sub', 'now a file\n');
        await add(ctx, ['sub']);
        await ctx.fs.rm(`${ctx.layout.workDir}/sub`);

        // Act
        const result = await stashPush(ctx, {});

        // Assert
        expect(result.kind).toBe('saved');
      });
    });
  });

  describe('Given a regular file staged where HEAD holds a gitlink and the working tree matches the index', () => {
    describe('When push runs', () => {
      it('Then a stash is made, since the staged type change is the only local change', async () => {
        // Arrange
        const ctx = await setupRepoWithSubmodule(GITLINK_A);
        await ctx.fs.rm(`${ctx.layout.workDir}/sub/.git`);
        await ctx.fs.rm(`${ctx.layout.workDir}/sub`);
        await write(ctx, 'sub', 'now a file\n');
        await add(ctx, ['sub']);

        // Act
        const result = await stashPush(ctx, {});

        // Assert
        expect(result.kind).toBe('saved');
      });
    });
  });

  describe('Given a gitlink staged at a new id and a tracked file staged with an edit', () => {
    describe('When push runs', () => {
      it('Then a stash is made, since the file edit is a local change', async () => {
        // Arrange
        const ctx = await setupRepoWithSubmodule(GITLINK_C);
        await stageGitlink(ctx, FILE_MODE.GITLINK, GITLINK_C);
        await write(ctx, 'a.txt', 'staged edit\n');
        await add(ctx, ['a.txt']);

        // Act
        const result = await stashPush(ctx, {});

        // Assert
        expect(result.kind).toBe('saved');
      });
    });
  });

  describe('Given an unmoved gitlink with a file edited inside its checkout', () => {
    describe('When push runs', () => {
      it('Then it reports no local changes', async () => {
        // Arrange
        const ctx = await setupRepoWithSubmodule(GITLINK_A);
        await write(ctx, 'sub/k', 'edited\n');

        // Act
        const result = await stashPush(ctx, {});

        // Assert
        expect(result).toEqual({ kind: 'no-local-changes' });
      });
    });
  });

  describe('Given a moved gitlink and an edited tracked file', () => {
    describe('When push runs', () => {
      it('Then the W tree keeps the index id for the gitlink', async () => {
        // Arrange
        const ctx = await setupRepoWithSubmodule(GITLINK_C);
        await write(ctx, 'a.txt', 'modified\n');

        // Act
        const result = await stashPush(ctx, {});

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, result.stash);
        const flat = await flattenTree(ctx, w.tree);
        expect(flat.entries.get('sub' as FilePath)).toEqual({
          id: GITLINK_A,
          mode: FILE_MODE.GITLINK,
        });
      });
    });
  });

  describe('Given a clean working tree', () => {
    describe('When push runs', () => {
      it('Then it reports no local changes and writes no stash ref', async () => {
        // Arrange
        const ctx = await setupRepo();

        // Act
        const result = await stashPush(ctx, {});

        // Assert
        expect(result).toEqual({ kind: 'no-local-changes' });
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
        const result = await stashPush(ctx, {});

        // Assert
        expect(result.kind).toBe('saved');
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
        const result = await stashPush(ctx, {});

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, result.stash);
        // The W tree drops the deleted path; the reset restores it from HEAD.
        expect(await treeContent(ctx, w.tree, 'a.txt')).toBe('<absent>');
        expect(await read(ctx, 'a.txt')).toBe('committed\n');
      });
    });
  });

  describe('Given a tracked symlink retargeted in the working tree (no-dereference audit)', () => {
    describe('When push runs, and ctx.fs.read is wired to fail on the symlink path', () => {
      it('Then the W tree stores the new target without ever reading through the link', async () => {
        // Arrange
        const ctx = await setupRepo();
        await ctx.fs.symlink('old-target', `${ctx.layout.workDir}/link`);
        await add(ctx, ['link']);
        await commit(ctx, { message: 'add link', author });
        await ctx.fs.rm(`${ctx.layout.workDir}/link`);
        await ctx.fs.symlink('new-target', `${ctx.layout.workDir}/link`);
        const guarded = refuseReadOnSymlink(ctx, `${ctx.layout.workDir}/link`);

        // Act
        const result = await stashPush(guarded, {});

        // Assert — read back through the SAME Context that wrote. The
        // loose-object fanout cache is per-Context and `writeObject`
        // invalidates only the writing one, so reading the freshly-written
        // stash objects through `ctx` consults a set that never learned about
        // them — a miss whenever `ctx` had already probed and cached that
        // oid's prefix as absent, which is why it failed intermittently.
        if (result.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(guarded, result.stash);
        expect(await treeContent(guarded, w.tree, 'link')).toBe('new-target');
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
        const result = await stashPush(ctx, {});

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, result.stash);
        expect(w.parents).toHaveLength(2);
        expect(await treeContent(ctx, w.tree, 'a.txt')).toBe('modified\n');
      });
    });
  });

  describe.each([
    ['MERGE_HEAD', false],
    ['REBASE_HEAD', true],
  ])('Given %s naming HEAD and an edited file', (marker, kept) => {
    describe('When stash push runs', () => {
      it(`Then the stash is saved and ${marker} ${kept ? 'stays' : 'is removed'}`, async () => {
        // Arrange
        const ctx = await setupRepo();
        const head = await resolveRef(ctx, 'HEAD' as RefName);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${marker}`, `${head}\n`);
        await write(ctx, 'a.txt', 'edited\n');
        const sut = stashPush;

        // Act
        const result = await sut(ctx, {});

        // Assert
        expect(result.kind).toBe('saved');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/${marker}`)).toBe(kept);
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
        const result = await stashPush(ctx, {});

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, result.stash);
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

  describe('Given a staged and an unstaged change', () => {
    const arrangeStaged = async (runner: MemoryHookRunner): Promise<Context> => {
      const ctx = createMemoryContext({ hooks: runner });
      await init(ctx);
      await commitFile(ctx, 'a.txt', 'committed\n', 'initial commit');
      await write(ctx, 'a.txt', 'staged\n');
      await add(ctx, ['a.txt']);
      await write(ctx, 'a.txt', 'unstaged\n');
      return ctx;
    };
    const postCheckoutSince = (runner: MemoryHookRunner, since: number) =>
      runner.calls.slice(since).filter((call) => call.name === 'post-checkout');

    describe('When stash push keeps the index', () => {
      it('Then post-checkout fires once with [head, head, 0]', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = await arrangeStaged(runner);
        const head = await headId(ctx);
        const before = runner.calls.length;

        // Act
        await stashPush(ctx, { keepIndex: true });

        // Assert
        const post = postCheckoutSince(runner, before);
        expect(post).toHaveLength(1);
        expect(post[0]?.args).toEqual([head, head, '0']);
      });
    });

    describe('When stash push does not keep the index', () => {
      it('Then post-checkout does not fire', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = await arrangeStaged(runner);
        const before = runner.calls.length;

        // Act
        await stashPush(ctx, {});

        // Assert
        expect(postCheckoutSince(runner, before)).toHaveLength(0);
      });
    });
  });

  describe('Given nothing to stash', () => {
    describe('When stash push keeps the index', () => {
      it('Then post-checkout does not fire', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'committed\n', 'initial commit');
        const before = runner.calls.length;

        // Act
        const result = await stashPush(ctx, { keepIndex: true });

        // Assert
        expect(result.kind).not.toBe('saved');
        expect(runner.calls.slice(before).filter((c) => c.name === 'post-checkout')).toHaveLength(
          0,
        );
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
        const result = await stashPush(ctx, { includeUntracked: true });

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, result.stash);
        expect(w.parents).toHaveLength(3);
        const uTree = (await commitOf(ctx, w.parents[2] as ObjectId)).tree;
        expect(await treeContent(ctx, uTree, 'new.txt')).toBe('untracked\n');
        // The untracked commit holds ONLY untracked files — the tracked `a.txt` is excluded.
        expect(await treeContent(ctx, uTree, 'a.txt')).toBe('<absent>');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/new.txt`)).toBe(false);
      });
    });
  });

  describe('Given untracked m/z and deep/er/w with includeUntracked', () => {
    describe('When push runs', () => {
      it('Then the emptied directories m, deep/er and deep are gone from the work tree', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'm/z', 'z\n');
        await write(ctx, 'deep/er/w', 'w\n');
        const sut = stashPush;

        // Act
        await sut(ctx, { includeUntracked: true });

        // Assert
        expect(await lstatOrUndefined(ctx, 'm')).toBeUndefined();
        expect(await lstatOrUndefined(ctx, 'deep/er')).toBeUndefined();
        expect(await lstatOrUndefined(ctx, 'deep')).toBeUndefined();
        expect(await read(ctx, 'a.txt')).toBe('committed\n');
      });
    });
  });

  describe('Given untracked m/z beside tracked m/t with includeUntracked', () => {
    describe('When push runs', () => {
      it('Then m and m/t remain', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'm/t', 't\n', 'track m/t');
        await write(ctx, 'm/z', 'z\n');
        const sut = stashPush;

        // Act
        await sut(ctx, { includeUntracked: true });

        // Assert
        expect(await lstatOrUndefined(ctx, 'm')).toBeDefined();
        expect(await read(ctx, 'm/t')).toBe('t\n');
        expect(await lstatOrUndefined(ctx, 'm/z')).toBeUndefined();
      });
    });
  });

  describe('Given untracked m/z beside an ignored m/.cache with includeUntracked', () => {
    describe('When push runs', () => {
      it('Then m and m/.cache remain', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, '.gitignore', 'm/.cache\n', 'ignore cache');
        await write(ctx, 'm/z', 'z\n');
        await write(ctx, 'm/.cache', 'cache\n');
        const sut = stashPush;

        // Act
        await sut(ctx, { includeUntracked: true });

        // Assert
        expect(await lstatOrUndefined(ctx, 'm')).toBeDefined();
        expect(await read(ctx, 'm/.cache')).toBe('cache\n');
        expect(await lstatOrUndefined(ctx, 'm/z')).toBeUndefined();
      });
    });
  });

  describe('Given a tracked directory replaced by an untracked file of the same name', () => {
    describe('When push runs with includeUntracked', () => {
      it('Then the directory content is restored and the file is kept in the untracked commit', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'd/x', 'x\n', 'initial commit');
        await ctx.fs.rm(`${ctx.layout.workDir}/d/x`);
        await ctx.fs.rm(`${ctx.layout.workDir}/d`);
        await write(ctx, 'd', 'untracked\n');
        const sut = stashPush;

        // Act
        const result = await sut(ctx, { includeUntracked: true });

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, result.stash);
        expect(w.parents).toHaveLength(3);
        const uTree = (await commitOf(ctx, w.parents[2] as ObjectId)).tree;
        expect(await treeContent(ctx, uTree, 'd')).toBe('untracked\n');
        expect(await read(ctx, 'd/x')).toBe('x\n');
      });
    });
  });

  describe('Given a tracked file replaced by an untracked file in a directory of the same name', () => {
    describe('When push runs with includeUntracked', () => {
      it('Then the tracked file is back in the work tree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'f', 'f\n', 'initial commit');
        await ctx.fs.rm(`${ctx.layout.workDir}/f`);
        await write(ctx, 'f/y', 'untracked\n');
        const sut = stashPush;

        // Act
        const result = await sut(ctx, { includeUntracked: true });

        // Assert
        expect(result.kind).toBe('saved');
        expect(await read(ctx, 'f')).toBe('f\n');
      });
    });
  });

  describe('Given a tracked edit and no untracked file', () => {
    describe('When push runs with includeUntracked', () => {
      it('Then the third parent is a parentless commit holding the empty tree', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'modified\n');
        const sut = stashPush;

        // Act
        const result = await sut(ctx, { includeUntracked: true });

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, result.stash);
        expect(w.parents).toHaveLength(3);
        const u = await commitOf(ctx, w.parents[2] as ObjectId);
        expect(u.tree).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
        expect(u.parents).toEqual([]);
        expect(u.message.startsWith('untracked files on main: ')).toBe(true);
      });
    });
  });

  describe('Given a clean tree', () => {
    describe('When push runs with includeUntracked', () => {
      it('Then nothing is saved', async () => {
        // Arrange
        const ctx = await setupRepo();
        const sut = stashPush;

        // Act
        const result = await sut(ctx, { includeUntracked: true });

        // Assert
        expect(result).toEqual({ kind: 'no-local-changes' });
      });
    });
  });

  describe('Given a tracked lossy path and an untracked file named like its decoded view', () => {
    describe('When push runs with includeUntracked', () => {
      it('Then the untracked file is stashed and removed from the working tree', async () => {
        // Arrange
        const ctx = await setupRepo();
        const view = '\uFFFD.txt';
        await write(ctx, view, 'untracked\n');
        const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/${view}`);
        const tracked = await readIndex(ctx);
        const lossy: IndexEntry = {
          ...indexEntryFromStat(
            stat,
            FILE_MODE.REGULAR,
            await writeObject(ctx, {
              type: 'blob',
              id: '' as ObjectId,
              content: new TextEncoder().encode('tracked\n'),
            }),
            view as FilePath,
          ),
          pathBytes: Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74),
        };
        await ctx.fs.write(
          `${ctx.layout.gitDir}/index`,
          await serializeIndexFixtureAsync(
            {
              version: 2,
              entries: [...tracked.entries, lossy],
              extensions: [],
              trailerSha: new Uint8Array(0),
            },
            ctx,
          ),
        );

        // Act
        const result = await stashPush(ctx, { includeUntracked: true });

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, result.stash);
        expect(w.parents).toHaveLength(3);
        const uTree = (await commitOf(ctx, w.parents[2] as ObjectId)).tree;
        expect(await treeContent(ctx, uTree, view)).toBe('untracked\n');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/${view}`)).toBe(false);
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
        const result = await stashPush(ctx, {});

        // Assert
        expect(result).toEqual({ kind: 'no-local-changes' });
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
        const result = await stashList(ctx);

        // Assert
        expect(result).toEqual({ entries: [] });
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
        const result = await stashList(ctx);

        // Assert
        expect(result.entries.map((e) => e.selector)).toEqual(['stash@{0}', 'stash@{1}']);
        expect(result.entries.map((e) => e.stash)).toEqual([second, first]);
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
        const result = await stashDrop(ctx, { index: 1 });

        // Assert
        expect(result).toEqual({ dropped: second, remaining: 2 });
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
        const result = await stashDrop(ctx, {});

        // Assert
        expect(result.remaining).toBe(0);
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

  describe('Given an empty stack AND a malformed core.maxTreeDepth', () => {
    describe('When drop runs', () => {
      it('Then it dies on the repo-settings class, not STASH_NOT_FOUND', async () => {
        // Arrange
        const ctx = await setupRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
        invalidateConfigCache(ctx);

        // Act
        const act = stashDrop(ctx, {});

        // Assert
        await act.catch((err: TsgitError) => {
          expect(err.data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
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
  describe('Given a stash whose work tree equals its base because a tracked file became a directory', () => {
    describe('When apply runs', () => {
      it('Then it applies without writing AUTO_MERGE and keeps the index entries', async () => {
        // Arrange
        const ctx = await setupRepo();
        await ctx.fs.rm(`${ctx.layout.workDir}/a.txt`);
        await write(ctx, 'a.txt/y', 'inside\n');
        const saved = await stashPush(ctx, {});
        if (saved.kind !== 'saved') throw new Error('expected saved');
        const entriesBefore = (await readIndex(ctx)).entries.map((e) => [e.path, e.id]);

        // Act
        const sut = stashApply;
        const result = await sut(ctx, {});

        // Assert
        expect(result).toEqual({ kind: 'applied', stash: saved.stash });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/AUTO_MERGE`)).toBe(false);
        const entriesAfter = (await readIndex(ctx)).entries.map((e) => [e.path, e.id]);
        expect(entriesAfter).toEqual(entriesBefore);
      });
    });
  });

  describe('Given a stash whose work file equals the committed bytes while the index staged another blob', () => {
    describe('When apply runs with restoreIndex', () => {
      it('Then the index holds the staged blob and the work file keeps the committed bytes', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'staged\n');
        await add(ctx, ['a.txt']);
        await write(ctx, 'a.txt', 'committed\n');
        await stashPush(ctx, {});

        // Act
        const sut = stashApply;
        await sut(ctx, { restoreIndex: true });

        // Assert
        const entry = (await readIndex(ctx)).entries.find((e) => e.path === 'a.txt');
        expect(entry?.id).toBe(await hashBlob(ctx, new TextEncoder().encode('staged\n')));
        expect(await read(ctx, 'a.txt')).toBe('committed\n');
      });
    });
  });

  describe('Given a staged type swap stashed plain', () => {
    describe('When stash apply runs with restoreIndex', () => {
      it('Then the reinstated entry d carries the stat of the written file', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'd/x', 'x\n', 'add d/x');
        await ctx.fs.rm(`${ctx.layout.workDir}/d/x`);
        await ctx.fs.rm(`${ctx.layout.workDir}/d`);
        await write(ctx, 'd', 'now a file\n');
        await add(ctx, ['d', 'd/x']);
        await stashPush(ctx, {});

        // Act
        const sut = stashApply;
        const result = await sut(ctx, { restoreIndex: true });

        // Assert
        expect(result.kind).toBe('applied');
        const entry = (await readIndex(ctx)).entries.find((e) => e.path === 'd');
        const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/d`);
        expect(entry?.mtimeSeconds).toBe(Math.floor(stat.mtimeMs / 1000));
        expect(entry?.fileSize).toBe(stat.size);
      });
    });
  });

  describe('Given a stash of an unstaged change applied onto a clean tree', () => {
    describe('When apply runs', () => {
      it('Then the change returns to the working tree and stays unstaged', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'modified\n');
        const saved = await stashPush(ctx, {});
        if (saved.kind !== 'saved') throw new Error('expected saved');

        // Act
        const result = await stashApply(ctx, {});

        // Assert
        expect(result).toEqual({ kind: 'applied', stash: saved.stash });
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
        const result = await stashApply(ctx, {});

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        expect(result.conflicts.map((c) => c.path)).toEqual(['a.txt']);
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

  describe('Given content already present at the stashed path (working file or symlink)', () => {
    describe('When apply runs', () => {
      it.each([
        {
          label: 'a dirty working file on the stashed path',
          build: async (): Promise<Context> => {
            const ctx = await setupRepo();
            await write(ctx, 'a.txt', 'stashed\n');
            await stashPush(ctx, {});
            await write(ctx, 'a.txt', 'local edit\n');
            return ctx;
          },
          paths: ['a.txt'],
          preserved: { path: 'a.txt', content: 'local edit\n' },
        },
      ])(
        'Then it refuses with STASH_APPLY_WOULD_OVERWRITE for $label',
        async ({ build, paths, preserved }) => {
          // Arrange
          const ctx = await build();

          // Act
          let caught: unknown;
          try {
            await stashApply(ctx, {});
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'STASH_APPLY_WOULD_OVERWRITE',
            paths,
          });
          if (preserved !== undefined) {
            expect(await read(ctx, preserved.path)).toBe(preserved.content);
          }
        },
      );
    });
  });

  describe('Given an untracked path whose leading component is an obstruction', () => {
    describe('When apply runs', () => {
      it.each([
        {
          label: 'a regular file',
          plant: async (ctx: Context): Promise<void> => write(ctx, 'm', 'occupant\n'),
          kept: { symlink: false, target: undefined },
        },
        {
          label: 'a link to a file',
          plant: async (ctx: Context): Promise<void> =>
            ctx.fs.symlink('a.txt', `${ctx.layout.workDir}/m`),
          kept: { symlink: true, target: 'a.txt' },
        },
        {
          label: 'a link to a directory',
          plant: async (ctx: Context): Promise<void> => {
            await ctx.fs.mkdir(`${ctx.layout.workDir}/elsewhere`);
            await ctx.fs.symlink('elsewhere', `${ctx.layout.workDir}/m`);
          },
          kept: { symlink: true, target: 'elsewhere' },
        },
        {
          label: 'a dangling link',
          plant: async (ctx: Context): Promise<void> =>
            ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/m`),
          kept: { symlink: true, target: 'nowhere' },
        },
      ])(
        'Then it throws with blockedAt m, keeps $label and writes only the entries before it',
        async ({ plant, kept }) => {
          // Arrange
          const ctx = await stashFourUntracked();
          await plant(ctx);
          const sut = stashApply;

          // Act
          const data = await refusalDataOf(() => sut(ctx, {}));

          // Assert
          expect(data).toEqual({
            code: 'STASH_UNTRACKED_NOT_RESTORED',
            existing: [],
            blockedAt: 'm',
          });
          expect(await read(ctx, 'a')).toBe('a\n');
          const stat = await lstatOrUndefined(ctx, 'm');
          expect(stat?.isSymbolicLink).toBe(kept.symlink);
          if (kept.target !== undefined) {
            expect(await ctx.fs.readlink(`${ctx.layout.workDir}/m`)).toBe(kept.target);
          }
          for (const name of NOT_WRITTEN) {
            expect(await lstatOrUndefined(ctx, name)).toBeUndefined();
          }
        },
      );
    });
  });

  describe('Given content already present at a stashed untracked path', () => {
    describe('When apply runs', () => {
      it.each([
        {
          label: 'a dangling symlink',
          // The lstat-based presence probe sees the link where a
          // target-following probe would not (its target does not exist).
          squat: async (ctx: Context): Promise<void> =>
            ctx.fs.symlink('/nonexistent/target', `${ctx.layout.workDir}/new.txt`),
        },
        {
          label: 'an untracked file',
          squat: async (ctx: Context): Promise<void> => write(ctx, 'new.txt', 'in the way\n'),
        },
      ])('Then it throws STASH_UNTRACKED_NOT_RESTORED and keeps $label', async ({ squat }) => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'new.txt', 'untracked\n');
        await stashPush(ctx, { includeUntracked: true });
        await squat(ctx);
        const before = await lstatOrUndefined(ctx, 'new.txt');
        const sut = stashApply;

        // Act
        const data = await refusalDataOf(() => sut(ctx, {}));

        // Assert
        expect(data).toEqual({ code: 'STASH_UNTRACKED_NOT_RESTORED', existing: ['new.txt'] });
        const after = await lstatOrUndefined(ctx, 'new.txt');
        expect(after?.isSymbolicLink).toBe(before?.isSymbolicLink);
        expect(after?.size).toBe(before?.size);
      });
    });
  });

  describe('Given a stashed untracked path recreated after the push', () => {
    describe('When apply runs', () => {
      it('Then the other untracked paths and the tracked edit are applied and the recreated file is kept', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'edited\n');
        for (const name of ['a', 'm/z', 'u', 'z']) await write(ctx, name, `${name}\n`);
        await stashPush(ctx, { includeUntracked: true });
        await write(ctx, 'u', 'other\n');
        const sut = stashApply;

        // Act
        const data = await refusalDataOf(() => sut(ctx, {}));

        // Assert
        expect(data).toEqual({ code: 'STASH_UNTRACKED_NOT_RESTORED', existing: ['u'] });
        expect(await read(ctx, 'a')).toBe('a\n');
        expect(await read(ctx, 'm/z')).toBe('m/z\n');
        expect(await read(ctx, 'z')).toBe('z\n');
        expect(await read(ctx, 'u')).toBe('other\n');
        expect(await read(ctx, 'a.txt')).toBe('edited\n');
      });
    });
  });

  describe('Given a directory replaced by an untracked file of the same name', () => {
    describe('When apply runs on the reset tree', () => {
      it('Then the merge deletes the tracked entry and the file is restored', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'd/x', 'x\n', 'add d/x');
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/d`);
        await write(ctx, 'd', 'file\n');
        await stashPush(ctx, { includeUntracked: true });
        const sut = stashApply;

        // Act
        const result = await sut(ctx, {});

        // Assert
        expect(result.kind).toBe('applied');
        expect(await read(ctx, 'd')).toBe('file\n');
        expect(await lstatOrUndefined(ctx, 'd/x')).toBeUndefined();
      });
    });
  });

  describe('Given stashed untracked paths u, v, w and x with u and w already present', () => {
    describe('When apply runs', () => {
      it.each([
        {
          label: 'a directory holding a file',
          squat: async (ctx: Context): Promise<void> => write(ctx, 'u/inner', 'kept\n'),
        },
        {
          label: 'an empty directory',
          squat: async (ctx: Context): Promise<void> => ctx.fs.mkdir(`${ctx.layout.workDir}/u`),
        },
        {
          label: 'a dangling link',
          squat: async (ctx: Context): Promise<void> =>
            ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/u`),
        },
      ])(
        'Then it lists both present paths in order and still writes the free ones: $label at u',
        async ({ squat }) => {
          // Arrange
          const ctx = await setupRepo();
          for (const name of ['u', 'v', 'w', 'x']) await write(ctx, name, `${name}\n`);
          await stashPush(ctx, { includeUntracked: true });
          await squat(ctx);
          await write(ctx, 'w', 'other\n');
          const sut = stashApply;

          // Act
          const data = await refusalDataOf(() => sut(ctx, {}));

          // Assert
          expect(data).toEqual({ code: 'STASH_UNTRACKED_NOT_RESTORED', existing: ['u', 'w'] });
          expect(await read(ctx, 'v')).toBe('v\n');
          expect(await read(ctx, 'x')).toBe('x\n');
          expect(await read(ctx, 'w')).toBe('other\n');
        },
      );
    });
  });

  describe('Given stashed untracked paths m/y and m/z with no m on disk', () => {
    describe('When apply runs', () => {
      it('Then both are restored', async () => {
        // Arrange
        const ctx = await setupRepo();
        for (const name of ['m/y', 'm/z']) await write(ctx, name, `${name}\n`);
        await stashPush(ctx, { includeUntracked: true });
        const sut = stashApply;

        // Act
        const result = await sut(ctx, {});

        // Assert
        expect(result.kind).toBe('applied');
        expect(await read(ctx, 'm/y')).toBe('m/y\n');
        expect(await read(ctx, 'm/z')).toBe('m/z\n');
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

  describe('Given an include-untracked stash with a regular file', () => {
    describe('When apply runs', () => {
      it('Then routes through writeWorkingTreeEntryStream and restored bytes match source', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'streamed.txt', 'streamed content\n');
        await stashPush(ctx, { includeUntracked: true });
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');

        // Act
        await stashApply(ctx, {});

        // Assert
        expect(writeStreamSpy).toHaveBeenCalled();
        expect(await read(ctx, 'streamed.txt')).toBe('streamed content\n');

        writeStreamSpy.mockRestore();
      });
    });
  });

  describe('Given an include-untracked stash with a large-ish blob (dropped size cap)', () => {
    describe('When apply runs', () => {
      it('Then restore succeeds with no size cap', async () => {
        // Arrange — large enough that any explicit cap would be visible; no OBJECT_TOO_LARGE expected
        const ctx = await setupRepo();
        const largeContent = 'x'.repeat(2048);
        await write(ctx, 'large.bin', largeContent);
        await stashPush(ctx, { includeUntracked: true });

        // Act — must not throw
        await stashApply(ctx, {});

        // Assert — called with exactly (ctx, id): no third options argument (no maxBytes)
        expect(await read(ctx, 'large.bin')).toBe(largeContent);
      });
    });
  });

  describe('Given an unreadable alternate and an untracked entry whose small packed blob is not in the primary store', () => {
    describe('When apply runs', () => {
      it("Then the path exists with size 0 and the call rejects with the alternate's error", async () => {
        // Arrange
        const alternateObjects = '/repo/alt/objects';
        const ctx = createMemoryContext({
          files: {
            '/repo/.git/objects/info/alternates': new TextEncoder().encode(`${alternateObjects}\n`),
          },
        });
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'committed\n', 'initial commit');
        const absentBlob = 'c'.repeat(40) as ObjectId;
        const untrackedTree = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.REGULAR, 'packed.txt', absentBlob)],
        });
        await pushHostileUntrackedStash(ctx, untrackedTree);
        const write = vi.spyOn(ctx.fs, 'write');
        // A write through an alternate that cannot load is refused, so the fault is planted after the setup.
        await ctx.fs.write(
          `${alternateObjects}/pack/multi-pack-index`,
          Uint8Array.from([0x00, 0x49, 0x44, 0x58, 1, 1, 1, 0, ...new Array(8).fill(0)]),
        );

        // Act
        let failure: unknown;
        try {
          await stashApply({ ...ctx, session: createSession() }, {});
        } catch (error) {
          failure = error;
        }

        // Assert
        expect((failure as TsgitError).data).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX' });
        expect((await ctx.fs.read(`${ctx.layout.workDir}/packed.txt`)).length).toBe(0);
        expect(
          write.mock.calls
            .filter(([, , options]) => options?.mode !== undefined)
            .map(([path]) => path),
        ).toEqual([`${ctx.layout.workDir}/packed.txt`]);
      });
    });
  });

  describe('Given an untracked tree holding a lossy name and its U+FFFD twin present in the working tree', () => {
    describe('When apply runs', () => {
      it('Then the twin does not count as an overwrite and no fs probe names an escape', async () => {
        // Arrange
        const ctx = await setupRepo();
        const blob = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('payload\n'),
        });
        const untrackedTree = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [
            treeEntry(FILE_MODE.REGULAR, Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74), blob),
          ],
        });
        await pushHostileUntrackedStash(ctx, untrackedTree);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/\uFFFD.txt`, 'twin');
        const lstatSpy = vi.spyOn(ctx.fs, 'lstat');
        const lexistsSpy = ctx.fs.lexists === undefined ? undefined : vi.spyOn(ctx.fs, 'lexists');
        const sut = stashApply;

        // Act
        const result = await sut({ ...ctx, session: createSession() }, {});

        // Assert
        const probed = [...lstatSpy.mock.calls, ...(lexistsSpy?.mock.calls ?? [])].flat();
        expect(probed.filter((arg) => /[\uDC80-\uDCFF]/.test(String(arg)))).toEqual([]);
        expect(result.kind).toBe('applied');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/\uFFFD.txt`)).toBe('twin');
      });
    });
  });

  describe('Given an include-untracked stash whose untracked tree carries a hostile entry name', () => {
    describe('When apply runs', () => {
      it.each([
        {
          label: 'a `.git/hooks/pre-commit` path',
          hostilePath: '.git/hooks/pre-commit',
          buildUntrackedTree: async (ctx: Context): Promise<ObjectId> => {
            const hookBlob = await writeObject(ctx, {
              type: 'blob',
              id: '' as ObjectId,
              content: new TextEncoder().encode('#!/bin/sh\necho pwned\n'),
            });
            const hooksTree = await writeObject(ctx, {
              type: 'tree',
              id: '' as ObjectId,
              entries: [treeEntry(FILE_MODE.REGULAR, 'pre-commit', hookBlob)],
            });
            const gitDirTree = await writeObject(ctx, {
              type: 'tree',
              id: '' as ObjectId,
              entries: [treeEntry(FILE_MODE.DIRECTORY, 'hooks', hooksTree)],
            });
            return writeObject(ctx, {
              type: 'tree',
              id: '' as ObjectId,
              entries: [treeEntry(FILE_MODE.DIRECTORY, '.git', gitDirTree)],
            });
          },
        },
        {
          label: 'a top-level `git~1` NTFS short-name alias entry',
          hostilePath: 'git~1',
          buildUntrackedTree: async (ctx: Context): Promise<ObjectId> => {
            const blob = await writeObject(ctx, {
              type: 'blob',
              id: '' as ObjectId,
              content: new TextEncoder().encode('payload\n'),
            });
            return writeObject(ctx, {
              type: 'tree',
              id: '' as ObjectId,
              entries: [treeEntry(FILE_MODE.REGULAR, 'git~1', blob)],
            });
          },
        },
      ])(
        'Then it refuses with INVALID_INDEX_ENTRY and writes nothing to the working tree for $label',
        async ({ buildUntrackedTree, hostilePath }) => {
          // Arrange
          const ctx = await setupRepo();
          const untrackedTree = await buildUntrackedTree(ctx);
          await pushHostileUntrackedStash(ctx, untrackedTree);

          // Act
          let caught: unknown;
          try {
            await stashApply(ctx, {});
          } catch (err) {
            caught = err;
          }

          // Assert — refused with the whole-tree name gate's error, and the
          // hostile path was never written (the validation pre-pass runs
          // over every entry before the write loop starts).
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('INVALID_INDEX_ENTRY');
          expect(await ctx.fs.exists(`${ctx.layout.workDir}/${hostilePath}`)).toBe(false);
        },
      );
    });
  });

  describe('Given an include-untracked stash whose untracked tree holds x\\y', () => {
    const seedBackslashStash = async (): Promise<Context> => {
      const ctx = await setupRepo();
      const blob = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: new TextEncoder().encode('payload\n'),
      });
      const untrackedTree = await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry(FILE_MODE.REGULAR, 'x\\y', blob)],
      });
      await pushHostileUntrackedStash(ctx, untrackedTree);
      return ctx;
    };

    describe('When apply runs under Windows path syntax', () => {
      it('Then it refuses with the backslash reason and writes nothing', async () => {
        // Arrange
        const ctx = await seedBackslashStash();
        const sut = stashApply;

        // Act
        let caught: unknown;
        try {
          await sut({ ...ctx, windowsPathSyntax: true }, {});
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toMatchObject({
          code: 'INVALID_INDEX_ENTRY',
          offset: -1,
          reason: 'backslash rejected under Windows path syntax',
        });
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/x\\y`)).toBe(false);
      });
    });

    describe('When apply runs under POSIX path syntax', () => {
      it('Then it resolves and writes the blob', async () => {
        // Arrange
        const ctx = await seedBackslashStash();
        const sut = stashApply;

        // Act
        await sut(ctx, {});

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/x\\y`)).toBe('payload\n');
      });
    });
  });

  describe('Given an include-untracked stash whose untracked tree holds a non-UTF-8 name and a twin on disk named by its U+FFFD view', () => {
    describe('When apply runs', () => {
      it('Then it does not refuse, leaves the twin alone and writes no lone-surrogate name', async () => {
        // Arrange
        const ctx = await setupRepo();
        const blob = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('raw\n'),
        });
        const untrackedTree = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [
            treeEntry(FILE_MODE.REGULAR, Uint8Array.from([0xff, 0x2e, 0x74, 0x78, 0x74]), blob),
          ],
        });
        await pushHostileUntrackedStash(ctx, untrackedTree);
        await write(ctx, '\uFFFD.txt', 'twin\n');
        const spies = [
          vi.spyOn(ctx.fs, 'write'),
          vi.spyOn(ctx.fs, 'writeUtf8'),
          vi.spyOn(ctx.fs, 'mkdir'),
          vi.spyOn(ctx.fs, 'rm'),
        ];

        // Act
        const sut = stashApply;
        const result = await sut({ ...ctx, session: createSession() }, {});

        // Assert
        expect(result.kind).toBe('applied');
        expect(await read(ctx, '\uFFFD.txt')).toBe('twin\n');
        const touched = spies.flatMap((spy) => spy.mock.calls.map(([path]) => String(path)));
        expect(touched.filter((path) => /[\uDC80-\uDCFF]/.test(path))).toEqual([]);
        expect(touched.filter((path) => path.includes('\uFFFD.txt'))).toEqual([]);
      });
    });
  });
});

const STASH_CLOCK_MS = 1_700_000_000_000;
const DRIFT_MS = 10_000;

/** A stash of an edit to a.txt, then clean b.txt rewritten with the same bytes later. */
const repoWithDriftedBystander = async (): Promise<Context> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(STASH_CLOCK_MS);
  const ctx = await setupRepo();
  await commitFile(ctx, 'b.txt', 'bystander\n', 'add b');
  await write(ctx, 'a.txt', 'modified\n');
  await stashPush(ctx, {});
  vi.setSystemTime(STASH_CLOCK_MS + DRIFT_MS);
  await write(ctx, 'b.txt', 'bystander\n');
  return ctx;
};

const mtimeOf = async (ctx: Context, path: string): Promise<number> => {
  const found = (await readIndex(ctx)).entries.find((e) => e.path === path);
  if (found === undefined) throw new Error(`${path} is not tracked`);
  return found.mtimeSeconds;
};

describe('stash apply and pop open with the index refresh', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Given a stash and a clean bystander rewritten later with the same bytes', () => {
    describe('When stash apply runs', () => {
      it('Then the bystander entry records its new mtime', async () => {
        // Arrange
        const ctx = await repoWithDriftedBystander();
        const before = await mtimeOf(ctx, 'b.txt');
        const sut = stashApply;

        // Act
        await sut(ctx, {});

        // Assert
        expect(await mtimeOf(ctx, 'b.txt')).toBeGreaterThan(before);
      });
    });

    describe('When stash pop runs', () => {
      it('Then the bystander entry is refreshed and the stash dropped', async () => {
        // Arrange
        const ctx = await repoWithDriftedBystander();
        const before = await mtimeOf(ctx, 'b.txt');
        const sut = stashPop;

        // Act
        await sut(ctx, {});

        // Assert
        expect(await mtimeOf(ctx, 'b.txt')).toBeGreaterThan(before);
        expect((await stashList(ctx)).entries).toEqual([]);
      });
    });
  });

  describe('Given a stash whose path is dirty and a drifted bystander', () => {
    describe('When stash apply refuses', () => {
      it('Then the bystander entry is refreshed anyway', async () => {
        // Arrange
        const ctx = await repoWithDriftedBystander();
        await write(ctx, 'a.txt', 'dirty\n');
        const before = await mtimeOf(ctx, 'b.txt');
        const sut = stashApply;
        let caught: unknown;

        // Act
        try {
          await sut(ctx, {});
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'STASH_APPLY_WOULD_OVERWRITE',
          paths: ['a.txt'],
        });
        expect(await mtimeOf(ctx, 'b.txt')).toBeGreaterThan(before);
      });
    });
  });

  describe('Given an empty stack and a drifted bystander', () => {
    describe('When stash apply runs', () => {
      it('Then it refuses STASH_NOT_FOUND and leaves the index bytes unchanged', async () => {
        // Arrange
        const ctx = await repoWithDriftedBystander();
        await stashDrop(ctx, {});
        const indexPath = `${ctx.layout.gitDir}/index`;
        const before = await ctx.fs.read(indexPath);
        const sut = stashApply;
        let caught: unknown;

        // Act
        try {
          await sut(ctx, {});
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'STASH_NOT_FOUND',
          index: 0,
          stackSize: 0,
        });
        expect(await ctx.fs.read(indexPath)).toEqual(before);
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
        const result = await stashPop(ctx, {});

        // Assert
        expect(result.kind).toBe('applied');
        expect(await read(ctx, 'a.txt')).toBe('modified\n');
        expect((await stashList(ctx)).entries).toEqual([]);
      });
    });
  });

  describe('Given a link to a directory squatting the leading component of a stashed untracked path', () => {
    describe('When pop runs', () => {
      it('Then it throws STASH_UNTRACKED_NOT_RESTORED and the stash is kept', async () => {
        // Arrange
        const ctx = await stashFourUntracked();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/elsewhere`);
        await ctx.fs.symlink('elsewhere', `${ctx.layout.workDir}/m`);
        const sut = stashPop;

        // Act
        const data = await refusalDataOf(() => sut(ctx, {}));

        // Assert
        expect(data).toEqual({
          code: 'STASH_UNTRACKED_NOT_RESTORED',
          existing: [],
          blockedAt: 'm',
        });
        expect((await stashList(ctx)).entries).toHaveLength(1);
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
        const result = await stashPop(ctx, {});

        // Assert
        expect(result.kind).toBe('conflict');
        expect((await stashList(ctx)).entries).toHaveLength(1);
      });
    });
  });
});

const makeBare = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return asBareContext(ctx);
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
      it('Then it throws WORK_TREE_REQUIRED with operation=stash', async () => {
        // Arrange
        const ctx = await makeBare();

        // Act + Assert
        const data = await codeAndOp(stashPush(ctx, {}));
        expect(data.code).toBe('WORK_TREE_REQUIRED');
        expect(data.operation).toBe('stash');
      });
    });

    describe('When apply runs', () => {
      it('Then it throws WORK_TREE_REQUIRED with operation=stash apply', async () => {
        // Arrange
        const ctx = await makeBare();

        // Act + Assert
        const data = await codeAndOp(stashApply(ctx, {}));
        expect(data.code).toBe('WORK_TREE_REQUIRED');
        expect(data.operation).toBe('stash apply');
      });
    });

    describe('When drop runs', () => {
      it('Then it throws WORK_TREE_REQUIRED with operation=stash drop', async () => {
        // Arrange
        const ctx = await makeBare();

        // Act + Assert
        const data = await codeAndOp(stashDrop(ctx, {}));
        expect(data.code).toBe('WORK_TREE_REQUIRED');
        expect(data.operation).toBe('stash drop');
      });
    });

    describe('When list runs', () => {
      it('Then it throws WORK_TREE_REQUIRED with operation=stash list', async () => {
        // Arrange
        const ctx = await makeBare();

        // Act + Assert
        const data = await codeAndOp(stashList(ctx));
        expect(data.code).toBe('WORK_TREE_REQUIRED');
        expect(data.operation).toBe('stash list');
      });
    });

    describe('When pop runs', () => {
      it('Then it throws WORK_TREE_REQUIRED with operation=stash pop (not stash apply)', async () => {
        // Arrange — the gate sits in stashPop itself, ahead of the stashApply
        // delegation, so the operation string names 'pop', not 'apply'.
        const ctx = await makeBare();

        // Act + Assert
        const data = await codeAndOp(stashPop(ctx, {}));
        expect(data.code).toBe('WORK_TREE_REQUIRED');
        expect(data.operation).toBe('stash pop');
      });
    });
  });
});

describe('autostash on a bare repository', () => {
  describe('Given a bare repo', () => {
    describe('When the autostash is created', () => {
      it('Then it throws WORK_TREE_REQUIRED with operation=rebase', async () => {
        // Arrange
        const ctx = await makeBare();
        const sut = createAutostash;

        // Act
        const data = await codeAndOp(sut(ctx));

        // Assert
        expect(data).toEqual({ code: 'WORK_TREE_REQUIRED', operation: 'rebase' });
      });
    });

    describe('When the autostash is applied', () => {
      it('Then it throws WORK_TREE_REQUIRED with operation=rebase', async () => {
        // Arrange
        const ctx = await makeBare();
        const sut = applyAutostash;

        // Act
        const data = await codeAndOp(sut(ctx, '1'.repeat(40) as ObjectId));

        // Assert
        expect(data).toEqual({ code: 'WORK_TREE_REQUIRED', operation: 'rebase' });
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
        const result = await stashPush(ctx, {});

        // Assert
        expect(result.kind).toBe('saved');
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
        const result = await stashPush(ctx, {});

        // Assert
        expect(result.kind).toBe('saved');
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
        const result = await stashPop(ctx, { index: 1 });

        // Assert — older applied to the working tree + dropped; newer remains at index 0.
        expect(result.kind).toBe('applied');
        if (result.kind === 'applied') expect(result.dropped).toBe(older);
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
        const result = await stashPush(ctx, { includeUntracked: true });

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        const u = (await commitOf(ctx, (await commitOf(ctx, result.stash)).parents[2] as ObjectId))
          .tree;
        expect(await treeContent(ctx, u, 'tracked-untracked.txt')).toBe('keep\n');
        // The ignored file is excluded from the stash and left on disk.
        expect(await treeContent(ctx, u, 'ignored.txt')).toBe('<absent>');
        expect(await read(ctx, 'ignored.txt')).toBe('secret\n');
      });
    });
  });
});

// ── Filter-aware stash push ────────────────────────────────────────────────

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const uppercase = (b: Uint8Array): Uint8Array => enc(dec(b).toUpperCase());

class FakeRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    return { exitCode: 0, stdout: uppercase(request.stdin ?? new Uint8Array(0)) };
  }
}

/**
 * Seeds a repo with a .gitattributes filter=myf + [filter "myf"] config,
 * commits the CLEANED (uppercased) bytes as HEAD, then writes the smudged
 * (original) bytes back to the working tree to simulate post-checkout state.
 * Returns the ctx with command runner wired.
 */
const seedFilterStash = async (name: string, smudgedContent: string): Promise<Context> => {
  const runner = new FakeRunner();
  const baseCtx = createMemoryContext();
  await init(baseCtx);

  const ext = name.split('.').pop() ?? 'y';
  await baseCtx.fs.writeUtf8(`${baseCtx.layout.workDir}/.gitattributes`, `*.${ext} filter=myf\n`);
  const configPath = `${baseCtx.layout.gitDir}/config`;
  const existingConfig = await baseCtx.fs.readUtf8(configPath).catch(() => '');
  await baseCtx.fs.writeUtf8(
    configPath,
    `${existingConfig}\n[filter "myf"]\n\tclean = uppercase-clean\n\tsmudge = lowercase-smudge\n`,
  );

  const ctxWithRunner: Context = { ...baseCtx, command: runner };

  await ctxWithRunner.fs.writeUtf8(`${baseCtx.layout.workDir}/${name}`, smudgedContent);
  await add(ctxWithRunner, [name]);
  await commit(ctxWithRunner, { message: 'seed', author });

  // Simulate post-checkout: working tree holds smudged bytes
  await ctxWithRunner.fs.writeUtf8(`${baseCtx.layout.workDir}/${name}`, smudgedContent);
  return ctxWithRunner;
};

describe('stashPush — clean filter re-application', () => {
  describe('Given a smudged-unmodified file under an active filter=myf and a command runner', () => {
    describe('When stashPush is called', () => {
      it('Then the stash reports no-local-changes (worktree treated as unchanged via clean re-application)', async () => {
        // Arrange — worktree holds smudged bytes matching the staged cleaned OID after clean
        const ctx = await seedFilterStash('stash-filtered.y', 'hello stash\n');

        // Act — projectWorkingTree must recognise the smudged file as unchanged
        const result = await stashPush(ctx);

        // Assert — no local changes detected (smudged == cleaned OID after filter)
        expect(result.kind).toBe('no-local-changes');
      });
    });
  });

  describe('Given a smudged-unmodified file under an active filter=myf but ctx.command is absent', () => {
    describe('When stashPush is called (no runner)', () => {
      it('Then the stash detects local changes (raw bytes differ from cleaned OID — regression guard)', async () => {
        // Arrange — build context WITHOUT command so raw-bytes path is taken
        const ctx = await seedFilterStash('norun-stash.y', 'hello norun\n');
        const { command: _cmd, ...ctxWithoutCommand } = ctx;
        const noRunnerCtx: Context = ctxWithoutCommand;

        // Act — raw bytes differ from cleaned OID => projectWorkingTree sees dirty
        const result = await stashPush(noRunnerCtx);

        // Assert — spuriously detected as modified (regression: raw path in use)
        expect(result.kind).toBe('saved');
      });
    });
  });
});

const configure = (ctx: Context, text: string) =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, text);

const setupLfRepo = async (config: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await commitFile(ctx, 'a.txt', 'a\nb\nc\n', 'initial commit');
  await configure(ctx, config);
  return ctx;
};

describe('stash apply line endings', () => {
  describe('Given core.autocrlf true and a stashed untracked file', () => {
    describe('When stash apply restores it', () => {
      it('Then the restored file is CRLF in the worktree', async () => {
        // Arrange
        const ctx = await setupLfRepo('[core]\n\tautocrlf = true\n');
        await write(ctx, 'u.txt', 'a\r\nb\r\n');
        await stashPush(ctx, { includeUntracked: true });
        const sut = stashApply;

        // Act
        await sut(ctx, {});

        // Assert
        expect(await read(ctx, 'u.txt')).toBe('a\r\nb\r\n');
      });
    });
  });
});

describe('stash push line endings', () => {
  describe('Given core.autocrlf true and a CRLF edit of an LF-tracked file', () => {
    describe('When stash push runs', () => {
      it('Then the W-tree blob is LF', async () => {
        // Arrange
        const ctx = await setupLfRepo('[core]\n\tautocrlf = true\n');
        await write(ctx, 'a.txt', 'a\r\nb\r\nc\r\nd\r\n');
        const sut = stashPush;

        // Act
        const result = await sut(ctx, {});

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        const wTree = (await commitOf(ctx, result.stash)).tree;
        expect(await treeContent(ctx, wTree, 'a.txt')).toBe('a\nb\nc\nd\n');
      });
    });
  });

  describe('Given core.autocrlf true and an LF edit', () => {
    describe('When stash push runs', () => {
      it('Then the saved result carries the lf-to-crlf notice', async () => {
        // Arrange
        const ctx = await setupLfRepo('[core]\n\tautocrlf = true\n');
        await write(ctx, 'a.txt', 'a\nb\nc\nd\n');
        const sut = stashPush;

        // Act
        const result = await sut(ctx, {});

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        expect(result.eolNotices).toEqual([
          { path: 'a.txt', loss: 'lf-to-crlf', crlf: 0, loneLf: 4 },
        ]);
      });
    });
  });

  describe('Given core.autocrlf true, a CRLF edit of a.txt and an untouched LF b.txt', () => {
    describe('When stash push runs', () => {
      it('Then no notice is raised for the untouched b.txt', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a\nb\nc\n', 'first');
        await commitFile(ctx, 'b.txt', 'x\n', 'second');
        await configure(ctx, '[core]\n\tautocrlf = true\n');
        await write(ctx, 'a.txt', 'a\r\nb\r\nc\r\nd\r\n');
        const sut = stashPush;

        // Act
        const result = await sut(ctx, {});

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        expect(result.eolNotices).toEqual([]);
      });
    });
  });

  describe('Given core.autocrlf true and core.safecrlf false', () => {
    describe('When stash push runs on an LF edit', () => {
      it('Then eolNotices is empty', async () => {
        // Arrange
        const ctx = await setupLfRepo('[core]\n\tautocrlf = true\n\tsafecrlf = false\n');
        await write(ctx, 'a.txt', 'a\nb\nc\nd\n');
        const sut = stashPush;

        // Act
        const result = await sut(ctx, {});

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        expect(result.eolNotices).toEqual([]);
      });
    });
  });

  describe('Given core.autocrlf true and core.safecrlf true', () => {
    describe('When stash push runs on an LF edit', () => {
      it('Then it refuses, saves no stash and leaves the worktree and index untouched', async () => {
        // Arrange
        const ctx = await setupLfRepo('[core]\n\tautocrlf = true\n\tsafecrlf = true\n');
        await write(ctx, 'a.txt', 'a\nb\nc\nd\n');
        const indexBefore = await readIndex(ctx);
        const sut = stashPush;

        // Act
        const attempt = sut(ctx, {});

        // Assert
        const error = await attempt.then(
          () => undefined,
          (e: unknown) => e,
        );
        if (!(error instanceof TsgitError)) throw new Error('expected a TsgitError');
        expect(error.data).toEqual({
          code: 'EOL_ROUND_TRIP_UNSAFE',
          path: 'a.txt',
          loss: 'lf-to-crlf',
          crlf: 0,
          loneLf: 4,
        });
        expect(await readStashStack(ctx)).toEqual([]);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/stash`)).toBe(false);
        expect(await read(ctx, 'a.txt')).toBe('a\nb\nc\nd\n');
        expect(await readIndex(ctx)).toEqual(indexBefore);
      });
    });
  });

  describe('Given core.autocrlf true, an LF untracked file and an LF tracked edit', () => {
    describe('When stash push -u runs', () => {
      it('Then the untracked notice precedes the tracked one', async () => {
        // Arrange
        const ctx = await setupLfRepo('[core]\n\tautocrlf = true\n');
        await write(ctx, 'a.txt', 'a\nb\nc\nd\n');
        await write(ctx, 'zz.txt', 'u\n');
        const sut = stashPush;

        // Act
        const result = await sut(ctx, { includeUntracked: true });

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        expect(result.eolNotices.map((n) => n.path)).toEqual(['zz.txt', 'a.txt']);
      });
    });
  });

  describe('Given core.autocrlf true and a CRLF untracked file', () => {
    describe('When stash push -u runs', () => {
      it('Then the untracked blob is LF and no notice is raised', async () => {
        // Arrange
        const ctx = await setupLfRepo('[core]\n\tautocrlf = true\n');
        await write(ctx, 'a.txt', 'a\nb\nc\nd\n');
        await write(ctx, 'u.txt', 'u1\r\nu2\r\n');
        const sut = stashPush;

        // Act
        const result = await sut(ctx, { includeUntracked: true });

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        const w = await commitOf(ctx, result.stash);
        const uTree = (await commitOf(ctx, w.parents[2] as ObjectId)).tree;
        expect(await treeContent(ctx, uTree, 'u.txt')).toBe('u1\nu2\n');
        expect(result.eolNotices.map((n) => n.path)).toEqual(['a.txt']);
      });
    });
  });
});

const OBJECT_FAN_OUT = /^[0-9a-f]{2}$/;

const looseObjectIds = async (ctx: Context): Promise<ReadonlyArray<ObjectId>> => {
  const objects = `${ctx.layout.gitDir}/objects`;
  const fanOuts = (await ctx.fs.readdir(objects)).filter((e) => OBJECT_FAN_OUT.test(e.name));
  const perFanOut = await Promise.all(
    fanOuts.map(async ({ name }) =>
      (await ctx.fs.readdir(`${objects}/${name}`)).map((e) => `${name}${e.name}` as ObjectId),
    ),
  );
  return perFanOut.flat();
};

interface WrittenCommit {
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly message: string;
}

/** The commits written after `before`, as the parts git's stash pushes leave behind. */
const commitsWrittenSince = async (
  ctx: Context,
  before: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<WrittenCommit>> => {
  const fresh = (await looseObjectIds(ctx)).filter((id) => !before.includes(id));
  const objects = await Promise.all(fresh.map((id) => readObject(ctx, id)));
  return objects.flatMap((o) =>
    o.type === 'commit'
      ? [{ tree: o.data.tree, parents: o.data.parents, message: o.data.message }]
      : [],
  );
};

const attemptStashPush = (ctx: Context, input: Parameters<typeof stashPush>[1]) =>
  stashPush(ctx, input).then(
    () => undefined,
    (e: unknown) => e,
  );

describe('stash push object-write order', () => {
  const SAFE_CRLF = '[core]\n\tautocrlf = true\n\tsafecrlf = true\n';

  describe('Given core.safecrlf true and a lossy tracked edit', () => {
    describe('When stash push refuses', () => {
      it('Then exactly one commit was written and it is the index commit', async () => {
        // Arrange
        const ctx = await setupLfRepo(SAFE_CRLF);
        const head = await headId(ctx);
        const headTree = (await commitOf(ctx, head)).tree;
        await write(ctx, 'a.txt', 'a\nb\nc\nd\n');
        const before = await looseObjectIds(ctx);
        const sut = attemptStashPush;

        // Act
        const error = await sut(ctx, {});

        // Assert
        expect(error).toBeInstanceOf(TsgitError);
        const written = await commitsWrittenSince(ctx, before);
        expect(written).toHaveLength(1);
        expect(written[0]?.tree).toBe(headTree);
        expect(written[0]?.parents).toEqual([head]);
        expect(written[0]?.message).toMatch(/^index on main: [0-9a-f]+ initial commit/);
      });
    });
  });

  describe('Given core.safecrlf true, a lossy tracked edit and an untracked file', () => {
    describe('When stash push -u refuses on the tracked file', () => {
      it('Then the index commit and the untracked commit were written', async () => {
        // Arrange
        const ctx = await setupLfRepo(SAFE_CRLF);
        const head = await headId(ctx);
        await write(ctx, 'a.txt', 'a\nb\nc\nd\n');
        await write(ctx, 'u.txt', 'u\r\n');
        const before = await looseObjectIds(ctx);
        const sut = attemptStashPush;

        // Act
        const error = await sut(ctx, { includeUntracked: true });

        // Assert
        expect(error).toBeInstanceOf(TsgitError);
        const written = await commitsWrittenSince(ctx, before);
        expect(written.map((c) => c.parents)).toEqual(expect.arrayContaining([[head], []]));
        expect(written).toHaveLength(2);
        const untrackedCommit = written.find((c) => c.parents.length === 0);
        expect(await treeContent(ctx, untrackedCommit?.tree as ObjectId, 'u.txt')).toBe('u\n');
      });
    });
  });

  describe('Given core.safecrlf true and a lossy untracked file with a clean tracked tree', () => {
    describe('When stash push -u refuses on the untracked file', () => {
      it('Then only the index commit was written', async () => {
        // Arrange
        const ctx = await setupLfRepo(SAFE_CRLF);
        const head = await headId(ctx);
        await write(ctx, 'u.txt', 'u\n');
        const before = await looseObjectIds(ctx);
        const sut = attemptStashPush;

        // Act
        const error = await sut(ctx, { includeUntracked: true });

        // Assert
        expect(error).toBeInstanceOf(TsgitError);
        const written = await commitsWrittenSince(ctx, before);
        expect(written).toHaveLength(1);
        expect(written[0]?.parents).toEqual([head]);
      });
    });
  });

  describe('Given a clean tree', () => {
    describe('When stash push finds no local changes', () => {
      it('Then no object was written', async () => {
        // Arrange
        const ctx = await setupRepo();
        const before = await looseObjectIds(ctx);
        const sut = attemptStashPush;

        // Act
        await sut(ctx, { includeUntracked: true });

        // Assert
        expect(await looseObjectIds(ctx)).toEqual(before);
      });
    });
  });
});

describe('stash push filter validation', () => {
  describe('Given [filter "u"] required = foo, no attributes and no tracked file to hash', () => {
    describe('When stash push -u hashes an untracked file', () => {
      it('Then it refuses after the index commit and writes no stash', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await commit(ctx, { message: 'empty', author, allowEmpty: true });
        await configure(ctx, '[filter "u"]\n\trequired = foo\n');
        await write(ctx, 'n.txt', 'n\n');
        const head = await headId(ctx);
        const before = await looseObjectIds(ctx);
        const sut = attemptStashPush;

        // Act
        const error = await sut(ctx, { includeUntracked: true });

        // Assert
        if (!(error instanceof TsgitError)) throw new Error('expected a TsgitError');
        expect(error.data).toMatchObject({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'filter.u.required',
          value: 'foo',
        });
        const written = await commitsWrittenSince(ctx, before);
        expect(written.map((c) => c.parents)).toEqual([[head]]);
        expect(await readStashStack(ctx)).toEqual([]);
      });
    });
  });
});

describe('stash push line-ending guards', () => {
  describe('Given a tracked file the work tree reports above the size cap', () => {
    describe('When stash push runs', () => {
      it('Then it refuses WORKING_TREE_FILE_TOO_LARGE before any conversion runs', async () => {
        // Arrange
        const ctx = await setupLfRepo('[core]\n\tautocrlf = true\n');
        await write(ctx, 'a.txt', 'a\nb\nc\nd\n');
        const oversize = MAX_WORKING_TREE_BLOB_BYTES + 1;
        const hostileFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop !== 'lstat') return Reflect.get(target, prop, receiver);
            return async (path: string) => {
              const real = await target.lstat(path);
              return path.endsWith('/a.txt') ? { ...real, size: oversize } : real;
            };
          },
        });
        const convert = vi.spyOn(convertBlobMod, 'convertToGit');
        const sut = stashPush;
        let caught: unknown;

        // Act
        try {
          await sut({ ...ctx, fs: hostileFs }, {});
        } catch (error) {
          caught = error;
        }

        // Assert
        if (!(caught instanceof TsgitError)) throw new Error('expected a TsgitError');
        expect(caught.data).toEqual({
          code: 'WORKING_TREE_FILE_TOO_LARGE',
          path: 'a.txt',
          size: oversize,
          limit: MAX_WORKING_TREE_BLOB_BYTES,
        });
        const writeRouteCalls = convert.mock.calls.filter(
          ([, request]) => request.route === 'write',
        );
        expect(writeRouteCalls).toEqual([]);
        convert.mockRestore();
      });
    });
  });

  describe('Given a tracked file the work tree reports exactly at the size cap', () => {
    describe('When stash push runs', () => {
      it('Then it saves the stash, the cap refusing only strictly larger files', async () => {
        // Arrange
        const ctx = await setupLfRepo('[core]\n\tautocrlf = true\n');
        await write(ctx, 'a.txt', 'a\nb\nc\nd\n');
        const cappedFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop !== 'lstat') return Reflect.get(target, prop, receiver);
            return async (path: string) => {
              const real = await target.lstat(path);
              return path.endsWith('/a.txt')
                ? { ...real, size: MAX_WORKING_TREE_BLOB_BYTES }
                : real;
            };
          },
        });
        const sut = stashPush;

        // Act
        const result = await sut({ ...ctx, fs: cappedFs }, {});

        // Assert
        expect(result.kind).toBe('saved');
      });
    });
  });

  describe('Given a CRLF blob in the index, text=auto and a CRLF edit', () => {
    describe('When stash push runs', () => {
      it('Then the W-tree blob keeps CRLF', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await commitFile(ctx, 'a.txt', 'a\r\nb\r\n', 'initial commit');
        await write(ctx, '.gitattributes', '* text=auto\n');
        await write(ctx, 'a.txt', 'a\r\nb\r\nc\r\n');
        const sut = stashPush;

        // Act
        const result = await sut(ctx, {});

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        const wTree = (await commitOf(ctx, result.stash)).tree;
        expect(await treeContent(ctx, wTree, 'a.txt')).toBe('a\r\nb\r\nc\r\n');
      });
    });
  });
});

describe('stash push beyond a symbolic link', () => {
  describe('Given a tracked path whose leading directory became a symlink to a copy', () => {
    const arrange = async (): Promise<Context> => {
      const ctx = await setupRepo();
      await commitFile(ctx, 'd/f', 'x\n', 'add d/f');
      await write(ctx, 'copy/f', 'x\n');
      await ctx.fs.rm(`${ctx.layout.workDir}/d/f`);
      await ctx.fs.rmRecursive(`${ctx.layout.workDir}/d`);
      await ctx.fs.symlink('copy', `${ctx.layout.workDir}/d`);
      return ctx;
    };

    const refusalOf = async (ctx: Context): Promise<unknown> => {
      try {
        await stashPush(ctx, {});
      } catch (error) {
        return error instanceof TsgitError ? error.data : error;
      }
      return undefined;
    };

    describe('When push runs', () => {
      it('Then it refuses with the path beyond the symbolic link', async () => {
        // Arrange
        const ctx = await arrange();

        // Act
        const data = await refusalOf(ctx);

        // Assert
        expect(data).toEqual({ code: 'PATHSPEC_BEYOND_SYMLINK', path: 'd/f' });
      });

      it('Then it writes no stash ref and leaves the index bytes unchanged', async () => {
        // Arrange
        const ctx = await arrange();
        const indexPath = `${ctx.layout.gitDir}/index`;
        const before = await ctx.fs.read(indexPath);

        // Act
        await refusalOf(ctx);

        // Assert
        expect(await readStashStack(ctx)).toEqual([]);
        expect(await ctx.fs.read(indexPath)).toEqual(before);
      });
    });

    describe('When push runs and another file is edited', () => {
      it('Then it refuses the same way', async () => {
        // Arrange
        const ctx = await arrange();
        await write(ctx, 'a.txt', 'edited\n');

        // Act
        const data = await refusalOf(ctx);

        // Assert
        expect(data).toEqual({ code: 'PATHSPEC_BEYOND_SYMLINK', path: 'd/f' });
      });
    });
  });

  describe('Given a path beyond a symlink followed by a later edited file', () => {
    describe('When push runs', () => {
      it('Then the later file is never hashed into the object store', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'd/f', 'x\n', 'add d/f');
        await commitFile(ctx, 'z', 'v1\n', 'add z');
        await write(ctx, 'copy/f', 'x\n');
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/d`);
        await ctx.fs.symlink('copy', `${ctx.layout.workDir}/d`);
        await write(ctx, 'z', 'never hashed\n');
        const laterBlob = await hashBlob(ctx, new TextEncoder().encode('never hashed\n'), {
          write: false,
        });
        const sut = stashPush;

        // Act
        const outcome = await sut(ctx, {}).catch((error: unknown) => error);

        // Assert
        expect(outcome instanceof TsgitError && outcome.data).toEqual({
          code: 'PATHSPEC_BEYOND_SYMLINK',
          path: 'd/f',
        });
        await expect(readObject(ctx, laterBlob)).rejects.toMatchObject({
          data: { code: 'OBJECT_NOT_FOUND' },
        });
      });
    });
  });

  describe('Given a tracked symlink that is a leaf, not a leading directory', () => {
    describe('When push runs after the link was retargeted', () => {
      it('Then it stashes normally', async () => {
        // Arrange
        const ctx = await setupRepo();
        await ctx.fs.symlink('old-target', `${ctx.layout.workDir}/link`);
        await add(ctx, ['link']);
        await commit(ctx, { message: 'add link', author });
        await ctx.fs.rm(`${ctx.layout.workDir}/link`);
        await ctx.fs.symlink('new-target', `${ctx.layout.workDir}/link`);

        // Act
        const result = await stashPush(ctx, {});

        // Assert
        expect(result.kind).toBe('saved');
      });
    });
  });
});

describe('stashPush — the work-tree tree follows git’s path set', () => {
  const savedWorkTree = async (ctx: Context) => {
    const result = await stashPush(ctx, {});
    if (result.kind !== 'saved') throw new Error('expected saved');
    return flattenTree(ctx, (await commitOf(ctx, result.stash)).tree);
  };

  const refusalOf = async (ctx: Context): Promise<unknown> => {
    try {
      await stashPush(ctx, {});
    } catch (error) {
      return error instanceof TsgitError ? error.data : error;
    }
    return undefined;
  };

  const idOfIndexed = async (ctx: Context, path: string): Promise<ObjectId | undefined> =>
    (await readIndex(ctx)).entries.find((entry) => entry.path === path)?.id;

  describe('Given a directory standing at a tracked path', () => {
    describe('When push runs', () => {
      it('Then the work-tree tree keeps the index entry', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'f', 'v1\n', 'add f');
        await ctx.fs.rm(`${ctx.layout.workDir}/f`);
        await write(ctx, 'f/u', 'untracked\n');
        await write(ctx, 'a.txt', 'edited\n');
        const indexed = await idOfIndexed(ctx, 'f');

        // Act
        const sut = savedWorkTree;
        const result = await sut(ctx);

        // Assert
        expect(result.entries.get('f' as FilePath)?.id).toBe(indexed);
      });
    });
  });

  describe('Given a directory standing at a tracked path and nothing else changed', () => {
    describe('When push runs', () => {
      it('Then the directory counts as a local change and the file is restored', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'f', 'v1\n', 'add f');
        await ctx.fs.rm(`${ctx.layout.workDir}/f`);
        await write(ctx, 'f/u', 'untracked\n');

        // Act
        const result = await stashPush(ctx, {});

        // Assert
        expect(result.kind).toBe('saved');
        expect(await read(ctx, 'f')).toBe('v1\n');
      });
    });
  });

  describe('Given a staged new file deleted from the work tree', () => {
    describe('When push runs', () => {
      it('Then the work-tree tree keeps the index entry', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'n', 'new\n');
        await add(ctx, ['n']);
        await ctx.fs.rm(`${ctx.layout.workDir}/n`);
        const indexed = await idOfIndexed(ctx, 'n');

        // Act
        const sut = savedWorkTree;
        const result = await sut(ctx);

        // Assert
        expect(result.entries.get('n' as FilePath)?.id).toBe(indexed);
      });
    });
  });

  describe('Given a staged new file beneath a directory replaced by a symbolic link', () => {
    describe('When push runs', () => {
      it('Then the work-tree tree keeps the index entry and nothing is refused', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'd/x', 'new\n');
        await add(ctx, ['d/x']);
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/d`);
        await ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/d`);
        const indexed = await idOfIndexed(ctx, 'd/x');

        // Act
        const sut = savedWorkTree;
        const result = await sut(ctx);

        // Assert
        expect(result.entries.get('d/x' as FilePath)?.id).toBe(indexed);
      });
    });
  });

  describe('Given a committed file removed from the index and still on disk', () => {
    describe('When push runs', () => {
      it('Then the work-tree tree records the file with its on-disk content', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'f', 'v1\n', 'add f');
        await unstagePath(ctx, 'f');
        await write(ctx, 'f', 'on disk\n');

        // Act
        const sut = savedWorkTree;
        const result = await sut(ctx);

        // Assert
        const blob = await readObject(ctx, result.entries.get('f' as FilePath)?.id as ObjectId);
        expect(blob.type === 'blob' && new TextDecoder().decode(blob.content)).toBe('on disk\n');
      });
    });
  });

  describe('Given a CRLF file removed from the index and still on disk under core.autocrlf true', () => {
    describe('When push runs', () => {
      it('Then the work-tree blob is LF, as no index blob exists to keep its CRLF', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'f', 'a\r\nb\r\n', 'add crlf f');
        await unstagePath(ctx, 'f');
        await configure(ctx, '[core]\n\tautocrlf = true\n');

        // Act
        const sut = savedWorkTree;
        const result = await sut(ctx);

        // Assert
        const blob = await readObject(ctx, result.entries.get('f' as FilePath)?.id as ObjectId);
        expect(blob.type === 'blob' && new TextDecoder().decode(blob.content)).toBe('a\nb\n');
      });
    });
  });

  describe('Given a gitlink with no checkout and a tracked file edited', () => {
    describe('When push runs', () => {
      it('Then the work-tree tree keeps the gitlink at its index id', async () => {
        // Arrange
        const ctx = await setupRepoWithSubmodule(GITLINK_A);
        await ctx.fs.rm(`${ctx.layout.workDir}/sub/.git`);
        await ctx.fs.rm(`${ctx.layout.workDir}/sub`);
        await write(ctx, 'a.txt', 'edited\n');

        // Act
        const sut = savedWorkTree;
        const result = await sut(ctx);

        // Assert
        expect(result.entries.get('sub' as FilePath)).toMatchObject({
          id: GITLINK_A,
          mode: FILE_MODE.GITLINK,
        });
      });
    });
  });

  describe('Given a committed symbolic link removed from the index and still on disk', () => {
    describe('When push runs', () => {
      it('Then the work-tree tree records it with the link mode', async () => {
        // Arrange
        const ctx = await setupRepo();
        await ctx.fs.symlink('target', `${ctx.layout.workDir}/l`);
        await add(ctx, ['l']);
        await commit(ctx, { message: 'add link', author });
        await unstagePath(ctx, 'l');

        // Act
        const sut = savedWorkTree;
        const result = await sut(ctx);

        // Assert
        expect(result.entries.get('l' as FilePath)?.mode).toBe(FILE_MODE.SYMLINK);
      });
    });
  });

  describe('Given a committed file removed from the index and replaced on disk by a directory', () => {
    describe('When push runs', () => {
      it('Then the work-tree tree does not record the path', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'f', 'v1\n', 'add f');
        await unstagePath(ctx, 'f');
        await ctx.fs.rm(`${ctx.layout.workDir}/f`);
        await write(ctx, 'f/u', 'untracked\n');

        // Act
        const sut = savedWorkTree;
        const result = await sut(ctx);

        // Assert
        expect(result.entries.has('f' as FilePath)).toBe(false);
      });
    });
  });

  describe('Given a committed file removed from the index and absent on disk', () => {
    describe('When push runs', () => {
      it('Then the work-tree tree does not record the path', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'f', 'v1\n', 'add f');
        await unstagePath(ctx, 'f');
        await ctx.fs.rm(`${ctx.layout.workDir}/f`);

        // Act
        const sut = savedWorkTree;
        const result = await sut(ctx);

        // Assert
        expect(result.entries.has('f' as FilePath)).toBe(false);
      });
    });
  });

  describe('Given a committed file removed from the index beneath a directory replaced by a symbolic link', () => {
    describe('When push runs', () => {
      it('Then it refuses with the path beyond the symbolic link', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'd/x', 'v1\n', 'add d/x');
        await unstagePath(ctx, 'd/x');
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/d`);
        await ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/d`);

        // Act
        const data = await refusalOf(ctx);

        // Assert
        expect(data).toEqual({ code: 'PATHSPEC_BEYOND_SYMLINK', path: 'd/x' });
      });
    });
  });

  describe('Given a committed file removed from the index beneath a regular file', () => {
    describe('When push runs', () => {
      it('Then the work-tree tree does not record the path', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'd/x', 'v1\n', 'add d/x');
        await unstagePath(ctx, 'd/x');
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/d`);
        await write(ctx, 'd', 'occupant\n');

        // Act
        const sut = savedWorkTree;
        const result = await sut(ctx);

        // Assert
        expect(result.entries.has('d/x' as FilePath)).toBe(false);
      });
    });
  });
});

describe('snapshotLocalChanges', () => {
  const workDirOf = (ctx: Context): string => `${ctx.layout.workDir}`;
  const committer: AuthorIdentity = {
    name: 'Bob',
    email: 'bob@example.com',
    timestamp: 1_700_000_100,
    timezoneOffset: '+0000',
  };

  describe('Given a modified tracked file', () => {
    describe('When the snapshot is taken with a distinct author and committer', () => {
      it('Then the WIP commit carries both identities and the index commit too', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'edited\n');

        // Act
        const result = await snapshotLocalChanges(ctx, workDirOf(ctx), { author, committer });

        // Assert
        const wip = await commitOf(ctx, result as ObjectId);
        const index = await commitOf(ctx, wip.parents[1] as ObjectId);
        expect([wip.author, wip.committer]).toEqual([author, committer]);
        expect([index.author, index.committer]).toEqual([author, committer]);
        expect(wip.parents[0]).toBe(await headId(ctx));
        expect(index.parents).toEqual([await headId(ctx)]);
      });

      it('Then it writes no stash ref, resets nothing and the tree stays edited', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'edited\n');

        // Act
        await snapshotLocalChanges(ctx, workDirOf(ctx), { author, committer });

        // Assert
        expect(await readStashStack(ctx)).toEqual([]);
        expect(await read(ctx, 'a.txt')).toBe('edited\n');
      });
    });
  });

  describe('Given a clean tree', () => {
    describe('When the snapshot is taken', () => {
      it('Then it returns undefined and writes no object', async () => {
        // Arrange
        const ctx = await setupRepo();
        const before = await looseObjectIds(ctx);

        // Act
        const result = await snapshotLocalChanges(ctx, workDirOf(ctx), { author, committer });

        // Assert
        expect(result).toBeUndefined();
        expect(await looseObjectIds(ctx)).toEqual(before);
      });
    });
  });
});

describe('restoreSnapshot', () => {
  const committer: AuthorIdentity = {
    name: 'Bob',
    email: 'bob@example.com',
    timestamp: 1_700_000_100,
    timezoneOffset: '+0000',
  };

  const blobIdOf = async (ctx: Context, content: string): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(content),
      id: '' as ObjectId,
    });

  const stagedIdOf = async (ctx: Context, path: string): Promise<ObjectId | undefined> =>
    (await readIndex(ctx)).entries.find((entry) => entry.path === path)?.id;

  const snapshotThenReset = async (ctx: Context): Promise<ObjectId> => {
    const workDir = `${ctx.layout.workDir}`;
    const snapshot = (await snapshotLocalChanges(ctx, workDir, { author, committer })) as ObjectId;
    await hardResetWorktreeToCommit(ctx, await headId(ctx));
    return snapshot;
  };

  describe('Given a snapshot of a staged change and of a staged change edited again', () => {
    describe('When the tree was reset to HEAD and the snapshot is restored', () => {
      it('Then the work tree and the index hold the changes the snapshot recorded', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'b.txt', 'b-committed\n', 'add b');
        await write(ctx, 'a.txt', 'a-staged\n');
        await add(ctx, ['a.txt']);
        await write(ctx, 'b.txt', 'b-staged\n');
        await add(ctx, ['b.txt']);
        await write(ctx, 'b.txt', 'b-edited\n');
        const snapshot = await snapshotThenReset(ctx);
        expect(await read(ctx, 'b.txt')).toBe('b-committed\n');

        // Act
        await restoreSnapshot(ctx, `${ctx.layout.workDir}`, snapshot);

        // Assert
        expect(await read(ctx, 'a.txt')).toBe('a-staged\n');
        expect(await read(ctx, 'b.txt')).toBe('b-edited\n');
        expect(await stagedIdOf(ctx, 'a.txt')).toBe(await blobIdOf(ctx, 'a-staged\n'));
        expect(await stagedIdOf(ctx, 'b.txt')).toBe(await blobIdOf(ctx, 'b-staged\n'));
      });
    });
  });

  describe('Given a snapshot of an unstaged edit', () => {
    describe('When the snapshot is restored over the reset tree', () => {
      it('Then the edit is back, unstaged, and no object was written', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'edited\n');
        const snapshot = await snapshotThenReset(ctx);
        const before = await looseObjectIds(ctx);

        // Act
        await restoreSnapshot(ctx, `${ctx.layout.workDir}`, snapshot);

        // Assert
        expect(await read(ctx, 'a.txt')).toBe('edited\n');
        expect(await stagedIdOf(ctx, 'a.txt')).toBe(await blobIdOf(ctx, 'committed\n'));
        expect(await looseObjectIds(ctx)).toEqual(before);
      });
    });
  });
});

describe('stash push beyond a symbolic link, object order', () => {
  describe('Given a tracked path whose leading directory became a dangling symlink', () => {
    describe('When push refuses', () => {
      it('Then exactly the index commit was written first', async () => {
        // Arrange
        const ctx = await setupRepo();
        await commitFile(ctx, 'd/x', 'v1\n', 'add d/x');
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/d`);
        await ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/d`);
        const before = await looseObjectIds(ctx);

        // Act
        const refusal = await attemptStashPush(ctx, {});

        // Assert
        const written = await commitsWrittenSince(ctx, before);
        expect((refusal as TsgitError).data).toEqual({
          code: 'PATHSPEC_BEYOND_SYMLINK',
          path: 'd/x',
        });
        expect(written.map((c) => c.message)).toEqual([expect.stringMatching(/^index on main: /)]);
      });
    });
  });
});

describe('stash push ref tail', () => {
  describe('Given HEAD on main and an edited file', () => {
    describe('When stash push saves', () => {
      it('Then HEAD reflog gains a reset entry with old = new = HEAD and main reflog is unchanged', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'edited\n');
        const head = await headId(ctx);
        const headBefore = await readReflog(ctx, 'HEAD' as RefName);
        const mainBefore = await readReflog(ctx, 'refs/heads/main' as RefName);
        const sut = stashPush;

        // Act
        await sut(ctx, {});

        // Assert
        const added = (await readReflog(ctx, 'HEAD' as RefName)).slice(headBefore.length);
        expect(added.map((e) => [e.oldId, e.newId, e.message])).toEqual([
          [head, head, 'reset: moving to HEAD'],
        ]);
        expect(await readReflog(ctx, 'refs/heads/main' as RefName)).toEqual(mainBefore);
      });

      it('Then ORIG_HEAD names HEAD', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'edited\n');
        const head = await headId(ctx);
        const sut = stashPush;

        // Act
        await sut(ctx, {});

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(`${head}\n`);
      });
    });
  });

  describe('Given a detached HEAD and an edited file', () => {
    describe('When stash push saves', () => {
      it('Then ORIG_HEAD names HEAD and HEAD reflog gains no entry', async () => {
        // Arrange
        const ctx = await setupRepo();
        const head = await headId(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${head}\n`);
        await write(ctx, 'a.txt', 'edited\n');
        const headBefore = await readReflog(ctx, 'HEAD' as RefName);
        const sut = stashPush;

        // Act
        await sut(ctx, {});

        // Assert
        expect(await readReflog(ctx, 'HEAD' as RefName)).toEqual(headBefore);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(`${head}\n`);
      });
    });
  });

  describe('Given a clean tree', () => {
    describe('When stash push finds nothing to save', () => {
      it('Then neither ORIG_HEAD nor a HEAD reflog entry is written', async () => {
        // Arrange
        const ctx = await setupRepo();
        const headBefore = await readReflog(ctx, 'HEAD' as RefName);
        const sut = stashPush;

        // Act
        await sut(ctx, {});

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
        expect(await readReflog(ctx, 'HEAD' as RefName)).toEqual(headBefore);
      });
    });
  });

  describe('Given HEAD on main and an edited file', () => {
    describe('When createAutostash saves', () => {
      it('Then neither ORIG_HEAD nor a HEAD reflog entry is written', async () => {
        // Arrange
        const ctx = await setupRepo();
        await write(ctx, 'a.txt', 'edited\n');
        const headBefore = await readReflog(ctx, 'HEAD' as RefName);
        const sut = createAutostash;

        // Act
        await sut(ctx);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
        expect(await readReflog(ctx, 'HEAD' as RefName)).toEqual(headBefore);
      });
    });
  });
});
