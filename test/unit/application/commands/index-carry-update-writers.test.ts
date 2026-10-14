import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { init } from '../../../../src/application/commands/init.js';
import { mv } from '../../../../src/application/commands/mv.js';
import { rm } from '../../../../src/application/commands/rm.js';
import { sparseCheckoutSet } from '../../../../src/application/commands/sparse-checkout.js';
import type { CacheTreeEntry } from '../../../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../src/domain/git-index/index-parser.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
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

/** A staged repo whose index carries all four extensions and is older than every file. */
const carryingRepo = async (config = ''): Promise<Context> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const ctx = createMemoryContext();
  await init(ctx);
  if (config !== '') await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  for (const [path, content] of Object.entries(FILES)) await write(ctx, path, content);
  await add(ctx, Object.keys(FILES));
  advance(1);
  await withIndexExtensions(ctx, [
    cacheTreeExtension(fullTree(), SHA1_DIGEST),
    resolveUndoExtension('m', BLOB_ID, SHA1_DIGEST),
    UNTR_EXTENSION,
    UNKNOWN_EXTENSION,
  ]);
  advance(1);
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

const signatures = async (ctx: Context): Promise<ReadonlyArray<string>> => [
  ...(await indexExtensionsOf(ctx)).keys(),
];

const treeBytes = async (ctx: Context): Promise<Uint8Array | undefined> =>
  (await indexExtensionsOf(ctx)).get('TREE');

afterEach(() => {
  vi.useRealTimers();
});

describe('add carries index extensions', () => {
  describe('Given a modified tracked file', () => {
    describe('When add stages it', () => {
      it('Then its directory chain is invalid, siblings valid, REUC and UNTR kept, unknown dropped', async () => {
        // Arrange
        const ctx = await carryingRepo();
        await write(ctx, 'd/c', 'changed\n');

        // Act
        const sut = add;
        await sut(ctx, ['d/c']);

        // Assert
        const valid = await validity(ctx);
        expect([valid.get(''), valid.get('d'), valid.get('d/e'), valid.get('x')]).toEqual([
          false,
          false,
          true,
          true,
        ]);
        expect(await signatures(ctx)).toEqual(['TREE', 'REUC', 'UNTR']);
      });
    });
  });

  describe('Given a new file under a nested directory', () => {
    describe('When add stages it', () => {
      it('Then the chain is invalid and UNTR is dropped', async () => {
        // Arrange
        const ctx = await carryingRepo();
        await write(ctx, 'd/e/n', 'n\n');

        // Act
        const sut = add;
        await sut(ctx, ['d/e/n']);

        // Assert
        const valid = await validity(ctx);
        expect([valid.get(''), valid.get('d'), valid.get('d/e'), valid.get('x')]).toEqual([
          false,
          false,
          false,
          true,
        ]);
        expect(await signatures(ctx)).toEqual(['TREE', 'REUC']);
      });
    });
  });

  describe('Given an untracked file', () => {
    describe('When add stages everything', () => {
      it('Then the chain is invalid and UNTR is dropped', async () => {
        // Arrange
        const ctx = await carryingRepo();
        await write(ctx, 'd/untracked', 'u\n');

        // Act
        const sut = add;
        await sut(ctx, [], { all: true });

        // Assert
        const valid = await validity(ctx);
        expect([valid.get(''), valid.get('d'), valid.get('d/e'), valid.get('x')]).toEqual([
          false,
          false,
          true,
          true,
        ]);
        expect(await signatures(ctx)).toEqual(['TREE', 'REUC']);
      });
    });
  });

  describe('Given a pathspec glob matching a modified file', () => {
    describe('When add stages it', () => {
      it('Then its directory chain is invalid and siblings stay valid', async () => {
        // Arrange
        const ctx = await carryingRepo();
        await write(ctx, 'x/y', 'changed\n');

        // Act
        const sut = add;
        await sut(ctx, ['x/*']);

        // Assert
        const valid = await validity(ctx);
        expect([valid.get(''), valid.get('d'), valid.get('x')]).toEqual([false, true, false]);
      });
    });
  });

  describe('Given a touched file with the same content', () => {
    describe('When add stages it', () => {
      it('Then only the root is invalid', async () => {
        // Arrange
        const ctx = await carryingRepo();
        await write(ctx, 'b', FILES.b as string);

        // Act
        const sut = add;
        await sut(ctx, ['b']);

        // Assert
        const valid = await validity(ctx);
        expect([valid.get(''), valid.get('d'), valid.get('d/e'), valid.get('x')]).toEqual([
          false,
          true,
          true,
          true,
        ]);
      });
    });
  });

  describe('Given a file whose stat is unchanged', () => {
    describe('When add stages it', () => {
      it('Then the TREE bytes are unchanged', async () => {
        // Arrange
        const ctx = await carryingRepo();
        const before = await treeBytes(ctx);

        // Act
        const sut = add;
        await sut(ctx, ['b']);

        // Assert
        expect(await treeBytes(ctx)).toEqual(before);
      });
    });
  });

  describe('Given every staged path has an unchanged stat', () => {
    describe.each([
      ['a literal file', ['b'], undefined],
      ['a glob', ['*'], undefined],
      ['all', undefined, { all: true }],
    ] as const)('When add stages %s', (_name, paths, options) => {
      it('Then the index is left unwritten and keeps its unknown extension', async () => {
        // Arrange
        const ctx = await carryingRepo();
        const before = await ctx.fs.read(`${ctx.layout.gitDir}/index`);

        // Act
        const sut = add;
        await sut(ctx, paths ?? [], options);

        // Assert
        expect(await ctx.fs.read(`${ctx.layout.gitDir}/index`)).toEqual(before);
        expect(await signatures(ctx)).toContain('ZZZZ');
      });
    });
  });

  describe('Given a tracked file deleted from the working tree', () => {
    describe('When add --all stages the removal', () => {
      it('Then the index is rewritten without the file', async () => {
        // Arrange
        const ctx = await carryingRepo();
        await ctx.fs.rm(`${ctx.layout.workDir}/b`);

        // Act
        const sut = add;
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.removed).toEqual(['b']);
        expect(await signatures(ctx)).not.toContain('ZZZZ');
      });
    });
  });

  describe('Given no content change', () => {
    describe('When add renormalizes', () => {
      it('Then every directory is invalid and REUC is kept', async () => {
        // Arrange
        const ctx = await carryingRepo();

        // Act
        const sut = add;
        await sut(ctx, ['.'], { renormalize: true });

        // Assert
        const valid = await validity(ctx);
        expect([valid.get(''), valid.get('d'), valid.get('d/e'), valid.get('x')]).toEqual([
          false,
          false,
          false,
          false,
        ]);
        expect(await signatures(ctx)).toContain('REUC');
      });
    });
  });
});

