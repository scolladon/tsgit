/**
 * Targeted mutation-killer tests for the three-tier invalidation logic in
 * `caching-index-resolver.ts`. Each describe block kills a discrete set of
 * mutants surfaced by Stryker on the Wave 1 PR-scoped run; example tests
 * live alongside in `caching-index-resolver.test.ts` and remain the
 * happy-path documentation.
 */
import { describe, expect, it, vi } from 'vitest';

import { createCachingIndexResolver } from '../../../../src/adapters/snapshot-resolvers/caching-index-resolver.js';
import { createCounterGenerationView } from '../../../../src/adapters/snapshot-resolvers/counter-generation-view.js';
import { createInMemoryWriteEventBus } from '../../../../src/adapters/snapshot-resolvers/in-memory-write-event-bus.js';
import { createRawIndexResolver } from '../../../../src/adapters/snapshot-resolvers/raw-index-resolver.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE, FilePath, type ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { FileStat } from '../../../../src/ports/file-system.js';
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

const setupResolver = async (
  statOverride?: (path: string, real: FileStat) => FileStat,
): Promise<{
  ctx: Context;
  fs: Context['fs'];
  view: ReturnType<typeof createCounterGenerationView>;
  inner: CountingResolver;
  sut: IndexResolver;
}> => {
  const ctx = await buildSeededContext({ index: sampleIndex([sampleEntry('a.txt')]) });
  const indexPath = `${ctx.layout.gitDir}/index`;
  const fs =
    statOverride === undefined
      ? ctx.fs
      : {
          ...ctx.fs,
          stat: async (p: string) => {
            const real = await ctx.fs.stat(p);
            return p === indexPath ? statOverride(p, real) : real;
          },
        };
  const ctxWithFs: Context = statOverride === undefined ? ctx : { ...ctx, fs };
  const view = createCounterGenerationView();
  const { stream } = createInMemoryWriteEventBus(view);
  const inner = wrapCounting(createRawIndexResolver());
  const sut = createCachingIndexResolver(inner, fs, stream, view);
  return { ctx: ctxWithFs, fs, view, inner, sut };
};

describe('caching-index-resolver — statMatches per-field branches', () => {
  describe('Given a warm cache and a subsequent stat that differs only on .size', () => {
    describe('When resolve runs through the stat-validated path', () => {
      it('Then statMatches returns false and the resolver re-parses', async () => {
        // Arrange — first call observes stat S0; force the second stat to differ only on size.
        let firstStat: FileStat | undefined;
        let calls = 0;
        const { ctx, view, inner, sut } = await setupResolver((_p, real) => {
          calls += 1;
          if (calls === 1) {
            firstStat = real;
            return real;
          }
          return { ...(firstStat as FileStat), size: (firstStat as FileStat).size + 1 };
        });
        await sut.resolve(ctx);

        // Act
        view.bump('index'); // bypass the gen fast path
        await sut.resolve(ctx);

        // Assert
        expect(inner.calls()).toBe(2);
      });
    });
  });

  describe('Given a warm cache and a subsequent stat that differs only on .ino', () => {
    describe('When resolve runs through the stat-validated path', () => {
      it('Then statMatches returns false and the resolver re-parses', async () => {
        // Arrange
        let firstStat: FileStat | undefined;
        let calls = 0;
        const { ctx, view, inner, sut } = await setupResolver((_p, real) => {
          calls += 1;
          if (calls === 1) {
            firstStat = real;
            return real;
          }
          return { ...(firstStat as FileStat), ino: 99 };
        });
        await sut.resolve(ctx);

        // Act
        view.bump('index');
        await sut.resolve(ctx);

        // Assert
        expect(inner.calls()).toBe(2);
      });
    });
  });

  describe('Given a warm cache and a subsequent stat that differs only on .mtimeMs', () => {
    describe('When resolve runs through the stat-validated path', () => {
      it('Then statMatches returns false and the resolver re-parses', async () => {
        // Arrange
        let firstStat: FileStat | undefined;
        let calls = 0;
        const { ctx, view, inner, sut } = await setupResolver((_p, real) => {
          calls += 1;
          if (calls === 1) {
            firstStat = real;
            return real;
          }
          return { ...(firstStat as FileStat), mtimeMs: (firstStat as FileStat).mtimeMs + 1 };
        });
        await sut.resolve(ctx);

        // Act
        view.bump('index');
        await sut.resolve(ctx);

        // Assert
        expect(inner.calls()).toBe(2);
      });
    });
  });

  describe('Given both stats carry mtimeNs and they match', () => {
    describe('When resolve runs through the stat-validated path with matching ns', () => {
      it('Then statMatches uses the ns precision shortcut and reuses the cache', async () => {
        // Arrange — inject matching ns precision on both observations.
        const fixed: Partial<FileStat> = { mtimeNs: 12345n };
        const { ctx, view, inner, sut } = await setupResolver((_p, real) => ({
          ...real,
          ...fixed,
        }));
        await sut.resolve(ctx);

        // Act
        view.bump('index');
        await sut.resolve(ctx);

        // Assert — needsRacyCheck=false, trailer check skipped, cache reused
        expect(inner.calls()).toBe(1);
      });
    });
  });

  describe('Given both stats carry mtimeNs and they DIFFER', () => {
    describe('When resolve runs through the stat-validated path with mismatched ns', () => {
      it('Then statMatches returns false and the resolver re-parses', async () => {
        // Arrange
        let calls = 0;
        const { ctx, view, inner, sut } = await setupResolver((_p, real) => {
          calls += 1;
          return { ...real, mtimeNs: BigInt(calls) };
        });
        await sut.resolve(ctx);

        // Act
        view.bump('index');
        await sut.resolve(ctx);

        // Assert
        expect(inner.calls()).toBe(2);
      });
    });
  });
});

