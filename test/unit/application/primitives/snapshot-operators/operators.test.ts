import { describe, expect, it } from 'vitest';

import {
  count,
  first,
  groupByDir,
  hashSlot,
  hashWorkdir,
  toArray,
  verifyWorkdir,
} from '../../../../../src/application/primitives/snapshot-operators/index.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';

type Row = {
  readonly path: FilePath;
  readonly workdir?: {
    hash?: () => Promise<ObjectId>;
    read?: () => Promise<Uint8Array>;
    verify?: () => Promise<void>;
    stat?: { size: number };
  };
};

const stream = <T>(rows: ReadonlyArray<T>): AsyncIterable<T> =>
  (async function* () {
    for (const r of rows) yield r;
  })();

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('hashSlot / hashWorkdir', () => {
  describe('Given rows whose workdir slot exposes hash()', () => {
    describe('When hashWorkdir runs over the stream', () => {
      it('Then every row passes through and hash() is invoked exactly once per entry', async () => {
        // Arrange
        let calls = 0;
        const oid = 'deadbeef' as ObjectId;
        const r1: Row = {
          path: 'a' as FilePath,
          workdir: {
            hash: async () => {
              calls += 1;
              return oid;
            },
          },
        };
        const r2: Row = {
          path: 'b' as FilePath,
          workdir: {
            hash: async () => {
              calls += 1;
              return oid;
            },
          },
        };
        const sut = hashWorkdir<Row>({})(stream([r1, r2]));

        // Act
        const out = await collect(sut);

        // Assert
        expect(out.map((r) => r.path)).toEqual(['a', 'b']);
        expect(calls).toBe(2);
      });
    });
  });

  describe('Given a stream of out-of-order rows', () => {
    describe('When hashSlot runs', () => {
      it('Then it throws ORDER_INVARIANT_VIOLATION', async () => {
        // Arrange
        const sut = hashSlot<Row>(
          'workdir',
          {},
        )(
          stream([
            { path: 'z' as FilePath, workdir: { hash: async () => 'a' as ObjectId } },
            { path: 'a' as FilePath, workdir: { hash: async () => 'b' as ObjectId } },
          ]),
        );

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'ORDER_INVARIANT_VIOLATION', previous: 'z', current: 'a' },
        });
      });
    });
  });
});

describe('verifyWorkdir', () => {
  describe('Given a row whose workdir entry verify() throws', () => {
    describe('When onRace="throw" (default)', () => {
      it('Then the error propagates', async () => {
        // Arrange
        const failing = new Error('race');
        const rows: Row[] = [
          {
            path: 'a' as FilePath,
            workdir: {
              verify: async () => {
                throw failing;
              },
            },
          },
        ];
        const sut = verifyWorkdir<Row>()(stream(rows));

        // Act + Assert
        await expect(collect(sut)).rejects.toBe(failing);
      });
    });

    describe('When onRace="skip"', () => {
      it('Then the racy row is dropped silently', async () => {
        // Arrange
        const rows: Row[] = [
          {
            path: 'a' as FilePath,
            workdir: {
              verify: async () => {
                throw new Error('race');
              },
            },
          },
          { path: 'b' as FilePath, workdir: { verify: async () => undefined } },
        ];
        const sut = verifyWorkdir<Row>({ onRace: 'skip' })(stream(rows));

        // Act
        const out = await collect(sut);

        // Assert
        expect(out.map((r) => r.path)).toEqual(['b']);
      });
    });

    describe('When onRace="emit"', () => {
      it('Then the row is yielded with _raced: true and others stream through normally', async () => {
        // Arrange
        const rows: Row[] = [
          {
            path: 'a' as FilePath,
            workdir: {
              verify: async () => {
                throw new Error('race');
              },
            },
          },
          { path: 'b' as FilePath, workdir: { verify: async () => undefined } },
        ];
        const sut = verifyWorkdir<Row>({ onRace: 'emit' })(stream(rows));

        // Act
        const out = await collect(sut);

        // Assert
        expect(out).toHaveLength(2);
        expect((out[0] as Record<string, unknown>)['_raced']).toBe(true);
        expect((out[1] as Record<string, unknown>)['_raced']).toBeUndefined();
      });
    });
  });
});

