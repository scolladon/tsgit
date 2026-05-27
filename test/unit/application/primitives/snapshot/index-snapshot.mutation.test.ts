/**
 * Mutation-killer tests for `index-snapshot.ts`. Targets:
 *  - the mtimeMs arithmetic in toEntry (rows are pinned to assertable values)
 *  - `bypassCache === true` forwarding
 *  - `yielded >= cap` boundary and the `yielded += 1` accumulator
 */
import { describe, expect, it, vi } from 'vitest';
import { createRawIndexResolver } from '../../../../../src/adapters/snapshot-resolvers/raw-index-resolver.js';
import { createIndexSnapshot } from '../../../../../src/application/primitives/snapshot/index-snapshot.js';
import type {
  IndexEntry as DomainIndexEntry,
  GitIndex,
} from '../../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE, FilePath, type ObjectId } from '../../../../../src/domain/objects/index.js';
import { compilePathspec } from '../../../../../src/domain/pathspec/index.js';
import type { IndexResolver } from '../../../../../src/ports/snapshot-resolvers.js';
import { buildSeededContext } from '../fixtures.js';

const ZERO_OID = '0000000000000000000000000000000000000001' as ObjectId;

const entry = (path: string, secs = 0, ns = 0): DomainIndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: secs,
  mtimeNanoseconds: ns,
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

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('index-snapshot — mtimeMs arithmetic in toEntry', () => {
  describe('Given an index row with mtimeSeconds=5 and mtimeNanoseconds=750_000_000', () => {
    describe('When entries() is iterated', () => {
      it('Then cachedStat.mtimeMs is 5 * 1000 + floor(750_000_000 / 1_000_000) = 5750', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          index: {
            version: 2,
            entries: [entry('a.txt', 5, 750_000_000)],
            extensions: [],
            trailerSha: new Uint8Array(0),
          },
        });
        const sut = createIndexSnapshot({ ctx, indexResolver: createRawIndexResolver() });

        // Act
        const rows = await collect(sut.entries());

        // Assert
        expect(rows).toHaveLength(1);
        expect(rows[0]?.cachedStat?.mtimeMs).toBe(5750);
      });
    });
  });
});

describe('index-snapshot — bypassCache forwarding', () => {
  describe('Given a stub resolver that captures the bypassCache option', () => {
    describe('When entries() is called WITHOUT bypassCache', () => {
      it('Then the resolver receives bypassCache=false (default path)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const spy = vi.fn(async () => ({
          version: 2 as const,
          entries: [],
          extensions: [],
          trailerSha: new Uint8Array(0),
        }));
        const inner: IndexResolver = { resolve: spy as never };
        const sut = createIndexSnapshot({ ctx, indexResolver: inner });

        // Act
        await collect(sut.entries());

        // Assert
        expect(spy).toHaveBeenCalledTimes(1);
        const firstCall = spy.mock.calls[0] as unknown as ReadonlyArray<unknown> | undefined;
        expect(firstCall?.[1]).toEqual({ bypassCache: false });
      });
    });

    describe('When entries() is called WITH bypassCache=true', () => {
      it('Then the resolver receives bypassCache=true (forwarded)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const spy = vi.fn(async () => ({
          version: 2 as const,
          entries: [],
          extensions: [],
          trailerSha: new Uint8Array(0),
        }));
        const inner: IndexResolver = { resolve: spy as never };
        const sut = createIndexSnapshot({ ctx, indexResolver: inner });

        // Act
        await collect(sut.entries({ bypassCache: true }));

        // Assert
        const firstCall = spy.mock.calls[0] as unknown as ReadonlyArray<unknown> | undefined;
        expect(firstCall?.[1]).toEqual({ bypassCache: true });
      });
    });
  });
});

describe('index-snapshot — maxEntries cap', () => {
  const sevenEntries: GitIndex = {
    version: 2,
    entries: [
      entry('a.txt'),
      entry('b.txt'),
      entry('c.txt'),
      entry('d.txt'),
      entry('e.txt'),
      entry('f.txt'),
      entry('g.txt'),
    ],
    extensions: [],
    trailerSha: new Uint8Array(0),
  };

  describe('Given an index with 7 rows and a maxEntries cap of 3', () => {
    describe('When entries() is iterated', () => {
      it('Then exactly 3 rows are yielded (cap exits early)', async () => {
        // Arrange
        const ctx = await buildSeededContext({ index: sevenEntries });
        const sut = createIndexSnapshot({ ctx, indexResolver: createRawIndexResolver() });

        // Act
        const rows = await collect(sut.entries({ maxEntries: 3 }));

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
      });
    });
  });

  describe('Given an index with 7 rows and maxEntries=1', () => {
    describe('When entries() is iterated', () => {
      it('Then exactly 1 row is yielded (boundary at the first match)', async () => {
        // Arrange
        const ctx = await buildSeededContext({ index: sevenEntries });
        const sut = createIndexSnapshot({ ctx, indexResolver: createRawIndexResolver() });

        // Act
        const rows = await collect(sut.entries({ maxEntries: 1 }));

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a pathspec filter combined with maxEntries', () => {
    describe('When entries() is iterated', () => {
      it('Then filtered rows still respect the cap counted only on yielded entries', async () => {
        // Arrange — only *.txt names; everything matches. Cap=2.
        const ctx = await buildSeededContext({ index: sevenEntries });
        const sut = createIndexSnapshot({ ctx, indexResolver: createRawIndexResolver() });

        // Act
        const rows = await collect(
          sut.entries({ maxEntries: 2, paths: compilePathspec(['*.txt']) }),
        );

        // Assert
        expect(rows).toHaveLength(2);
      });
    });
  });
});
