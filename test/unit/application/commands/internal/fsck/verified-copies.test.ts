import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import { project } from '../../../../../../src/application/commands/internal/fsck/object-cache.js';
import {
  parseCheckOnce,
  unverifiedIds,
  verifiedCopiesOf,
  withVerifiedCopies,
} from '../../../../../../src/application/commands/internal/fsck/verified-copies.js';
import { looseObjectPath } from '../../../../../../src/application/primitives/path-layout.js';
import { refreshPackRegistry } from '../../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../../src/application/primitives/write-object.js';
import { FILE_MODE, type ObjectId } from '../../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../../src/ports/context.js';
import { writeSyntheticPack } from '../../../primitives/pack-fixture.js';

const enc = new TextEncoder();
const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/** A loose tree over `f`, and a pack holding its id over a blob's bytes. */
const misHashedTree = async (): Promise<{
  readonly ctx: Context;
  readonly tree: ObjectId;
  readonly blob: ObjectId;
}> => {
  const ctx = createMemoryContext();
  const blob = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: enc.encode('f'),
  });
  const tree = await writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [treeEntry(FILE_MODE.REGULAR, 'f', blob)],
  });
  await writeSyntheticPack(ctx, 'mis', [
    { kind: 'base', type: 'blob', content: enc.encode('other'), idOverride: tree },
  ]);
  refreshPackRegistry(ctx);
  return { ctx, tree, blob };
};

describe('Given an id whose served copy hashes to it', () => {
  describe('When its verified copy is looked up', () => {
    it('Then nothing replaces it', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const blob = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: enc.encode('fine'),
      });
      const sut = verifiedCopiesOf;

      // Act
      const result = await sut(ctx, new Set([blob]));

      // Assert
      expect([...result]).toEqual([]);
    });
  });
});

describe('Given an id served from a mis-hashed pack entry', () => {
  describe('When its loose copy verifies', () => {
    it('Then the loose copy stands in', async () => {
      // Arrange
      const { ctx, tree, blob } = await misHashedTree();
      const sut = verifiedCopiesOf;

      // Act
      const result = await sut(ctx, new Set([tree]));

      // Assert
      expect(result.get(tree)).toEqual(
        project({ type: 'tree', id: tree, entries: [treeEntry(FILE_MODE.REGULAR, 'f', blob)] }),
      );
    });
  });

  describe('When one id has a verified loose copy and another has none', () => {
    it('Then only the id with no verified copy is unverified', () => {
      // Arrange
      const verifiedId = 'a'.repeat(40) as ObjectId;
      const unverifiedId = 'b'.repeat(40) as ObjectId;
      const verified = new Map([
        [verifiedId, project({ type: 'blob', id: verifiedId, content: new Uint8Array() })],
        [unverifiedId, null],
      ]);
      const sut = unverifiedIds;

      // Act
      const result = sut(verified);

      // Assert
      expect(result).toEqual(new Set([unverifiedId]));
    });
  });

  describe.each([
    { label: 'does not inflate', bytes: async () => enc.encode('garbage') },
    {
      label: 'hashes to another id',
      bytes: async (ctx: Context) => ctx.compressor.deflate(enc.encode('blob 1\0x')),
    },
    {
      label: 'does not parse',
      bytes: async (ctx: Context) => ctx.compressor.deflate(enc.encode('tree 1\0x')),
    },
  ])('When its only loose copy $label', ({ bytes }) => {
    it('Then no copy verifies', async () => {
      // Arrange
      const { ctx, tree } = await misHashedTree();
      await ctx.fs.write(looseObjectPath(ctx.layout.gitDir, tree), await bytes(ctx));
      const sut = verifiedCopiesOf;

      // Act
      const result = await sut(ctx, new Set([tree]));

      // Assert
      expect(result.get(tree)).toBeNull();
      expect(unverifiedIds(result)).toEqual(new Set([tree]));
    });
  });

  describe('When inflating its loose copy faults for a reason other than damage', () => {
    it('Then the fault propagates', async () => {
      // Arrange
      const { ctx, tree } = await misHashedTree();
      const fault = new Error('inflater crashed');
      const faulty: Context = {
        ...ctx,
        compressor: { ...ctx.compressor, inflate: () => Promise.reject(fault) },
      };
      const sut = verifiedCopiesOf;

      // Act
      const result = await sut(faulty, new Set([tree])).then(
        () => undefined,
        (err: unknown) => err,
      );

      // Assert
      expect(result).toBe(fault);
    });
  });
});

describe('Given a cache and the verified copies of some of its ids', () => {
  describe('When the verified copies are laid over it', () => {
    it('Then each verified copy replaces its served one and the rest stay', () => {
      // Arrange
      const kept = 'a'.repeat(40) as ObjectId;
      const replaced = 'b'.repeat(40) as ObjectId;
      const cache = new Map([
        [kept, project({ type: 'blob', id: kept, content: new Uint8Array() })],
        [replaced, project({ type: 'blob', id: replaced, content: new Uint8Array() })],
      ]);
      const sut = withVerifiedCopies;

      // Act
      const result = sut(cache, new Map([[replaced, null]]));

      // Assert
      expect([...result]).toEqual([
        [kept, cache.get(kept)],
        [replaced, null],
      ]);
    });
  });

  describe('When there is no verified copy', () => {
    it('Then the cache is returned as is', () => {
      // Arrange
      const cache = new Map();
      const sut = withVerifiedCopies;

      // Act
      const result = sut(cache, new Map());

      // Assert
      expect(result).toBe(cache);
    });
  });
});

describe('Given a shallow commit served from a mis-hashed pack entry beside a loose copy', () => {
  describe('When its loose copy verifies', () => {
    it('Then the loose copy stands in with its parents cut, as git grafts it', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
      const commitOver = (parents: ReadonlyArray<ObjectId>, message: string) =>
        writeObject(ctx, {
          type: 'commit',
          id: '' as ObjectId,
          data: { tree, parents, author: AUTHOR, committer: AUTHOR, message, extraHeaders: [] },
        });
      const parent = await commitOver([], 'c1');
      const shallow = await commitOver([parent], 'c2');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${shallow}\n`);
      await writeSyntheticPack(ctx, 'mis', [
        { kind: 'base', type: 'blob', content: enc.encode('other'), idOverride: shallow },
      ]);
      refreshPackRegistry(ctx);
      const sut = verifiedCopiesOf;

      // Act
      const result = await sut(ctx, new Set([shallow]));

      // Assert
      expect(result.get(shallow)).toMatchObject({ type: 'commit', tree, parents: [] });
    });
  });
});

describe('Given a parse check asked about the same ids twice', () => {
  describe('When each answer is awaited', () => {
    it('Then each id is hashed once and keeps its verdict', async () => {
      // Arrange
      const { ctx, tree, blob } = await misHashedTree();
      const hashes = vi.spyOn(ctx.hash, 'createHasher');
      const sut = parseCheckOnce;

      // Act
      const check = sut(ctx);
      const first = [await check(tree), await check(blob)];
      const hashesAfterFirst = hashes.mock.calls.length;
      const second = [await check(tree), await check(blob)];

      // Assert
      expect(first).toEqual([false, true]);
      expect(second).toEqual([false, true]);
      expect(hashes.mock.calls.length).toBe(hashesAfterFirst);
    });
  });
});
