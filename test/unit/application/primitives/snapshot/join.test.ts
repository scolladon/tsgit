import { describe, expect, it } from 'vitest';

import { innerJoin, join } from '../../../../../src/application/primitives/snapshot/join.js';
import type {
  Snapshot,
  SnapshotEntry,
} from '../../../../../src/application/primitives/snapshot/snapshot.js';
import type { FilePath } from '../../../../../src/domain/objects/index.js';

const stubSnapshot = <E extends SnapshotEntry>(rows: ReadonlyArray<E>): Snapshot<E> => ({
  kind: 'tree',
  entries: () =>
    (async function* () {
      for (const r of rows) yield r;
    })(),
});

const row = (path: string): SnapshotEntry =>
  ({
    source: 'tree',
    path: path as FilePath,
    oid: 'deadbeef' as never,
    mode: '100644' as never,
    kind: 'file',
    read: async () => new Uint8Array(),
  }) as unknown as SnapshotEntry;

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('join', () => {
  describe('Given a single-source join', () => {
    describe('When iterated', () => {
      it('Then it yields one row per entry with that slot populated (short-circuit path)', async () => {
        // Arrange
        const sut = join({ tree: stubSnapshot([row('a'), row('b')]) });

        // Act
        const rows = await collect(sut);

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['a', 'b']);
        expect((rows[0] as Record<string, unknown>)['tree']).toBeDefined();
      });
    });
  });

  describe('Given a two-source outer join with overlapping paths', () => {
    describe('When iterated', () => {
      it('Then it yields rows in path order with slots populated only where present', async () => {
        // Arrange
        const sut = join({
          head: stubSnapshot([row('a'), row('h-only'), row('shared')]),
          index: stubSnapshot([row('i-only'), row('shared')]),
        });

        // Act
        const rows = await collect(sut);

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['a', 'h-only', 'i-only', 'shared']);
        const shared = rows.find((r) => r.path === 'shared') as Record<string, unknown> | undefined;
        expect(shared?.['head']).toBeDefined();
        expect(shared?.['index']).toBeDefined();
      });
    });
  });
});

describe('innerJoin', () => {
  describe('Given two sources sharing only one path', () => {
    describe('When iterated', () => {
      it('Then it yields only that shared path with every slot populated', async () => {
        // Arrange
        const sut = innerJoin({
          head: stubSnapshot([row('h-only'), row('shared')]),
          index: stubSnapshot([row('i-only'), row('shared')]),
        });

        // Act
        const rows = await collect(sut);

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['shared']);
        const r = rows[0] as Record<string, unknown> | undefined;
        expect(r?.['head']).toBeDefined();
        expect(r?.['index']).toBeDefined();
      });
    });
  });
});

describe('join with a pre-aborted signal', () => {
  describe('Given a single-source join and an already-aborted signal', () => {
    describe('When iterated', () => {
      it('Then it throws OPERATION_ABORTED at the first yield', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const sut = join({ tree: stubSnapshot([row('a')]) }, { signal: controller.signal });

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'OPERATION_ABORTED' },
        });
      });
    });
  });

  describe('Given a two-source join and an already-aborted signal', () => {
    describe('When iterated', () => {
      it('Then the signal is forwarded to pathMerge and OPERATION_ABORTED is raised', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const sut = join(
          { head: stubSnapshot([row('a')]), index: stubSnapshot([row('b')]) },
          { signal: controller.signal },
        );

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'OPERATION_ABORTED' },
        });
      });
    });
  });
});

describe('innerJoin with a pre-aborted signal', () => {
  describe('Given two sources and an already-aborted signal', () => {
    describe('When iterated', () => {
      it('Then it throws OPERATION_ABORTED (signal forwarded through innerJoin)', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const sut = innerJoin(
          { head: stubSnapshot([row('shared')]), index: stubSnapshot([row('shared')]) },
          { signal: controller.signal },
        );

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'OPERATION_ABORTED' },
        });
      });
    });
  });
});