describe('caching-index-resolver — asymmetric mtimeNs presence', () => {
  describe('Given a warm cache observed WITHOUT ns and a current stat WITH ns', () => {
    describe('When resolve runs through the stat-validated path', () => {
      it('Then needsRacyCheck=true (asymmetric) and the trailer-fallback validates', async () => {
        // Arrange — first stat lacks ns (the cached observation),
        // second stat has ns (mtimeNs present only on the live stat).
        let calls = 0;
        const { ctx, view, inner, sut } = await setupResolver((_p, real) => {
          calls += 1;
          if (calls === 1) {
            const { mtimeNs: _drop, ...rest } = real;
            return rest as FileStat;
          }
          return { ...real, mtimeNs: 999n };
        });
        await sut.resolve(ctx);

        // Act
        view.bump('index');
        await sut.resolve(ctx);

        // Assert — needsRacyCheck=true; trailer matches (file unchanged); cache reused.
        expect(inner.calls()).toBe(1);
      });
    });
  });

  describe('Given a warm cache observed WITH ns and a current stat WITHOUT ns', () => {
    describe('When resolve runs through the stat-validated path', () => {
      it('Then needsRacyCheck=true (asymmetric) and the trailer-fallback validates', async () => {
        // Arrange — mirror of the above; ns presence flipped.
        let calls = 0;
        const { ctx, view, inner, sut } = await setupResolver((_p, real) => {
          calls += 1;
          if (calls === 1) {
            return { ...real, mtimeNs: 999n };
          }
          const { mtimeNs: _drop, ...rest } = real;
          return rest as FileStat;
        });
        await sut.resolve(ctx);

        // Act
        view.bump('index');
        await sut.resolve(ctx);

        // Assert
        expect(inner.calls()).toBe(1);
      });
    });
  });
});

describe('caching-index-resolver — non-racy size differs forces re-parse', () => {
  describe('Given a warm cache observed with ns and a stat that differs on .size but matches ns', () => {
    describe('When resolve runs through the stat-validated path (non-racy)', () => {
      it('Then statMatches detects the size difference and the resolver re-parses', async () => {
        // Arrange — both stats carry mtimeNs (same value) → non-racy branch.
        // Force size to differ between observation and current stat.
        let firstStat: FileStat | undefined;
        let calls = 0;
        const { ctx, view, inner, sut } = await setupResolver((_p, real) => {
          calls += 1;
          const withNs = { ...real, mtimeNs: 12345n };
          if (calls === 1) {
            firstStat = withNs;
            return withNs;
          }
          return { ...(firstStat as FileStat), size: (firstStat as FileStat).size + 7 };
        });
        await sut.resolve(ctx);

        // Act
        view.bump('index');
        await sut.resolve(ctx);

        // Assert — size mismatch caught; non-racy path returned early-false.
        expect(inner.calls()).toBe(2);
      });
    });
  });
});

