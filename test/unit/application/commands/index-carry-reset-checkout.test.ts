import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { reset } from '../../../../src/application/commands/reset.js';
import { submoduleAdd } from '../../../../src/application/commands/submodule.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import type { TsgitError } from '../../../../src/domain/error.js';
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
import { buildSubmoduleRemote } from './submodule-network-fixture.js';

const SHA1_DIGEST = 20;
const TREE_ID = 'c'.repeat(40) as ObjectId;
const BLOB_ID = 'b'.repeat(40);
const T0 = 1_700_000_000_000;
const SECOND = 1000;
const SUB_URL = 'https://remote.example/sub.git';
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

const commitAll = async (ctx: Context, message: string, paths: string[]): Promise<void> => {
  await add(ctx, paths);
  advance(1);
  await commit(ctx, { message, author: AUTHOR, committer: AUTHOR });
  advance(1);
};

const carryAllExtensions = async (ctx: Context): Promise<void> => {
  await withIndexExtensions(ctx, [
    cacheTreeExtension(fullTree(), SHA1_DIGEST),
    resolveUndoExtension('m', BLOB_ID, SHA1_DIGEST),
    UNTR_EXTENSION,
    UNKNOWN_EXTENSION,
  ]);
  advance(1);
};

/**
 * `main` = c1 (FILES) then c2 (b changed); `other` = c1 then x/y changed and z/w added.
 * Left on `main` at c2 with an index carrying all four extensions.
 */
const carryingRepo = async (): Promise<Context> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const ctx = createMemoryContext();
  await init(ctx);
  for (const [path, content] of Object.entries(FILES)) await write(ctx, path, content);
  await commitAll(ctx, 'c1', Object.keys(FILES));
  await checkout(ctx, { rev: 'HEAD', createBranch: { name: 'other' } });
  advance(1);
  await write(ctx, 'x/y', 'other\n');
  await write(ctx, 'z/w', 'w\n');
  await commitAll(ctx, 'other', ['x/y', 'z/w']);
  await checkout(ctx, { rev: 'main' });
  advance(1);
  await write(ctx, 'b', 'b2\n');
  await commitAll(ctx, 'c2', ['b']);
  await carryAllExtensions(ctx);
  return ctx;
};

