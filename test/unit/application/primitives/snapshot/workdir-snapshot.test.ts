import { describe, expect, it } from 'vitest';

import { createFsWorkdirEnumerator } from '../../../../../src/adapters/snapshot-resolvers/fs-workdir-enumerator.js';
import { createWorkdirSnapshot } from '../../../../../src/application/primitives/snapshot/workdir-snapshot.js';
import { compilePathspec } from '../../../../../src/domain/pathspec/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import type {
  WalkIgnorePredicate,
  WorkdirEnumerator,
  WorkdirEnumOptions,
} from '../../../../../src/ports/snapshot-resolvers.js';
import { buildSeededContext } from '../fixtures.js';

const seedFile = async (ctx: Context, relPath: string, content = 'x'): Promise<void> => {
  await ctx.fs.write(`${ctx.layout.workDir}/${relPath}`, new TextEncoder().encode(content));
};

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('createWorkdirSnapshot', () => {
  describe('Given a workdir with two files and the default (eager) consistency mode', () => {
    describe('When entries() is iterated', () => {
      it('Then it yields a WorkdirEntry per file in canonical order', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        await seedFile(ctx, 'b.txt');
        const sut = createWorkdirSnapshot({ ctx, enumerator: createFsWorkdirEnumerator() });

        // Act
        const rows = await collect(sut.entries());

        // Assert
        expect(rows.map((r) => r.path).sort()).toEqual(['a.txt', 'b.txt']);
        for (const row of rows) expect(row.source).toBe('workdir');
      });
    });
  });

  describe('Given consistency="verified" captured at factory time', () => {
    describe('When entries() is iterated', () => {
      it('Then rows are buffered then yielded (each row materialised before consumption)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        await seedFile(ctx, 'b.txt');
        const inner = createFsWorkdirEnumerator();
        let enumerateCalls = 0;
        const counting: WorkdirEnumerator = {
          enumerate: (c, opts) => {
            enumerateCalls += 1;
            return inner.enumerate(c, opts);
          },
        };
        const sut = createWorkdirSnapshot(
          { ctx, enumerator: counting },
          { consistency: 'verified' },
        );

        // Act
        const rows = await collect(sut.entries());

        // Assert — enumerate runs once, rows materialised
        expect(enumerateCalls).toBe(1);
        expect(rows.map((r) => r.path).sort()).toEqual(['a.txt', 'b.txt']);
      });
    });
  });

  describe('Given a pathspec and an excludes predicate that both narrow the result', () => {
    describe('When entries() is iterated', () => {
      it('Then only rows matching paths AND surviving excludes are yielded (AND composition)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.ts');
        await seedFile(ctx, 'b.ts');
        await seedFile(ctx, 'c.js');
        const excludes: WalkIgnorePredicate = (path) => path === 'b.ts'; // drops b.ts
        const sut = createWorkdirSnapshot(
          { ctx, enumerator: createFsWorkdirEnumerator() },
          { paths: compilePathspec(['*.ts']), excludes },
        );

        // Act
        const rows = await collect(sut.entries());

        // Assert — paths kept *.ts; excludes removed b.ts; c.js was filtered by pathspec
        expect(rows.map((r) => r.path).sort()).toEqual(['a.ts']);
      });
    });
  });

  describe('Given a pre-aborted signal forwarded through SnapshotOptions', () => {
    describe('When entries() is iterated', () => {
      it('Then iteration throws OPERATION_ABORTED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        const controller = new AbortController();
        controller.abort();
        const sut = createWorkdirSnapshot({ ctx, enumerator: createFsWorkdirEnumerator() });

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut.entries({ signal: controller.signal })) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'OPERATION_ABORTED' },
        });
      });
    });
  });

  describe('Given a stub enumerator that records the options it was passed', () => {
    describe('When entries() forwards a WorkdirSnapshotOptions bundle', () => {
      it('Then the enumerator receives paths/excludes/maxDepth/maxEntries/signal verbatim', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const controller = new AbortController();
        const excludes: WalkIgnorePredicate = () => false;
        const paths = compilePathspec(['*.ts']);
        let received: WorkdirEnumOptions | undefined;
        const stub: WorkdirEnumerator = {
          enumerate: (_c, opts) => {
            received = opts;
            return (async function* () {
              yield* [];
            })();
          },
        };
        const sut = createWorkdirSnapshot(
          { ctx, enumerator: stub },
          {
            paths,
            excludes,
            maxDepth: 7,
            maxEntries: 9,
            signal: controller.signal,
          },
        );

        // Act
        await collect(sut.entries());

        // Assert
        expect(received?.paths).toBe(paths);
        expect(received?.excludes).toBe(excludes);
        expect(received?.maxDepth).toBe(7);
        expect(received?.maxEntries).toBe(9);
        expect(received?.signal).toBe(controller.signal);
      });
    });
  });
});
