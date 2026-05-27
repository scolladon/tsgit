import { describe, expect, it } from 'vitest';

import {
  assertOrdered,
  pathMerge,
} from '../../../../../src/application/primitives/snapshot/path-merge.js';
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

const treeRow = (path: string): SnapshotEntry =>
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

describe('pathMerge', () => {
  describe('Given three sources with overlapping and unique paths', () => {
    describe('When pathMerge runs in outer mode', () => {
      it('Then it yields the union of paths in canonical order with per-slot population', async () => {
        // Arrange
        const a = stubSnapshot([treeRow('a.txt'), treeRow('b.txt')]);
        const b = stubSnapshot([treeRow('b.txt'), treeRow('c.txt')]);
        const c = stubSnapshot([treeRow('a.txt'), treeRow('d.txt')]);

        // Act
        const rows = await collect(pathMerge({ a, b, c }, ['a', 'b', 'c'], undefined, 'outer'));

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
        // Path 'b.txt' is present in slots a + b but not c
        const bRow = rows.find((r) => r.path === 'b.txt') as Record<string, unknown> | undefined;
        expect(bRow?.['a']).toBeDefined();
        expect(bRow?.['b']).toBeDefined();
        expect(bRow?.['c']).toBeUndefined();
      });
    });

    describe('When pathMerge runs in inner mode', () => {
      it('Then it yields only paths present in every source', async () => {
        // Arrange
        const a = stubSnapshot([treeRow('a.txt'), treeRow('shared.txt')]);
        const b = stubSnapshot([treeRow('b.txt'), treeRow('shared.txt')]);
        const c = stubSnapshot([treeRow('shared.txt')]);

        // Act
        const rows = await collect(pathMerge({ a, b, c }, ['a', 'b', 'c'], undefined, 'inner'));

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['shared.txt']);
      });
    });
  });

  describe('Given a source that yields rows out of order', () => {
    describe('When pathMerge consumes it', () => {
      it('Then it throws ORDER_INVARIANT_VIOLATION naming the offending pair', async () => {
        // Arrange
        const out = stubSnapshot([treeRow('b.txt'), treeRow('a.txt')]); // descending
        const ok = stubSnapshot([treeRow('a.txt')]);

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of pathMerge({ out, ok }, ['out', 'ok'], undefined, 'outer')) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'ORDER_INVARIANT_VIOLATION', previous: 'b.txt', current: 'a.txt' },
        });
      });
    });
  });

  describe('Given a pre-aborted signal', () => {
    describe('When pathMerge is iterated', () => {
      it('Then it throws OPERATION_ABORTED before yielding any row', async () => {
        // Arrange
        const a = stubSnapshot([treeRow('a.txt')]);
        const controller = new AbortController();
        controller.abort();

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of pathMerge({ a }, ['a'], controller.signal, 'outer')) {
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

describe('assertOrdered', () => {
  describe('Given a stream of rows in canonical order', () => {
    describe('When assertOrdered wraps it', () => {
      it('Then every row is passed through unchanged', async () => {
        // Arrange
        const rows = [treeRow('a.txt'), treeRow('b.txt'), treeRow('c.txt')];
        const sut = assertOrdered(
          (async function* () {
            for (const r of rows) yield r;
          })(),
        );

        // Act
        const out = await collect(sut);

        // Assert
        expect(out.map((r) => r.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
      });
    });
  });

  describe('Given a stream with a descending path', () => {
    describe('When assertOrdered observes the reorder', () => {
      it('Then it throws ORDER_INVARIANT_VIOLATION', async () => {
        // Arrange
        const rows = [treeRow('z.txt'), treeRow('a.txt')];
        const sut = assertOrdered(
          (async function* () {
            for (const r of rows) yield r;
          })(),
        );

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'ORDER_INVARIANT_VIOLATION' },
        });
      });
    });
  });
});