/** Directory path ('' for the root) to whether its cache-tree node is still valid. */
const validity = async (ctx: Context): Promise<ReadonlyMap<string, boolean>> => {
  const extensions = await indexExtensionsOf(ctx);
  const tree = parseCacheTree(extensions.get('TREE') as Uint8Array, SHA1_DIGEST);
  const out = new Map<string, boolean>();
  const visit = (entry: CacheTreeEntry, prefix: string): void => {
    out.set(prefix, entry.entryCount >= 0);
    for (const child of entry.children)
      visit(child, prefix === '' ? child.path : `${prefix}/${child.path}`);
  };
  visit(tree, '');
  return out;
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

const treeBytes = async (ctx: Context): Promise<Uint8Array | undefined> =>
  (await indexExtensionsOf(ctx)).get('TREE');

afterEach(() => {
  vi.useRealTimers();
});

describe('reset carries index extensions', () => {
  describe('Given a mixed reset to the same HEAD', () => {
    describe('When reset rebuilds the index', () => {
      it('Then TREE and REUC are unchanged and the unknown extension is gone', async () => {
        // Arrange
        const ctx = await carryingRepo();
        const before = await treeBytes(ctx);

        // Act
        const sut = reset;
        await sut(ctx, { mode: 'mixed', rev: 'HEAD' });

        // Assert
        expect(await treeBytes(ctx)).toEqual(before);
        expect(await carriedSignatures(ctx)).toEqual(['TREE', 'REUC', 'UNTR']);
      });
    });
  });

  describe('Given a mixed reset to the parent commit', () => {
    describe('When reset rebuilds the index', () => {
      it('Then only the root is invalid and REUC is kept', async () => {
        // Arrange
        const ctx = await carryingRepo();

        // Act
        const sut = reset;
        await sut(ctx, { mode: 'mixed', rev: 'HEAD~1' });

        // Assert
        const valid = await validity(ctx);
        expect([valid.get(''), valid.get('d'), valid.get('d/e'), valid.get('x')]).toEqual([
          false,
          true,
          true,
          true,
        ]);
        expect(await carriedSignatures(ctx)).toContain('REUC');
      });
    });
  });

  describe('Given a hard reset to the parent commit', () => {
    describe('When reset rewrites the index', () => {
      it('Then REUC is dropped, TREE and UNTR are kept as the tracked set is unchanged', async () => {
        // Arrange
        const ctx = await carryingRepo();

        // Act
        const sut = reset;
        await sut(ctx, { mode: 'hard', rev: 'HEAD~1' });

        // Assert
        expect(await carriedSignatures(ctx)).toEqual(['TREE', 'UNTR']);
      });
    });
  });
});

describe('checkout carries index extensions', () => {
  describe('Given a branch changing x/y and adding z/w', () => {
    describe('When checkout switches to it', () => {
      it('Then REUC and UNTR are dropped, the repaired TREE is fully valid', async () => {
        // Arrange
        const ctx = await carryingRepo();

        // Act
        const sut = checkout;
        await sut(ctx, { rev: 'other' });

        // Assert
        const valid = await validity(ctx);
        expect([valid.get(''), valid.get('d'), valid.get('x')]).toEqual([true, true, true]);
        expect(await carriedSignatures(ctx)).toEqual(['TREE']);
      });
    });
  });

  describe('Given an edited tracked file', () => {
    describe('When checkout restores it from the index', () => {
      it('Then TREE is unchanged and REUC is kept', async () => {
        // Arrange
        const ctx = await carryingRepo();
        await write(ctx, 'x/y', 'edited\n');
        const before = await treeBytes(ctx);

        // Act
        const sut = checkout;
        await sut(ctx, { paths: ['x/y'] });

        // Assert
        expect(await treeBytes(ctx)).toEqual(before);
        expect(await carriedSignatures(ctx)).toContain('REUC');
      });
    });
  });

  describe('Given an edited tracked file and an index carrying an unknown extension', () => {
    describe('When checkout restores it from the index', () => {
      it('Then the index is rewritten without the unknown extension', async () => {
        // Arrange
        const ctx = await carryingRepo();
        await write(ctx, 'x/y', 'edited\n');

        // Act
        const sut = checkout;
        await sut(ctx, { paths: ['x/y'] });

        // Assert
        expect(await carriedSignatures(ctx)).not.toContain('ZZZZ');
      });

      it('Then the entry stat equals the restored file lstat', async () => {
        // Arrange
        const ctx = await carryingRepo();
        await write(ctx, 'x/y', 'edited\n');
        advance(1);

        // Act
        const sut = checkout;
        await sut(ctx, { paths: ['x/y'] });

        // Assert
        const entry = (await readIndex(ctx)).entries.find((e) => e.path === 'x/y');
        const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/x/y`);
        expect(entry?.mtimeSeconds).toBe(Math.floor(stat.mtimeMs / SECOND));
      });
    });
  });

  describe('Given an index lock held by another process', () => {
    describe('When checkout restores a path from the index', () => {
      it('Then it refuses with RESOURCE_LOCKED on the index lock path', async () => {
        // Arrange
        const ctx = await carryingRepo();
        const lockPath = `${ctx.layout.gitDir}/index.lock`;
        await ctx.fs.write(lockPath, new Uint8Array());

        // Act
        const sut = checkout;
        const failure = await sut(ctx, { paths: ['x/y'] }).then(
          () => undefined,
          (err: unknown) => err as TsgitError,
        );

        // Assert
        expect(failure?.data.code).toBe('RESOURCE_LOCKED');
        expect(failure?.data).toMatchObject({ resource: 'index', path: lockPath });
      });
    });
  });

  describe('Given a branch changing x/y', () => {
    describe('When checkout restores x/y from it', () => {
      it('Then root and x are invalid and REUC is kept', async () => {
        // Arrange
        const ctx = await carryingRepo();

        // Act
        const sut = checkout;
        await sut(ctx, { paths: ['x/y'], source: 'other' });

        // Assert
        const valid = await validity(ctx);
        expect([valid.get(''), valid.get('d'), valid.get('x')]).toEqual([false, true, false]);
        expect(await carriedSignatures(ctx)).toContain('REUC');
      });
    });
  });
});

describe('submodule add carries index extensions', () => {
  describe('Given a superproject whose index carries extensions', () => {
    describe('When submodule add stages the gitlink', () => {
      it('Then REUC is kept and UNTR is dropped', async () => {
        // Arrange
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        const base = createMemoryContext();
        await init(base);
        await write(base, 'README', 'root\n');
        await commitAll(base, 'init', ['README']);
        const remote = await buildSubmoduleRemote(base, {
          branches: [{ name: 'main', file: 'lib.txt', content: 'lib v1\n' }],
          head: 'main',
        });
        const ctx: Context = { ...base, transport: remote.transport };
        await carryAllExtensions(ctx);

        // Act
        const sut = submoduleAdd;
        await sut(ctx, { url: SUB_URL, path: 'libs/sub' });

        // Assert
        expect(await carriedSignatures(ctx)).toEqual(['TREE', 'REUC']);
      });
    });
  });
});