describe('caching-index-resolver — trailer-fallback size guard', () => {
  describe('Given a warm cache with a 20-byte trailer and a subsequent stat reporting size < 20', () => {
    describe('When the trailer-fallback path would fire (stat matches, racy)', () => {
      it('Then the size guard refuses the shortcut and the resolver re-parses', async () => {
        // Arrange — force the stat tuple to look unchanged but report a size below trailerSize.
        let firstStat: FileStat | undefined;
        let calls = 0;
        const { ctx, view, inner, sut } = await setupResolver((_p, real) => {
          calls += 1;
          if (calls === 1) {
            firstStat = real;
            return real;
          }
          // Same mtime/ino/mtimeNs-absent → statMatches=true, needsRacyCheck=true,
          // but report size < 20 to trip the truncated-index guard.
          return { ...(firstStat as FileStat), size: 5 };
        });
        await sut.resolve(ctx);

        // Act
        view.bump('index');
        await sut.resolve(ctx);

        // Assert — guard fires, fresh parse runs
        expect(inner.calls()).toBe(2);
      });
    });
  });
});

describe('caching-index-resolver — safeStat re-throw is type-checked', () => {
  describe('Given fs.stat throws a non-TsgitError (a plain Error)', () => {
    describe('When resolve is called', () => {
      it('Then the error propagates (instanceof TsgitError guard rejects it)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const failure = new Error('disk on fire');
        const failingFs = {
          ...ctx.fs,
          stat: async (_p: string) => {
            throw failure;
          },
        };
        const failingCtx: Context = { ...ctx, fs: failingFs };
        const view = createCounterGenerationView();
        const { stream } = createInMemoryWriteEventBus(view);
        const inner = wrapCounting(createRawIndexResolver());
        const sut = createCachingIndexResolver(inner, failingFs, stream, view);

        // Act + Assert
        await expect(sut.resolve(failingCtx)).rejects.toBe(failure);
      });
    });
  });

  describe('Given fs.stat throws a TsgitError whose code is NOT FILE_NOT_FOUND', () => {
    describe('When resolve is called and inner.resolve cannot fail (stubbed inner)', () => {
      it('Then the TsgitError propagates (the code-equality guard rejects it)', async () => {
        // Arrange — stub inner so a leaking safeStat-returns-null path would
        // visibly succeed rather than re-fail through readIndex's own stat.
        const ctx = await buildSeededContext();
        const failure = new TsgitError({ code: 'NETWORK_ERROR', reason: 'down' });
        const failingFs = {
          ...ctx.fs,
          stat: async (_p: string) => {
            throw failure;
          },
        };
        const failingCtx: Context = { ...ctx, fs: failingFs };
        const view = createCounterGenerationView();
        const { stream } = createInMemoryWriteEventBus(view);
        const stubInner: IndexResolver = {
          resolve: async () => sampleIndex([sampleEntry('phantom.txt')]),
        };
        const sut = createCachingIndexResolver(stubInner, failingFs, stream, view);

        // Act + Assert — if the right-hand code check were mutated to `true`,
        // safeStat would return null, falling through to the stubbed inner
        // which would succeed; the rejects.toBe(failure) expectation kills
        // that mutant.
        await expect(sut.resolve(failingCtx)).rejects.toBe(failure);
      });
    });
  });
});

