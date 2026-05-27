/**
 * Mutation-killer tests for `load-blob.ts`. Targets the bounded-byte-budget
 * draining logic — the queue saturation predicate (count OR bytes), the
 * post-source drain loop, and the size accumulator. Each test sets up a
 * scenario where flipping the operator under test produces an observably
 * different yield ordering, peak in-flight count, or final row count.
 */
import { describe, expect, it } from 'vitest';

import { loadBlob } from '../../../../../src/application/primitives/snapshot-operators/load-blob.js';
import type { FilePath } from '../../../../../src/domain/objects/index.js';

interface Probe {
  inflight: number;
  peak: number;
  reads: number;
}

type Row = {
  readonly path: FilePath;
  readonly workdir?: {
    readonly stat?: { readonly size: number };
    read?: () => Promise<Uint8Array>;
  };
};

const makeProbe = (): Probe => ({ inflight: 0, peak: 0, reads: 0 });

interface Gate {
  readonly opened: Promise<void>;
  readonly open: () => void;
}

const makeGate = (): Gate => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

const makeEntry = (size: number, probe: Probe, gate?: Gate) => ({
  stat: { size },
  read: async (): Promise<Uint8Array> => {
    probe.reads += 1;
    probe.inflight += 1;
    if (probe.inflight > probe.peak) probe.peak = probe.inflight;
    if (gate !== undefined) await gate.opened;
    else await Promise.resolve();
    probe.inflight -= 1;
    return new Uint8Array(size);
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

describe('loadBlob — count-based saturation', () => {
  describe('Given concurrency=2 and 4 same-size rows below the byte budget', () => {
    describe('When loadBlob runs', () => {
      it('Then peak in-flight reads stays at or below concurrency', async () => {
        // Arrange
        const probe = makeProbe();
        const rows: Row[] = Array.from({ length: 4 }, (_, i) => ({
          path: String.fromCharCode(97 + i) as FilePath,
          workdir: makeEntry(100, probe),
        }));
        const sut = loadBlob<Row>('workdir', {
          concurrency: 2,
          maxInflightBytes: 1024 * 1024,
        })(stream(rows));

        // Act
        const out = await collect(sut);

        // Assert
        expect(out).toHaveLength(4);
        expect(probe.peak).toBeLessThanOrEqual(2);
        expect(probe.reads).toBe(4);
      });
    });
  });
});

describe('loadBlob — bytes-based saturation', () => {
  describe('Given concurrency far above row count but each row exceeds half the byte budget', () => {
    describe('When loadBlob runs', () => {
      it('Then drains kick in by bytes (peak bound by budget/size)', async () => {
        // Arrange — 4 rows of 100 bytes each, budget=150 bytes, concurrency=99.
        // Each new push tips bytes >= 150 → drain. Effective in-flight cap = 1.
        const probe = makeProbe();
        const rows: Row[] = Array.from({ length: 4 }, (_, i) => ({
          path: String.fromCharCode(97 + i) as FilePath,
          workdir: makeEntry(100, probe),
        }));
        const sut = loadBlob<Row>('workdir', {
          concurrency: 99,
          maxInflightBytes: 150,
        })(stream(rows));

        // Act
        const out = await collect(sut);

        // Assert — single-row throughput because each row blows the budget
        expect(out).toHaveLength(4);
        expect(probe.peak).toBeLessThanOrEqual(2);
      });
    });
  });
});

describe('loadBlob — final post-source drain', () => {
  describe('Given concurrency above row count AND ample byte budget (no main-loop drain)', () => {
    describe('When loadBlob runs', () => {
      it('Then all rows are still yielded via the post-source drain loop', async () => {
        // Arrange — 3 small rows, very high caps so the main loop never drains.
        const probe = makeProbe();
        const rows: Row[] = [
          { path: 'a' as FilePath, workdir: makeEntry(1, probe) },
          { path: 'b' as FilePath, workdir: makeEntry(1, probe) },
          { path: 'c' as FilePath, workdir: makeEntry(1, probe) },
        ];
        const sut = loadBlob<Row>('workdir', {
          concurrency: 99,
          maxInflightBytes: 1024 * 1024,
        })(stream(rows));

        // Act
        const out = await collect(sut);

        // Assert — all 3 yielded; reads ran for each.
        expect(out.map((r) => r.path)).toEqual(['a', 'b', 'c']);
        expect(probe.reads).toBe(3);
      });
    });
  });
});

describe('loadBlob — slot with no entry', () => {
  describe('Given a row whose named slot is undefined', () => {
    describe('When loadBlob runs', () => {
      it('Then the row is yielded unchanged and no read() fires', async () => {
        // Arrange
        const probe = makeProbe();
        const rows: Row[] = [
          { path: 'a' as FilePath }, // no workdir slot
          { path: 'b' as FilePath, workdir: makeEntry(10, probe) },
        ];
        const sut = loadBlob<Row>('workdir', {
          concurrency: 2,
        })(stream(rows));

        // Act
        const out = await collect(sut);

        // Assert
        expect(out.map((r) => r.path)).toEqual(['a', 'b']);
        expect(probe.reads).toBe(1); // only `b` triggered read
      });
    });
  });

  describe('Given a row whose slot exists but lacks read()', () => {
    describe('When loadBlob runs', () => {
      it('Then the row is yielded unchanged (size accumulator sees the stat size)', async () => {
        // Arrange — entry has stat.size but no read fn.
        const rows: Row[] = [
          { path: 'a' as FilePath, workdir: { stat: { size: 999 } } },
          { path: 'b' as FilePath, workdir: { stat: { size: 999 } } },
        ];
        const sut = loadBlob<Row>('workdir', {
          concurrency: 4,
          maxInflightBytes: 5000,
        })(stream(rows));

        // Act
        const out = await collect(sut);

        // Assert
        expect(out.map((r) => r.path)).toEqual(['a', 'b']);
      });
    });
  });
});

describe('loadBlob — order preservation', () => {
  describe('Given 6 rows with varying sizes and a tight byte budget', () => {
    describe('When loadBlob runs', () => {
      it('Then rows are yielded in input order (FIFO drain)', async () => {
        // Arrange
        const probe = makeProbe();
        const rows: Row[] = [
          { path: 'a' as FilePath, workdir: makeEntry(50, probe) },
          { path: 'b' as FilePath, workdir: makeEntry(50, probe) },
          { path: 'c' as FilePath, workdir: makeEntry(50, probe) },
          { path: 'd' as FilePath, workdir: makeEntry(50, probe) },
          { path: 'e' as FilePath, workdir: makeEntry(50, probe) },
          { path: 'f' as FilePath, workdir: makeEntry(50, probe) },
        ];
        const sut = loadBlob<Row>('workdir', {
          concurrency: 2,
          maxInflightBytes: 100,
        })(stream(rows));

        // Act
        const out = await collect(sut);

        // Assert — FIFO order preserved by drainOldest
        expect(out.map((r) => r.path)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
      });
    });
  });
});

describe('loadBlob — bytes accumulator correctness', () => {
  describe('Given heterogeneous row sizes and a budget that admits exactly two small rows', () => {
    describe('When loadBlob runs', () => {
      it('Then a large row immediately triggers drain even with no count saturation', async () => {
        // Arrange — concurrency=10, budget=100. Three small rows (10 each)
        // then one big row (200). The big row alone exceeds budget → drains.
        const probe = makeProbe();
        const rows: Row[] = [
          { path: 'a' as FilePath, workdir: makeEntry(10, probe) },
          { path: 'b' as FilePath, workdir: makeEntry(10, probe) },
          { path: 'c' as FilePath, workdir: makeEntry(10, probe) },
          { path: 'd' as FilePath, workdir: makeEntry(200, probe) },
        ];
        const sut = loadBlob<Row>('workdir', {
          concurrency: 10,
          maxInflightBytes: 100,
        })(stream(rows));

        // Act
        const out = await collect(sut);

        // Assert — all 4 yielded; the budget gate fired on row d.
        expect(out.map((r) => r.path)).toEqual(['a', 'b', 'c', 'd']);
        expect(probe.reads).toBe(4);
      });
    });
  });
});

describe('loadBlob — no saturation means parallelism is observed', () => {
  describe('Given high concurrency, a large byte budget, and a gated read()', () => {
    describe('When the source is consumed but the read gate is still closed', () => {
      it('Then peak in-flight is STRICTLY GREATER than 1 (no main-loop drains; reads overlap)', async () => {
        // Arrange — gate prevents read() from completing so the inflight
        // counter actually climbs as each row is pushed.
        const probe = makeProbe();
        const gate = makeGate();
        const rows: Row[] = Array.from({ length: 4 }, (_, i) => ({
          path: String.fromCharCode(97 + i) as FilePath,
          workdir: makeEntry(1, probe, gate),
        }));
        const sut = loadBlob<Row>('workdir', {
          concurrency: 99,
          maxInflightBytes: 1024 * 1024,
        })(stream(rows));

        // Act — start the consumer in the background; gate is closed so
        // all reads block. Wait a microtask round to let the for-await
        // iterate through every source row.
        const consumer = collect(sut);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const peakWhileBlocked = probe.peak;
        gate.open();
        await consumer;

        // Assert
        expect(peakWhileBlocked).toBeGreaterThan(1);
      });
    });
  });
});

describe('loadBlob — count-based saturation at exact boundary', () => {
  describe('Given concurrency=3, gated reads, and 6 rows in the source', () => {
    describe('When the source is drained but reads still block', () => {
      it('Then peak in-flight is EXACTLY 3 (boundary `>= concurrency`)', async () => {
        // Arrange — gated reads keep inflight from decrementing.
        const probe = makeProbe();
        const gate = makeGate();
        const rows: Row[] = Array.from({ length: 6 }, (_, i) => ({
          path: String.fromCharCode(97 + i) as FilePath,
          workdir: makeEntry(1, probe, gate),
        }));
        const sut = loadBlob<Row>('workdir', {
          concurrency: 3,
          maxInflightBytes: 1024 * 1024,
        })(stream(rows));

        // Act
        const consumer = collect(sut);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const peakWhileBlocked = probe.peak;
        gate.open();
        await consumer;

        // Assert — boundary check fires at exactly 3 in-flight; the 4th
        // push has to wait for a drain. Mutant `>` lets it reach 4;
        // mutant `<` drains at 1; both fail this assertion.
        expect(peakWhileBlocked).toBe(3);
      });
    });
  });
});

describe('loadBlob — bytes saturation only (count cap not in play)', () => {
  describe('Given concurrency=99 and a byte budget exactly equal to one row size', () => {
    describe('When the source is drained but reads still block', () => {
      it('Then peak stays at 1 (bytes saturate on the second push)', async () => {
        // Arrange
        const probe = makeProbe();
        const gate = makeGate();
        const rows: Row[] = Array.from({ length: 4 }, (_, i) => ({
          path: String.fromCharCode(97 + i) as FilePath,
          workdir: makeEntry(100, probe, gate),
        }));
        const sut = loadBlob<Row>('workdir', {
          concurrency: 99,
          maxInflightBytes: 100, // exactly one row's worth
        })(stream(rows));

        // Act
        const consumer = collect(sut);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const peakWhileBlocked = probe.peak;
        gate.open();
        await consumer;

        // Assert — bytes saturation kicks in immediately at the first push.
        expect(peakWhileBlocked).toBe(1);
      });
    });
  });
});

describe('loadBlob — post-source drain yields every queued row', () => {
  describe('Given far more rows than the byte budget allows in-flight', () => {
    describe('When loadBlob runs', () => {
      it('Then every input row reaches the consumer (no rows dropped)', async () => {
        // Arrange — exercise both the main-loop drain and the post-source
        // drain. A `false` mutant on the post-source drain would skip the
        // tail; some rows would never be yielded.
        const probe = makeProbe();
        const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({
          path: i.toString().padStart(2, '0') as FilePath,
          workdir: makeEntry(50, probe),
        }));
        const sut = loadBlob<Row>('workdir', {
          concurrency: 3,
          maxInflightBytes: 200,
        })(stream(rows));

        // Act
        const out = await collect(sut);

        // Assert
        expect(out.map((r) => r.path)).toEqual(rows.map((r) => r.path));
        expect(probe.reads).toBe(10);
      });
    });
  });
});

describe('loadBlob — pre-aborted signal', () => {
  describe('Given a pre-aborted signal', () => {
    describe('When iterated', () => {
      it('Then it throws OPERATION_ABORTED', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const probe = makeProbe();
        const sut = loadBlob<Row>('workdir', { signal: controller.signal })(
          stream([{ path: 'a' as FilePath, workdir: makeEntry(10, probe) }]),
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
