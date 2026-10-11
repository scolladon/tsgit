import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import { packsInVerifyOrder } from '../../../../../../src/application/commands/internal/fsck/pack-verify-order.js';
import { getObjectStore } from '../../../../../../src/application/primitives/object-store.js';
import {
  commonGitDir,
  multiPackIndexPath,
  packsDir,
} from '../../../../../../src/application/primitives/path-layout.js';
import { hexToBytes } from '../../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../../src/ports/context.js';
import { buildMidx } from '../../../../domain/storage/arbitraries.js';
import { writeSyntheticPack, writeSyntheticPackIn } from '../../../primitives/pack-fixture.js';

const enc = new TextEncoder();
const T0 = Date.UTC(2020, 0, 1);
const SECOND = 1000;
const HALF_SECOND = 500;
const FIRST_ENTRY_OFFSET = 12;
const DONOR_OBJECTS = '/repo/donor/objects';

const blobSpec = (content: string) => [
  { kind: 'base' as const, type: 'blob' as const, content: enc.encode(content) },
];

const newContext = async (): Promise<Context> => {
  const ctx = createMemoryContext({
    files: { '/repo/.git/objects/info/alternates': enc.encode(`${DONOR_OBJECTS}\n`) },
  });
  await ctx.fs.mkdir(DONOR_OBJECTS);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

const packAt = async (ctx: Context, at: number, name: string, objectsDir?: string) => {
  vi.setSystemTime(at);
  const entries = blobSpec(`content of ${name}`);
  const [id] =
    objectsDir === undefined
      ? await writeSyntheticPack(ctx, name, entries)
      : await writeSyntheticPackIn(ctx, objectsDir, name, entries);
  return id as string;
};

const pointMainAt = (ctx: Context, id: string) =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${id}\n`);

const writeMidx = async (ctx: Context, packs: ReadonlyArray<{ name: string; id: string }>) => {
  const raw = buildMidx({
    version: 2,
    hashVersion: 1,
    digestLength: 20,
    numBaseFiles: 0,
    packNames: packs.map(({ name }) => `pack-${name}.idx`),
    entries: packs.map(({ id }, packIndex) => ({
      id: id as never,
      packIndex,
      offset: FIRST_ENTRY_OFFSET,
    })),
  });
  const bodyEnd = raw.length - ctx.hashConfig.digestLength;
  raw.set(hexToBytes(await ctx.hash.hashHex(raw.subarray(0, bodyEnd))), bodyEnd);
  await ctx.fs.write(multiPackIndexPath(packsDir(commonGitDir(ctx))), raw);
};

const sut = packsInVerifyOrder;

const orderPerSource = async (ctx: Context) => {
  const store = await getObjectStore(ctx);
  const order = await sut(ctx, store);
  return store.sources.map((source) => (order.get(source) ?? []).map(({ name }) => name));
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Given scanned packs of one age and a ref tip held by the later one', () => {
  describe('When the verify order is computed', () => {
    it('Then the pack holding the tip comes first', async () => {
      // Arrange
      vi.useFakeTimers({ toFake: ['Date'] });
      const ctx = await newContext();
      await packAt(ctx, T0, 'a');
      await pointMainAt(ctx, await packAt(ctx, T0, 'b'));

      // Act
      const result = await orderPerSource(ctx);

      // Assert
      expect(result[0]).toEqual(['pack-b', 'pack-a']);
    });
  });

  describe('When the tip is held by neither pack', () => {
    it('Then they keep their listing order', async () => {
      // Arrange
      vi.useFakeTimers({ toFake: ['Date'] });
      const ctx = await newContext();
      await packAt(ctx, T0, 'a');
      await packAt(ctx, T0, 'b');
      await pointMainAt(ctx, 'f'.repeat(40));

      // Act
      const result = await orderPerSource(ctx);

      // Assert
      expect(result[0]).toEqual(['pack-a', 'pack-b']);
    });
  });
});

describe('Given scanned packs written within one second, the older by milliseconds listed second', () => {
  describe('When a ref tip is held by the second', () => {
    it('Then the tie is broken by use, not by the sub-second mtime', async () => {
      // Arrange
      vi.useFakeTimers({ toFake: ['Date'] });
      const ctx = await newContext();
      await packAt(ctx, T0 + HALF_SECOND, 'a');
      await pointMainAt(ctx, await packAt(ctx, T0, 'b'));

      // Act
      const result = await orderPerSource(ctx);

      // Assert
      expect(result[0]).toEqual(['pack-b', 'pack-a']);
    });
  });
});

describe('Given a multi-pack-index beside a scanned pack holding the ref tip', () => {
  describe('When the verify order is computed', () => {
    it('Then the tip moves its scanned pack to the front, the midx pack following', async () => {
      // Arrange
      vi.useFakeTimers({ toFake: ['Date'] });
      const ctx = await newContext();
      await packAt(ctx, T0, 'a');
      const tip = await packAt(ctx, T0, 'b');
      const midxId = await packAt(ctx, T0, 'm1');
      await writeMidx(ctx, [{ name: 'm1', id: midxId }]);
      await pointMainAt(ctx, tip);

      // Act
      const result = await orderPerSource(ctx);

      // Assert
      expect(result[0]).toEqual(['pack-b', 'pack-a', 'pack-m1']);
    });
  });
});

describe('Given a multi-pack-index of two packs younger than a scanned one', () => {
  describe('When the ref tip is held by the second midx pack', () => {
    it('Then only that midx pack is loaded ahead of the other', async () => {
      // Arrange
      vi.useFakeTimers({ toFake: ['Date'] });
      const ctx = await newContext();
      await packAt(ctx, T0, 'scanned');
      const first = await packAt(ctx, T0 + SECOND, 'm1');
      const second = await packAt(ctx, T0 + SECOND, 'm2');
      await writeMidx(ctx, [
        { name: 'm1', id: first },
        { name: 'm2', id: second },
      ]);
      await pointMainAt(ctx, second);

      // Act
      const result = await orderPerSource(ctx);

      // Assert
      expect(result[0]).toEqual(['pack-m2', 'pack-scanned', 'pack-m1']);
    });
  });
});

describe('Given an alternate whose later pack holds the ref tip', () => {
  describe('When the primary holds the tip nowhere', () => {
    it('Then the lookup goes on to the alternate and moves that pack first', async () => {
      // Arrange
      vi.useFakeTimers({ toFake: ['Date'] });
      const ctx = await newContext();
      await packAt(ctx, T0, 'p1');
      await packAt(ctx, T0, 'q1', DONOR_OBJECTS);
      await pointMainAt(ctx, await packAt(ctx, T0, 'q2', DONOR_OBJECTS));

      // Act
      const result = await orderPerSource(ctx);

      // Assert
      expect(result).toEqual([['pack-p1'], ['pack-q2', 'pack-q1']]);
    });
  });
});

describe('Given a pack lookup failing for a reason no midx check reports', () => {
  describe('When the verify order is computed', () => {
    it('Then the failure propagates', async () => {
      // Arrange
      const ctx = await newContext();
      await pointMainAt(ctx, await packAt(ctx, T0, 'a'));
      const store = await getObjectStore(ctx);
      const failure = new Error('lookup exploded');
      vi.spyOn(store.primary.registry, 'lookup').mockRejectedValue(failure);

      // Act
      const result = sut(ctx, store);

      // Assert
      await expect(result).rejects.toBe(failure);
    });
  });
});