describe('caching-index-resolver — entry=null after missing index', () => {
  describe('Given a repository with no .git/index initially', () => {
    describe('When resolve is called twice (no file appearing between calls)', () => {
      it('Then the inner is invoked on each call (cache holds entry=null)', async () => {
        // Arrange — empty seed, no index file written.
        const ctx = await buildSeededContext();
        const view = createCounterGenerationView();
        const { stream } = createInMemoryWriteEventBus(view);
        const inner = wrapCounting(createRawIndexResolver());
        const sut = createCachingIndexResolver(inner, ctx.fs, stream, view);

        // Act
        await sut.resolve(ctx);
        await sut.resolve(ctx);

        // Assert — second resolve missed (entry was reset to null when stat returned null)
        expect(inner.calls()).toBe(2);
      });
    });
  });

  describe('Given a warm cache, a deletion observed via bypassCache, and a follow-up resolve', () => {
    describe('When the follow-up runs at the same gen', () => {
      it('Then entry=null reset prevents a stale cached value from leaking', async () => {
        // Arrange — warm cache, then delete file and force the empty-index
        // re-parse via bypassCache. This exercises the else-branch
        // `entry = null` reset. Without it, the cached entry from the
        // initial warm would persist with cachedGen=0 and the subsequent
        // fast-path resolve at gen 0 would return the stale parse.
        const ctx = await buildSeededContext({ index: sampleIndex([sampleEntry('a.txt')]) });
        const view = createCounterGenerationView();
        const { stream } = createInMemoryWriteEventBus(view);
        const inner = wrapCounting(createRawIndexResolver());
        const sut = createCachingIndexResolver(inner, ctx.fs, stream, view);
        const first = await sut.resolve(ctx);
        expect(first.entries.map((e) => e.path)).toEqual(['a.txt']);
        await ctx.fs.rm(`${ctx.layout.gitDir}/index`);
        const bypass = await sut.resolve(ctx, { bypassCache: true });
        expect(bypass.entries).toEqual([]);

        // Act — at the same gen, with entry now reset to null
        const third = await sut.resolve(ctx);

        // Assert — third call falls through to inner (entry is null), gets
        // the empty parse. If `entry = null` were skipped, the gen fast path
        // would return the stale `a.txt` parse from the initial warm.
        expect(third.entries).toEqual([]);
      });
    });
  });

  describe('Given an index file that appears after the first resolve', () => {
    describe('When resolve runs again', () => {
      it('Then the new file is observed and parsed (no stale entry=null)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const view = createCounterGenerationView();
        const { stream } = createInMemoryWriteEventBus(view);
        const inner = wrapCounting(createRawIndexResolver());
        const sut = createCachingIndexResolver(inner, ctx.fs, stream, view);
        await sut.resolve(ctx);

        // Act
        await writeIndexFile(ctx, sampleIndex([sampleEntry('a.txt')]));
        const result = await sut.resolve(ctx);

        // Assert
        expect(inner.calls()).toBe(2);
        expect(result.entries[0]?.path).toBe('a.txt');
      });
    });
  });
});

describe('caching-index-resolver — trailer-fallback positive reuse', () => {
  describe('Given a warm cache with a 20-byte trailer matching the on-disk file', () => {
    describe('When the trailer-fallback path fires (statMatches=true, racy=true)', () => {
      it('Then the cache is reused (no inner re-parse) once trailer bytes equal', async () => {
        // Arrange — strip mtimeNs to force needsRacyCheck=true, then re-stat
        // returns the same frozen stat so statMatches=true.
        const ctx = await buildSeededContext({ index: sampleIndex([sampleEntry('a.txt')]) });
        const indexPath = `${ctx.layout.gitDir}/index`;
        const real = await ctx.fs.stat(indexPath);
        const racyStat: FileStat = (() => {
          const { mtimeNs: _drop, ...rest } = real;
          return rest as FileStat;
        })();
        const fs = {
          ...ctx.fs,
          stat: async (p: string) => (p === indexPath ? racyStat : ctx.fs.stat(p)),
        };
        const ctxWithFs: Context = { ...ctx, fs };
        const view = createCounterGenerationView();
        const { stream } = createInMemoryWriteEventBus(view);
        const inner = wrapCounting(createRawIndexResolver());
        const sut = createCachingIndexResolver(inner, fs, stream, view);
        await sut.resolve(ctxWithFs);

        // Act — generation bump forces the stat-then-trailer path
        view.bump('index');
        await sut.resolve(ctxWithFs);

        // Assert — trailer matched, cache reused
        expect(inner.calls()).toBe(1);
      });
    });
  });
});

describe('caching-index-resolver — generation fast-path skips fs.stat', () => {
  describe('Given a warm cache and no intervening generation bump', () => {
    describe('When resolve is called a second time', () => {
      it('Then fs.stat is NOT invoked (zero-syscall fast path active)', async () => {
        // Arrange
        const ctx = await buildSeededContext({ index: sampleIndex([sampleEntry('a.txt')]) });
        const statSpy = vi.fn(ctx.fs.stat);
        const fs = { ...ctx.fs, stat: statSpy };
        const ctxWithSpy: Context = { ...ctx, fs };
        const view = createCounterGenerationView();
        const { stream } = createInMemoryWriteEventBus(view);
        const inner = wrapCounting(createRawIndexResolver());
        const sut = createCachingIndexResolver(inner, fs, stream, view);
        await sut.resolve(ctxWithSpy);
        const baselineStatCalls = statSpy.mock.calls.length;

        // Act
        await sut.resolve(ctxWithSpy);

        // Assert — no extra stat calls beyond the warm-cache baseline.
        expect(statSpy.mock.calls.length).toBe(baselineStatCalls);
        expect(inner.calls()).toBe(1);
      });
    });
  });
});
