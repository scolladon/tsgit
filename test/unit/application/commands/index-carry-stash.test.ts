import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { stashApply, stashPop, stashPush } from '../../../../src/application/commands/stash.js';
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

const signatures = async (ctx: Context): Promise<ReadonlyArray<string>> => [
  ...(await indexExtensionsOf(ctx)).keys(),
];

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
        expect(await signatures(ctx)).toEqual(['TREE', 'UNTR']);
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
        expect(await signatures(ctx)).toEqual(['TREE', 'UNTR']);
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
        expect(await signatures(ctx)).toEqual(['TREE', 'UNTR']);
      });
    });
  });

  describe('Given a stash of a staged change and an index carrying extensions', () => {
    describe('When stash pop reinstates the index', () => {
      it('Then REUC and the unknown extension are dropped and only the staged chain is invalid', async () => {
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
        expect(await signatures(ctx)).toEqual(['TREE', 'UNTR']);
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });
});
