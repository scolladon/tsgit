/**
 * Mutation-killer tests for `hash-slot.ts`. Targets the `inflight.length
 * >= concurrency` boundary by gating the hash() call so the queue can
 * actually climb. The strict-less / strict-greater / always-true / drain-
 * everything mutants each produce a distinct peak value.
 */
import { describe, expect, it } from 'vitest';

import { hashSlot } from '../../../../../src/application/primitives/snapshot-operators/hash-slot.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';

type Row = {
  readonly path: FilePath;
  readonly workdir?: { hash: () => Promise<ObjectId> };
};

interface HashGate {
  readonly opened: Promise<void>;
  readonly open: () => void;
}

const makeHashGate = (): HashGate => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

const probedRow = (
  path: string,
  state: { inflight: number; peak: number },
  gate?: HashGate,
): Row => ({
  path: path as FilePath,
  workdir: {
    hash: async (): Promise<ObjectId> => {
      state.inflight += 1;
      if (state.inflight > state.peak) state.peak = state.inflight;
      if (gate !== undefined) await gate.opened;
      else await Promise.resolve();
      state.inflight -= 1;
      return 'deadbeef' as ObjectId;
    },
  },
});

const stream = <T>(rows: ReadonlyArray<T>): AsyncIterable<T> =>
  (async function* () {
    for (const r of rows) yield r;
  })();

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('hashSlot — concurrency boundary at concurrency=2', () => {
  describe('Given gated hash() calls and 6 rows', () => {
    describe('When the source is drained but hash() still blocks', () => {
      it('Then peak in-flight is EXACTLY 2 (boundary `>= concurrency`)', async () => {
        // Arrange
        const state = { inflight: 0, peak: 0 };
        const gate = makeHashGate();
        const rows: Row[] = Array.from({ length: 6 }, (_, i) =>
          probedRow(String.fromCharCode(97 + i), state, gate),
        );
        const sut = hashSlot<Row>('workdir', { concurrency: 2 })(stream(rows));

        // Act
        const consumer = collect(sut);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const peakWhileBlocked = state.peak;
        gate.open();
        const out = await consumer;

        // Assert
        expect(peakWhileBlocked).toBe(2);
        expect(out).toHaveLength(6);
      });
    });
  });
});

describe('hashSlot — concurrency=1 (strictly serial)', () => {
  describe('Given gated hash() and 4 rows', () => {
    describe('When the source is drained', () => {
      it('Then peak in-flight is EXACTLY 1', async () => {
        // Arrange
        const state = { inflight: 0, peak: 0 };
        const gate = makeHashGate();
        const rows: Row[] = Array.from({ length: 4 }, (_, i) =>
          probedRow(String.fromCharCode(97 + i), state, gate),
        );
        const sut = hashSlot<Row>('workdir', { concurrency: 1 })(stream(rows));

        // Act
        const consumer = collect(sut);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const peakWhileBlocked = state.peak;
        gate.open();
        await consumer;

        // Assert
        expect(peakWhileBlocked).toBe(1);
      });
    });
  });
});

describe('hashSlot — concurrency above row count (no main-loop drain)', () => {
  describe('Given concurrency=4, 3 rows, and gated hash()', () => {
    describe('When the source is drained', () => {
      it('Then peak equals the row count (all hashes overlap)', async () => {
        // Arrange
        const state = { inflight: 0, peak: 0 };
        const gate = makeHashGate();
        const rows: Row[] = Array.from({ length: 3 }, (_, i) =>
          probedRow(String.fromCharCode(97 + i), state, gate),
        );
        const sut = hashSlot<Row>('workdir', { concurrency: 4 })(stream(rows));

        // Act
        const consumer = collect(sut);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const peakWhileBlocked = state.peak;
        gate.open();
        await consumer;

        // Assert — `true` mutant would force peak=1; `<` mutant would force peak=1.
        expect(peakWhileBlocked).toBe(3);
      });
    });
  });
});

describe('hashSlot — slot absent', () => {
  describe('Given a row whose slot is undefined', () => {
    describe('When hashSlot runs', () => {
      it('Then the row is yielded without invoking hash()', async () => {
        // Arrange
        let hashCalls = 0;
        const rows: Row[] = [
          { path: 'a' as FilePath },
          {
            path: 'b' as FilePath,
            workdir: {
              hash: async () => {
                hashCalls += 1;
                return 'oid' as ObjectId;
              },
            },
          },
        ];
        const sut = hashSlot<Row>('workdir', { concurrency: 2 })(stream(rows));

        // Act
        const out = await collect(sut);

        // Assert
        expect(out.map((r) => r.path)).toEqual(['a', 'b']);
        expect(hashCalls).toBe(1);
      });
    });
  });
});
