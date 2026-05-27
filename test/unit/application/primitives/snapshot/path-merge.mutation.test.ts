/**
 * Mutation-killer tests for `path-merge.ts`. Targets:
 *  - the `entry.path < previousPath` strict-less comparison in advanceCursor
 *  - the `done: false` initial cursor state
 *  - the `path < min` strict-less comparison in minPath
 *  - the `row.path < previous` strict-less comparison in assertOrdered
 *
 * Each test contrasts a strict-less mutant (e.g. `<=`) with the original
 * by feeding equal consecutive paths from the SAME source (which is
 * legitimate — a snapshot is allowed to yield duplicate paths in
 * pathological cases that the merge still handles by collapsing into the
 * row build, never by re-throwing on equality).
 */
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

describe('path-merge — strict-less in advanceCursor (entry.path < previousPath)', () => {
  describe('Given a source that emits the same path twice in a row', () => {
    describe('When pathMerge processes it', () => {
      it('Then it does NOT throw (a `<=` mutant would treat equality as out-of-order)', async () => {
        // Arrange — two rows with identical path is unusual but legal: the
        // strict-less comparison treats equality as in-order. A mutant
        // `entry.path <= previousPath` would throw on the second equal row.
        const dup = stubSnapshot([treeRow('p.txt'), treeRow('p.txt')]);

        // Act + Assert — pathMerge yields once per cursor advance; a
        // single-source merge over two identical paths emits TWO rows.
        // The strict-less mutant would throw on the second row when the
        // new path is not strictly greater than the previous.
        const rows = await collect(pathMerge({ dup }, ['dup'], undefined, 'outer'));
        expect(rows.map((r) => r.path)).toEqual(['p.txt', 'p.txt']);
      });
    });
  });
});

describe('path-merge — strict-less in minPath', () => {
  describe('Given two cursors whose first paths are equal', () => {
    describe('When pathMerge picks the minimum', () => {
      it('Then both cursors contribute to the same first row (equality is not "strictly less")', async () => {
        // Arrange — both cursors yield 'p.txt' first. minPath should
        // return 'p.txt' from whichever cursor wins; both slots populate.
        const a = stubSnapshot([treeRow('p.txt'), treeRow('z.txt')]);
        const b = stubSnapshot([treeRow('p.txt'), treeRow('y.txt')]);

        // Act
        const rows = await collect(pathMerge({ a, b }, ['a', 'b'], undefined, 'outer'));

        // Assert — first row has both slots populated; final row count = 3.
        expect(rows.map((r) => r.path)).toEqual(['p.txt', 'y.txt', 'z.txt']);
        const first = rows[0] as Record<string, unknown> | undefined;
        expect(first?.['a']).toBeDefined();
        expect(first?.['b']).toBeDefined();
      });
    });
  });
});

describe('path-merge — initial cursor done=false', () => {
  describe('Given a single-source merge over a non-empty snapshot', () => {
    describe('When pathMerge runs', () => {
      it('Then it yields exactly the rows from that source (cursor starts in not-done state)', async () => {
        // Arrange — a mutant flipping the initial done state would short-
        // circuit the merge and yield nothing.
        const one = stubSnapshot([treeRow('a.txt'), treeRow('b.txt')]);

        // Act
        const rows = await collect(pathMerge({ one }, ['one'], undefined, 'outer'));

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['a.txt', 'b.txt']);
      });
    });
  });
});

describe('assertOrdered — strict-less', () => {
  describe('Given a stream with consecutive duplicates', () => {
    describe('When assertOrdered observes them', () => {
      it('Then it does NOT throw (equality is not strictly less)', async () => {
        // Arrange + Act + Assert
        const rows = [treeRow('p.txt'), treeRow('p.txt'), treeRow('q.txt')];
        const out = await collect(
          assertOrdered(
            (async function* () {
              for (const r of rows) yield r;
            })(),
          ),
        );
        expect(out.map((r) => r.path)).toEqual(['p.txt', 'p.txt', 'q.txt']);
      });
    });
  });
});
