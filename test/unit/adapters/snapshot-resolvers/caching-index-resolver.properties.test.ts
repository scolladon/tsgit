import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCachingIndexResolver } from '../../../../src/adapters/snapshot-resolvers/caching-index-resolver.js';
import { createCounterGenerationView } from '../../../../src/adapters/snapshot-resolvers/counter-generation-view.js';
import { createInMemoryWriteEventBus } from '../../../../src/adapters/snapshot-resolvers/in-memory-write-event-bus.js';
import { createRawIndexResolver } from '../../../../src/adapters/snapshot-resolvers/raw-index-resolver.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE, FilePath, type ObjectId } from '../../../../src/domain/objects/index.js';
import type { IndexResolver } from '../../../../src/ports/snapshot-resolvers.js';
import { buildSeededContext } from '../../application/primitives/fixtures.js';
import { arbScopeHistory } from './arbitraries.js';

const ZERO_OID = '0000000000000000000000000000000000000001' as ObjectId;
const ONE_ENTRY_INDEX: GitIndex = {
  version: 2,
  entries: [
    {
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
      path: FilePath.from('a.txt'),
    } satisfies IndexEntry,
  ],
  extensions: [],
  trailerSha: new Uint8Array(0),
};

describe('Given a CachingIndexResolver wrapping the raw resolver and a bus + view', () => {
  describe('When an arbitrary scope-emission history is replayed between resolves', () => {
    it('Then the inner is invoked exactly once: index events trigger stat/trailer re-validation (cache reused), non-index events take the gen fast path', async () => {
      await fc.assert(
        fc.asyncProperty(arbScopeHistory(), async (history) => {
          // Arrange — seed an index, freeze stat so the trailer fallback path can prove reuse.
          const ctx = await buildSeededContext({ index: ONE_ENTRY_INDEX });
          const indexPath = `${ctx.layout.gitDir}/index`;
          const frozenStat = await ctx.fs.stat(indexPath);
          const fakeFs = {
            ...ctx.fs,
            stat: async (p: string) => (p === indexPath ? frozenStat : ctx.fs.stat(p)),
          };
          const view = createCounterGenerationView();
          const bus = createInMemoryWriteEventBus(view);
          let parseCount = 0;
          const raw = createRawIndexResolver();
          const inner: IndexResolver = {
            resolve: async (c, opts) => {
              parseCount += 1;
              return raw.resolve(c, opts);
            },
          };
          const sut = createCachingIndexResolver(inner, fakeFs, bus.stream, view);

          // Act — warm cache, then replay events with a resolve after each.
          await sut.resolve(ctx);
          for (const scope of history) {
            bus.emitter.emit(scope);
            await sut.resolve(ctx);
          }

          // Assert — with stat frozen and trailer matching, cache is always reused.
          // The initial warm is the only inner call regardless of event mix.
          expect(parseCount).toBe(1);
        }),
        { numRuns: 100 },
      );
    });
  });
});
