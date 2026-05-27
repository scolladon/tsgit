import { describe, expect, it } from 'vitest';
import { createRawIndexResolver } from '../../../../../src/adapters/snapshot-resolvers/raw-index-resolver.js';
import { createIndexSnapshot } from '../../../../../src/application/primitives/snapshot/index-snapshot.js';
import type {
  IndexEntry as DomainIndexEntry,
  GitIndex,
} from '../../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE, FilePath, type ObjectId } from '../../../../../src/domain/objects/index.js';
import { compilePathspec } from '../../../../../src/domain/pathspec/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { IndexResolver } from '../../../../../src/ports/snapshot-resolvers.js';
import { buildSeededContext, serializeIndexFixtureAsync } from '../fixtures.js';

const ZERO_OID = '0000000000000000000000000000000000000001' as ObjectId;

const entry = (path: string): DomainIndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 1,
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

const writeIndex = async (ctx: Context, index: GitIndex): Promise<void> => {
  const bytes = await serializeIndexFixtureAsync(index, ctx);
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, bytes);
};

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('createIndexSnapshot', () => {
  describe('Given an index with two stage-0 entries', () => {
    describe('When entries() is iterated', () => {
      it('Then it yields one IndexEntry per row with source="index" and stage=0', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          index: {
            version: 2,
            entries: [entry('a.txt'), entry('b.txt')],
            extensions: [],
            trailerSha: new Uint8Array(0),
          },
        });
        const sut = createIndexSnapshot({ ctx, indexResolver: createRawIndexResolver() });

        // Act
        const rows = await collect(sut.entries());

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['a.txt', 'b.txt']);
        for (const row of rows) {
          expect(row.source).toBe('index');
          expect(row.stage).toBe(0);
        }
      });
    });
  });

  describe('Given a stub resolver that counts resolve calls', () => {
    describe('When the same snapshot handle is iterated twice', () => {
      it('Then the resolver is invoked exactly once (iteration-stability)', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          index: {
            version: 2,
            entries: [entry('a.txt')],
            extensions: [],
            trailerSha: new Uint8Array(0),
          },
        });
        const raw = createRawIndexResolver();
        let calls = 0;
        const counting: IndexResolver = {
          resolve: async (c, opts) => {
            calls += 1;
            return raw.resolve(c, opts);
          },
        };
        const sut = createIndexSnapshot({ ctx, indexResolver: counting });

        // Act
        await collect(sut.entries());
        await collect(sut.entries());

        // Assert
        expect(calls).toBe(1);
      });
    });
  });

  describe('Given an iteration in progress on a handle and a mid-iteration mutation', () => {
    describe('When the index file changes after the first row is yielded', () => {
      it('Then the in-flight iteration continues yielding the pre-mutation rows', async () => {
        // Arrange — seed with 3 entries; capture the iteration by hand so we can mutate
        // the file between yields without the resolver re-running.
        const ctx = await buildSeededContext({
          index: {
            version: 2,
            entries: [entry('a.txt'), entry('b.txt'), entry('c.txt')],
            extensions: [],
            trailerSha: new Uint8Array(0),
          },
        });
        const sut = createIndexSnapshot({ ctx, indexResolver: createRawIndexResolver() });

        // Act
        const iter = sut.entries()[Symbol.asyncIterator]();
        const first = await iter.next();
        // Replace the index file mid-iteration; the captured GitIndex inside the snapshot
        // is unaffected.
        await writeIndex(ctx, {
          version: 2,
          entries: [entry('zzz.txt')],
          extensions: [],
          trailerSha: new Uint8Array(0),
        });
        const second = await iter.next();
        const third = await iter.next();
        const end = await iter.next();

        // Assert
        expect(first.value?.path).toBe('a.txt');
        expect(second.value?.path).toBe('b.txt');
        expect(third.value?.path).toBe('c.txt');
        expect(end.done).toBe(true);
      });
    });
  });

  describe('Given a pathspec filter', () => {
    describe('When entries() is iterated with that pathspec', () => {
      it('Then only matching rows are yielded', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          index: {
            version: 2,
            entries: [entry('a.md'), entry('b.ts'), entry('c.ts')],
            extensions: [],
            trailerSha: new Uint8Array(0),
          },
        });
        const sut = createIndexSnapshot({ ctx, indexResolver: createRawIndexResolver() });

        // Act
        const rows = await collect(sut.entries({ paths: compilePathspec(['*.ts']) }));

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['b.ts', 'c.ts']);
      });
    });
  });
});