describe('groupByDir', () => {
  describe('Given an ordered stream of paths across two directories', () => {
    describe('When groupByDir runs', () => {
      it('Then it yields one DirGroup per directory with the contained rows', async () => {
        // Arrange
        const sut = groupByDir<Row>()(
          stream([
            { path: 'a/1.txt' as FilePath },
            { path: 'a/2.txt' as FilePath },
            { path: 'b/1.txt' as FilePath },
          ]),
        );

        // Act
        const groups = await collect(sut);

        // Assert
        expect(groups.map((g) => g.path)).toEqual(['a', 'b']);
        expect(groups[0]?.rows.map((r) => r.path)).toEqual(['a/1.txt', 'a/2.txt']);
        expect(groups[1]?.rows.map((r) => r.path)).toEqual(['b/1.txt']);
      });
    });
  });

  describe('Given paths in the root directory (no slash)', () => {
    describe('When groupByDir runs', () => {
      it('Then the empty-string directory is yielded as the root group', async () => {
        // Arrange
        const sut = groupByDir<Row>()(
          stream([{ path: 'a.txt' as FilePath }, { path: 'b.txt' as FilePath }]),
        );

        // Act
        const groups = await collect(sut);

        // Assert
        expect(groups).toHaveLength(1);
        expect(groups[0]?.path).toBe('');
        expect(groups[0]?.rows).toHaveLength(2);
      });
    });
  });
});

describe('terminals', () => {
  describe('Given a 3-row stream', () => {
    describe('When count is called', () => {
      it('Then it returns 3', async () => {
        // Arrange
        const sut = stream([
          { path: 'a' as FilePath },
          { path: 'b' as FilePath },
          { path: 'c' as FilePath },
        ]);

        // Act
        const result = await count(sut);

        // Assert
        expect(result).toBe(3);
      });
    });

    describe('When toArray is called', () => {
      it('Then it returns the rows in order', async () => {
        // Arrange
        const rows = [{ path: 'a' as FilePath } as Row, { path: 'b' as FilePath } as Row];
        const sut = stream(rows);

        // Act
        const result = await toArray(sut);

        // Assert
        expect(result).toEqual(rows);
      });
    });

    describe('When first is called', () => {
      it('Then it returns the first row and disposes the iterator', async () => {
        // Arrange
        let disposed = false;
        const iterable: AsyncIterable<Row> = {
          [Symbol.asyncIterator]: () => {
            let yielded = false;
            return {
              next: async () => {
                if (yielded) return { value: undefined as never, done: true };
                yielded = true;
                return { value: { path: 'a' as FilePath } as Row, done: false };
              },
              return: async () => {
                disposed = true;
                return { value: undefined as never, done: true };
              },
            };
          },
        };

        // Act
        const result = await first(iterable);

        // Assert
        expect(result?.path).toBe('a');
        expect(disposed).toBe(true);
      });
    });

    describe('When first is called on an empty stream', () => {
      it('Then it returns null', async () => {
        // Arrange
        const sut = stream([]);

        // Act
        const result = await first(sut);

        // Assert
        expect(result).toBeNull();
      });
    });
  });

  describe('Given a pre-aborted signal', () => {
    describe('When count is awaited', () => {
      it('Then it throws OPERATION_ABORTED', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const sut = stream([{ path: 'a' as FilePath }, { path: 'b' as FilePath }]);

        // Act + Assert
        await expect(count(sut, { signal: controller.signal })).rejects.toMatchObject({
          data: { code: 'OPERATION_ABORTED' },
        });
      });
    });

    describe('When toArray is awaited', () => {
      it('Then it throws OPERATION_ABORTED', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const sut = stream([{ path: 'a' as FilePath } as Row]);

        // Act + Assert
        await expect(toArray(sut, { signal: controller.signal })).rejects.toMatchObject({
          data: { code: 'OPERATION_ABORTED' },
        });
      });
    });

    describe('When first is awaited on a non-empty stream', () => {
      it('Then it throws OPERATION_ABORTED', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const sut = stream([{ path: 'a' as FilePath } as Row]);

        // Act + Assert
        await expect(first(sut, { signal: controller.signal })).rejects.toMatchObject({
          data: { code: 'OPERATION_ABORTED' },
        });
      });
    });
  });
});

describe('Given a pre-aborted signal forwarded to hashSlot', () => {
  describe('When iterated', () => {
    it('Then it throws OPERATION_ABORTED', async () => {
      // Arrange
      const controller = new AbortController();
      controller.abort();
      const sut = hashSlot<Row>('workdir', { signal: controller.signal })(
        stream([{ path: 'a' as FilePath, workdir: { hash: async () => 'a' as ObjectId } }]),
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

describe('Given a pre-aborted signal forwarded to verifyWorkdir', () => {
  describe('When iterated', () => {
    it('Then it throws OPERATION_ABORTED', async () => {
      // Arrange
      const controller = new AbortController();
      controller.abort();
      const sut = verifyWorkdir<Row>({ signal: controller.signal })(
        stream([{ path: 'a' as FilePath, workdir: { verify: async () => undefined } }]),
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
