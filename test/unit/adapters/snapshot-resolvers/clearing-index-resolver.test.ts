import { describe, expect, it } from 'vitest';

import { createCachingIndexResolver } from '../../../../src/adapters/snapshot-resolvers/caching-index-resolver.js';
import { createClearingIndexResolver } from '../../../../src/adapters/snapshot-resolvers/clearing-index-resolver.js';
import { createCounterGenerationView } from '../../../../src/adapters/snapshot-resolvers/counter-generation-view.js';
import { createInMemoryWriteEventBus } from '../../../../src/adapters/snapshot-resolvers/in-memory-write-event-bus.js';
import { createRawIndexResolver } from '../../../../src/adapters/snapshot-resolvers/raw-index-resolver.js';
import { createSingleFlightIndexResolver } from '../../../../src/adapters/snapshot-resolvers/single-flight-index-resolver.js';
import { skipWorktreeEntry } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';
import type { IndexResolver, ResolveOptions } from '../../../../src/ports/snapshot-resolvers.js';
import {
  buildSeededContext,
  serializeIndexFixtureAsync,
} from '../../application/primitives/fixtures.js';

const FAKE_OBJECT_ID = 'a'.repeat(40) as ObjectId;
const SPARSE_ON = '[core]\n\tsparseCheckout = true\n';

const seedSkipWorktreeIndex = async (ctx: Context, path: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, SPARSE_ON);
  const entries = [
    skipWorktreeEntry({ path: path as FilePath, id: FAKE_OBJECT_ID, mode: FILE_MODE.REGULAR }),
  ];
  const bytes = await serializeIndexFixtureAsync(
    { version: 3, entries, extensions: [], trailerSha: new Uint8Array(0) },
    ctx,
  );
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, bytes);
};

const composedStack = (ctx: Context): IndexResolver => {
  const view = createCounterGenerationView();
  const bus = createInMemoryWriteEventBus(view);
  return createClearingIndexResolver(
    createSingleFlightIndexResolver(
      createCachingIndexResolver(createRawIndexResolver(), ctx.fs, bus.stream, view),
    ),
  );
};

const bitsOf = (index: Awaited<ReturnType<IndexResolver['resolve']>>): boolean[] =>
  index.entries.map((e) => e.flags.skipWorktree);

describe('createClearingIndexResolver', () => {
  describe('Given the composed stack over a sparse memory repo with an S entry', () => {
    describe('When a file appears at the S path between two resolves with no index write', () => {
      it('Then the second resolve reports the bit cleared', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedSkipWorktreeIndex(ctx, 'a/f');
        const sut = composedStack(ctx);
        const first = await sut.resolve(ctx);
        await ctx.fs.writeUtf8('/repo/a/f', 'x');

        // Act
        const second = await sut.resolve(ctx);

        // Assert
        expect(bitsOf(first)).toEqual([true]);
        expect(bitsOf(second)).toEqual([false]);
      });
    });

    describe('When the file vanishes between two resolves with no index write', () => {
      it('Then the second resolve reports the bit again', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedSkipWorktreeIndex(ctx, 'a/f');
        await ctx.fs.writeUtf8('/repo/a/f', 'x');
        const sut = composedStack(ctx);
        const first = await sut.resolve(ctx);
        await ctx.fs.rm('/repo/a/f');

        // Act
        const second = await sut.resolve(ctx);

        // Assert
        expect(bitsOf(first)).toEqual([false]);
        expect(bitsOf(second)).toEqual([true]);
      });
    });
  });

  describe('Given a counting inner resolver', () => {
    describe('When resolve is called with bypassCache', () => {
      it('Then the options reach the inner resolver unchanged', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const seen: Array<ResolveOptions | undefined> = [];
        const inner: IndexResolver = {
          resolve: async (c, opts) => {
            seen.push(opts);
            return createRawIndexResolver().resolve(c);
          },
        };
        const sut = createClearingIndexResolver(inner);

        // Act
        await sut.resolve(ctx, { bypassCache: true });

        // Assert
        expect(seen).toEqual([{ bypassCache: true }]);
      });
    });
  });
});
