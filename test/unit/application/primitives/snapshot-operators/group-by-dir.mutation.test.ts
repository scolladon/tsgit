/**
 * Explicit mutation-killer tests for `group-by-dir.ts`. Each test pins
 * both group count AND group identity so that any mutant producing a
 * different number of groups or a stale/null path fails.
 */
import { describe, expect, it } from 'vitest';

import { groupByDir } from '../../../../../src/application/primitives/snapshot-operators/group-by-dir.js';
import type { FilePath } from '../../../../../src/domain/objects/index.js';

type Row = { readonly path: FilePath };

const stream = <T>(rows: ReadonlyArray<T>): AsyncIterable<T> =>
  (async function* () {
    for (const r of rows) yield r;
  })();

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('groupByDir — exact group count + identity', () => {
  describe('Given rows across 3 directories', () => {
    describe('When groupByDir runs', () => {
      it('Then it yields exactly 3 groups in directory order with correct row counts', async () => {
        // Arrange
        const sut = groupByDir<Row>()(
          stream([
            { path: 'a/1.txt' as FilePath },
            { path: 'a/2.txt' as FilePath },
            { path: 'b/1.txt' as FilePath },
            { path: 'b/2.txt' as FilePath },
            { path: 'c/1.txt' as FilePath },
          ]),
        );

        // Act
        const groups = await collect(sut);

        // Assert — exact count, exact paths, exact row counts per group
        expect(groups).toHaveLength(3);
        expect(groups[0]?.path).toBe('a');
        expect(groups[0]?.rows).toHaveLength(2);
        expect(groups[1]?.path).toBe('b');
        expect(groups[1]?.rows).toHaveLength(2);
        expect(groups[2]?.path).toBe('c');
        expect(groups[2]?.rows).toHaveLength(1);
      });
    });
  });

  describe('Given a single row in a single directory', () => {
    describe('When groupByDir runs', () => {
      it('Then it yields exactly 1 group with that path and 1 row', async () => {
        // Arrange
        const sut = groupByDir<Row>()(stream([{ path: 'x/only.txt' as FilePath }]));

        // Act
        const groups = await collect(sut);

        // Assert
        expect(groups).toHaveLength(1);
        expect(groups[0]?.path).toBe('x');
        expect(groups[0]?.rows).toHaveLength(1);
        expect(groups[0]?.rows[0]?.path).toBe('x/only.txt');
      });
    });
  });

  describe('Given an empty source', () => {
    describe('When groupByDir runs', () => {
      it('Then it yields zero groups', async () => {
        // Arrange
        const sut = groupByDir<Row>()(stream([] as ReadonlyArray<Row>));

        // Act
        const groups = await collect(sut);

        // Assert
        expect(groups).toEqual([]);
      });
    });
  });

  describe('Given a stream that transitions from root to a subdirectory', () => {
    describe('When groupByDir runs', () => {
      it('Then the first group is the root ("") and the second is the subdirectory', async () => {
        // Arrange — ordered: root entries first (path '' < path 'sub/...').
        const sut = groupByDir<Row>()(
          stream([{ path: 'a.txt' as FilePath }, { path: 'sub/inner.txt' as FilePath }]),
        );

        // Act
        const groups = await collect(sut);

        // Assert
        expect(groups).toHaveLength(2);
        expect(groups[0]?.path).toBe('');
        expect(groups[1]?.path).toBe('sub');
      });
    });
  });

  describe('Given a stream of out-of-order rows', () => {
    describe('When groupByDir runs', () => {
      it('Then it throws ORDER_INVARIANT_VIOLATION with pinned previous/current', async () => {
        // Arrange
        const sut = groupByDir<Row>()(
          stream([{ path: 'b/1.txt' as FilePath }, { path: 'a/1.txt' as FilePath }]),
        );

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: {
            code: 'ORDER_INVARIANT_VIOLATION',
            previous: 'b/1.txt',
            current: 'a/1.txt',
          },
        });
      });
    });
  });
});
