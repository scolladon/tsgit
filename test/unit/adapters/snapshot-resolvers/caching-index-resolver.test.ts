import { describe, expect, it } from 'vitest';

import { createCachingIndexResolver } from '../../../../src/adapters/snapshot-resolvers/caching-index-resolver.js';
import { createCounterGenerationView } from '../../../../src/adapters/snapshot-resolvers/counter-generation-view.js';
import { createInMemoryWriteEventBus } from '../../../../src/adapters/snapshot-resolvers/in-memory-write-event-bus.js';
import { createRawIndexResolver } from '../../../../src/adapters/snapshot-resolvers/raw-index-resolver.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE, FilePath, type ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { IndexResolver } from '../../../../src/ports/snapshot-resolvers.js';
import {
  buildSeededContext,
  serializeIndexFixtureAsync,
} from '../../application/primitives/fixtures.js';

const ZERO_OID = '0000000000000000000000000000000000000001' as ObjectId;

const sampleEntry = (path: string): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: ZERO_OID,
  flags: STAGE0_FLAGS,
  path: FilePath.from(path),
});

const sampleIndex = (entries: ReadonlyArray<IndexEntry>): GitIndex => ({
  version: 2,
  entries,
  extensions: [],
  trailerSha: new Uint8Array(0),
});

interface CountingResolver extends IndexResolver {
  readonly calls: () => number;
}

const wrapCounting = (inner: IndexResolver): CountingResolver => {
  let count = 0;
  return {
    calls: () => count,
    resolve: async (ctx, opts) => {
      count += 1;
      return inner.resolve(ctx, opts);
    },
  };
};

const writeIndexFile = async (ctx: Context, index: GitIndex): Promise<void> => {
  const bytes = await serializeIndexFixtureAsync(index, ctx);
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, bytes);
};