describe('rm carries index extensions', () => {
  describe('Given a tracked file', () => {
    describe('When rm removes it', () => {
      it('Then the chain is invalid, REUC kept and UNTR dropped', async () => {
        // Arrange
        const ctx = await carryingRepo();

        // Act
        const sut = rm;
        await sut(ctx, ['d/c'], { force: true });

        // Assert
        const valid = await validity(ctx);
        expect([valid.get(''), valid.get('d'), valid.get('x')]).toEqual([false, false, true]);
        expect(await signatures(ctx)).toEqual(['TREE', 'REUC']);
      });
    });
  });
});

describe('mv carries index extensions', () => {
  describe('Given a tracked file', () => {
    describe('When mv moves it into a directory', () => {
      it('Then root and destination are invalid, REUC kept and UNTR dropped', async () => {
        // Arrange
        const ctx = await carryingRepo();

        // Act
        const sut = mv;
        await sut(ctx, ['b'], 'd/b2');

        // Assert
        const valid = await validity(ctx);
        expect([valid.get(''), valid.get('d'), valid.get('d/e'), valid.get('x')]).toEqual([
          false,
          false,
          true,
          true,
        ]);
        expect(await signatures(ctx)).toEqual(['TREE', 'REUC']);
      });
    });
  });
});

describe('sparse-checkout carries index extensions', () => {
  describe('Given tracked files', () => {
    describe('When sparse-checkout set narrows the working tree', () => {
      it('Then the TREE bytes are unchanged and REUC is kept', async () => {
        // Arrange
        const ctx = await carryingRepo();
        const before = await treeBytes(ctx);

        // Act
        const sut = sparseCheckoutSet;
        await sut(ctx, { patterns: ['d'] });

        // Assert
        expect(await treeBytes(ctx)).toEqual(before);
        expect(await signatures(ctx)).toContain('REUC');
      });
    });
  });
});
