import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { mergeAbort } from '../../../../src/application/commands/abort-merge.js';
import { add } from '../../../../src/application/commands/add.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { pull } from '../../../../src/application/commands/pull.js';
import { updateConfigEntries } from '../../../../src/application/primitives/update-config.js';
import type { CacheTreeEntry } from '../../../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../src/domain/git-index/index-parser.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { HttpTransport } from '../../../../src/ports/http-transport.js';
import {
  buildDiscoveryBody,
  buildUploadPackResponseBody,
} from '../../../fixtures/transport/builders.js';
import {
  cacheTreeExtension,
  indexExtensionsOf,
  resolveUndoExtension,
  UNKNOWN_EXTENSION,
  UNTR_EXTENSION,
  withIndexExtensions,
} from '../primitives/helpers/index-extensions.js';
import { buildSyntheticPack } from '../primitives/pack-fixture.js';

const SHA1_DIGEST = 20;
const TREE_ID = 'c'.repeat(40) as ObjectId;
const BLOB_ID = 'b'.repeat(40);
const T0 = 1_700_000_000_000;
const SECOND = 1000;
const REMOTE_URL = 'https://remote.example/r.git';
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

const commitAll = async (ctx: Context, message: string, paths: string[]): Promise<ObjectId> => {
  await add(ctx, paths);
  advance(1);
  const result = await commit(ctx, { message, author: AUTHOR, committer: AUTHOR });
  advance(1);
  return result.id;
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

interface Repo {
  readonly ctx: Context;
  readonly base: ObjectId;
  readonly other: ObjectId;
}

/** `main` = c1 (FILES); `other` = c1 then `otherChange` committed. Left on `main` at c1. */
const forkedRepo = async (otherChange: Readonly<Record<string, string>>): Promise<Repo> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const ctx = createMemoryContext();
  await init(ctx);
  for (const [path, content] of Object.entries(FILES)) await write(ctx, path, content);
  const base = await commitAll(ctx, 'c1', Object.keys(FILES));
  await checkout(ctx, { rev: 'HEAD', createBranch: { name: 'other' } });
  advance(1);
  for (const [path, content] of Object.entries(otherChange)) await write(ctx, path, content);
  const other = await commitAll(ctx, 'other', Object.keys(otherChange));
  await checkout(ctx, { rev: 'main' });
  advance(1);
  return { ctx, base, other };
};

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

const chains = async (ctx: Context): Promise<ReadonlyArray<boolean | undefined>> => {
  const valid = await validity(ctx);
  return [valid.get(''), valid.get('d'), valid.get('d/e'), valid.get('x')];
};

const OTHER_CHANGE = { 'x/y': 'other\n', 'z/w': 'w\n' };

afterEach(() => {
  vi.useRealTimers();
});

describe('merge carries index extensions', () => {
  describe('Given a branch strictly ahead of the current one', () => {
    describe('When merge fast-forwards', () => {
      it('Then REUC, UNTR and the unknown extension are dropped and only the changed chains are invalid', async () => {
        // Arrange
        const { ctx } = await forkedRepo(OTHER_CHANGE);
        await carryAllExtensions(ctx);

        // Act
        const sut = mergeRun;
        await sut(ctx, { rev: 'other' });

        // Assert
        expect(await signatures(ctx)).toEqual(['TREE']);
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });

  describe('Given diverged branches that merge cleanly', () => {
    describe('When merge creates the merge commit', () => {
      it('Then REUC, UNTR and the unknown extension are dropped and only the changed chains are invalid', async () => {
        // Arrange
        const { ctx } = await forkedRepo(OTHER_CHANGE);
        await write(ctx, 'b', 'b2\n');
        await commitAll(ctx, 'c2', ['b']);
        await carryAllExtensions(ctx);

        // Act
        const sut = mergeRun;
        await sut(ctx, { rev: 'other', author: AUTHOR });

        // Assert
        expect(await signatures(ctx)).toEqual(['TREE']);
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });

  describe('Given diverged branches editing the same file', () => {
    describe('When merge stops on the conflict', () => {
      it('Then REUC is dropped, UNTR is kept as the tracked set is unchanged and the conflicted chain is invalid', async () => {
        // Arrange
        const { ctx } = await forkedRepo({ 'x/y': 'other\n' });
        await write(ctx, 'x/y', 'main\n');
        await commitAll(ctx, 'c2', ['x/y']);
        await carryAllExtensions(ctx);

        // Act
        const sut = mergeRun;
        const result = await sut(ctx, { rev: 'other', author: AUTHOR });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(await signatures(ctx)).toEqual(['TREE', 'UNTR']);
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });

  describe('Given a conflicted merge whose index carries extensions', () => {
    describe('When merge abort resets the work tree', () => {
      it('Then REUC and the unknown extension are dropped, UNTR is kept', async () => {
        // Arrange
        const { ctx } = await forkedRepo({ 'x/y': 'other\n' });
        await write(ctx, 'x/y', 'main\n');
        await commitAll(ctx, 'c2', ['x/y']);
        await mergeRun(ctx, { rev: 'other', author: AUTHOR });
        await carryAllExtensions(ctx);

        // Act
        const sut = mergeAbort;
        await sut(ctx);

        // Assert
        expect(await signatures(ctx)).toEqual(['TREE', 'UNTR']);
      });
    });
  });
});

const emptyPack = async (ctx: Context): Promise<Uint8Array> =>
  (await buildSyntheticPack(ctx, [])).packBytes;

const streamOf = (body: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body.slice());
      controller.close();
    },
  });

const remoteAdvertising = (id: ObjectId, packBytes: Uint8Array): HttpTransport => {
  const discovery = buildDiscoveryBody({
    service: 'git-upload-pack',
    capabilities: ['side-band-64k', 'ofs-delta'],
    refs: [{ name: 'refs/heads/main', id }],
  });
  const pack = buildUploadPackResponseBody({ packBytes, sideBand: true, shallow: [] });
  return {
    request: async (req) => ({
      statusCode: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: streamOf(req.url.includes('/info/refs') ? discovery : pack),
    }),
  };
};

describe('pull carries index extensions', () => {
  describe('Given a fetch that moves the checked-out branch ahead', () => {
    describe('When pull fast-forwards the index and work tree', () => {
      it('Then REUC, UNTR and the unknown extension are dropped and only the changed chains are invalid', async () => {
        // Arrange
        const { ctx, other } = await forkedRepo(OTHER_CHANGE);
        await updateConfigEntries(ctx, [
          { section: 'remote', subsection: 'origin', key: 'url', value: REMOTE_URL },
          {
            section: 'remote',
            subsection: 'origin',
            key: 'fetch',
            value: '+refs/heads/*:refs/remotes/origin/*',
          },
        ]);
        await carryAllExtensions(ctx);
        const transport = remoteAdvertising(other, await emptyPack(ctx));

        // Act
        const sut = pull;
        await sut({ ...ctx, transport }, { remote: 'origin', ref: 'main:main' });

        // Assert
        expect(await signatures(ctx)).toEqual(['TREE']);
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });
});