describe('createCachingIndexResolver', () => {
  describe('Given a freshly-seeded repository and a wired bus + view + caching resolver', () => {
    describe('When resolve is called 1000 times with no intervening writes', () => {
      it('Then the inner resolver is invoked exactly once (generation-match fast path)', async () => {
        // Arrange
        const ctx = await buildSeededContext({ index: sampleIndex([sampleEntry('a.txt')]) });
        const view = createCounterGenerationView();
        const { stream } = createInMemoryWriteEventBus(view);
        const inner = wrapCounting(createRawIndexResolver());
        const sut = createCachingIndexResolver(inner, ctx.fs, stream, view);

        // Act
        for (let i = 0; i < 1000; i += 1) await sut.resolve(ctx);

        // Assert
        expect(inner.calls()).toBe(1);
      });
    });
  });

  describe('Given the cache has been warmed and a write happened with generation bumped', () => {
    describe('When the next resolve runs (generation mismatch path)', () => {
      it('Then the resolver re-parses when stat differs from the cached observation', async () => {
        // Arrange
        const ctx = await buildSeededContext({ index: sampleIndex([sampleEntry('a.txt')]) });
        const view = createCounterGenerationView();
        const { stream } = createInMemoryWriteEventBus(view);
        const inner = wrapCounting(createRawIndexResolver());
        const sut = createCachingIndexResolver(inner, ctx.fs, stream, view);
        await sut.resolve(ctx);

        // Act — overwrite with a different-sized payload, then bump the generation
        // to force the stat-validation path (the gen fast-path returns stale data
        // by design — see ADR-150: external writers without an emit are caught
        // lazily on the next gen-bump or bypassCache).
        await writeIndexFile(
          ctx,
          sampleIndex([sampleEntry('a.txt'), sampleEntry('b.txt'), sampleEntry('c.txt')]),
        );
        view.bump('index');
        await sut.resolve(ctx);

        // Assert
        expect(inner.calls()).toBe(2);
      });
    });
  });

  describe('Given the cache has been warmed and the write-event bus has emitted("index")', () => {
    describe('When the next resolve runs after the file was updated and emit fired', () => {
      it('Then the resolver re-parses (generation mismatch + stat mismatch)', async () => {
        // Arrange
        const ctx = await buildSeededContext({ index: sampleIndex([sampleEntry('a.txt')]) });
        const view = createCounterGenerationView();
        const bus = createInMemoryWriteEventBus(view);
        const inner = wrapCounting(createRawIndexResolver());
        const sut = createCachingIndexResolver(inner, ctx.fs, bus.stream, view);
        await sut.resolve(ctx);

        // Act — simulate an in-process write: change the file, then emit
        await writeIndexFile(ctx, sampleIndex([sampleEntry('z.ts')]));
        bus.emitter.emit('index');
        await sut.resolve(ctx);

        // Assert
        expect(inner.calls()).toBe(2);
      });
    });
  });

  describe('Given an event for a scope other than "index"', () => {
    describe('When the bus emits "refs" or "objects"', () => {
      it('Then the index cache is not invalidated (scope independence)', async () => {
        // Arrange
        const ctx = await buildSeededContext({ index: sampleIndex([sampleEntry('a.txt')]) });
        const view = createCounterGenerationView();
        const bus = createInMemoryWriteEventBus(view);
        const inner = wrapCounting(createRawIndexResolver());
        const sut = createCachingIndexResolver(inner, ctx.fs, bus.stream, view);
        await sut.resolve(ctx);

        // Act
        bus.emitter.emit('refs');
        bus.emitter.emit('objects');
        await sut.resolve(ctx);

        // Assert — index cache still hit; only one inner parse total
        expect(inner.calls()).toBe(1);
      });
    });
  });

  describe('Given bypassCache=true on a resolve call', () => {
    describe('When the cache is warm and bypassCache is set', () => {
      it('Then the inner resolver is invoked, replacing the cached entry', async () => {
        // Arrange
        const ctx = await buildSeededContext({ index: sampleIndex([sampleEntry('a.txt')]) });
        const view = createCounterGenerationView();
        const { stream } = createInMemoryWriteEventBus(view);
        const inner = wrapCounting(createRawIndexResolver());
        const sut = createCachingIndexResolver(inner, ctx.fs, stream, view);
        await sut.resolve(ctx);

        // Act
        await sut.resolve(ctx, { bypassCache: true });

        // Assert
        expect(inner.calls()).toBe(2);
      });
    });
  });

  describe('Given a warm cache and an external write that collides on every stat field', () => {
    describe('When the trailer differs from the cached trailer', () => {
      it('Then re-parse happens (SHA-trailer fallback catches stat-collision)', async () => {
        // Arrange — wrap fs.stat to return a frozen stat regardless of underlying changes,
        // so that statMatches always returns true. The trailer fallback is the only
        // discriminator left.
        const ctx = await buildSeededContext({ index: sampleIndex([sampleEntry('a.txt')]) });
        const indexPath = `${ctx.layout.gitDir}/index`;
        const frozenStat = await ctx.fs.stat(indexPath);
        const racyFs = {
          ...ctx.fs,
          stat: async (p: string) => (p === indexPath ? frozenStat : ctx.fs.stat(p)),
        };
        const racyCtx: Context = { ...ctx, fs: racyFs };
        const view = createCounterGenerationView();
        const { stream } = createInMemoryWriteEventBus(view);
        const inner = wrapCounting(createRawIndexResolver());
        const sut = createCachingIndexResolver(inner, racyFs, stream, view);
        await sut.resolve(racyCtx);

        // Act — overwrite the file with a valid but different index (different entries =>
        // different parser output => different trailer hash).
        await writeIndexFile(ctx, sampleIndex([sampleEntry('z.txt')]));
        view.bump('index'); // force the generation mismatch (skip the gen fast path)
        const reparsed = await sut.resolve(racyCtx);

        // Assert — inner was invoked a second time AND the cache returned the new content.
        expect(inner.calls()).toBe(2);
        expect(reparsed.entries[0]?.path).toBe('z.txt');
      });
    });
  });
});
