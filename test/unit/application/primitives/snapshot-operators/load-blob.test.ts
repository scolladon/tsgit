import { describe, expect, it } from 'vitest';
import { defaultLimitFor } from '../../../../../src/application/primitives/internal/concurrency.js';
import { loadBlob } from '../../../../../src/application/primitives/snapshot-operators/load-blob.js';
import type { FilePath } from '../../../../../src/domain/objects/index.js';

interface Probe {
  inflight: number;
  peak: number;
}

interface Gate {
  readonly opened: Promise<void>;
  readonly open: () => void;
}

type Row = {
  readonly path: FilePath;
  readonly workdir?: { stat?: { size: number }; read: () => Promise<Uint8Array> };
};

const makeProbe = (): Probe => ({ inflight: 0, peak: 0 });

const makeGate = (): Gate => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

/** Each row is 1 byte — well under any budget this suite exercises, so only
 *  the count-based saturation predicate governs the peak. */
const probedRow = (path: string, probe: Probe, gate: Gate): Row => ({
  path: path as FilePath,
  workdir: {
    stat: { size: 1 },
    read: async (): Promise<Uint8Array> => {
      probe.inflight += 1;
      if (probe.inflight > probe.peak) probe.peak = probe.inflight;
      await gate.opened;
      probe.inflight -= 1;
      return new Uint8Array(1);
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

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('loadBlob — concurrency default', () => {
  describe('Given opts.concurrency is set', () => {
    describe('When loadBlob runs', () => {
      it('Then it wins over the derived bound', async () => {
        // Arrange — the derived floor for ioBound is 4; an explicit
        // concurrency of 6 must still be honoured over that floor.
        const probe = makeProbe();
        const gate = makeGate();
        const rows = Array.from({ length: 8 }, (_unused, i) => probedRow(`p${i}`, probe, gate));
        const sut = loadBlob<Row>('workdir', {
          concurrency: 6,
          maxInflightBytes: 1024 * 1024,
        })(stream(rows));

        // Act
        const consumer = collect(sut);
        await settle();
        const peakWhileBlocked = probe.peak;
        gate.open();
        await consumer;

        // Assert
        expect(peakWhileBlocked).toBe(6);
      });
    });
  });

  describe('Given opts.concurrency is absent', () => {
    describe('When loadBlob runs', () => {
      it('Then the derived bound is used', async () => {
        // Arrange
        const probe = makeProbe();
        const gate = makeGate();
        const rows = Array.from({ length: 8 }, (_unused, i) => probedRow(`p${i}`, probe, gate));
        const sut = loadBlob<Row>('workdir', { maxInflightBytes: 1024 * 1024 })(stream(rows));

        // Act
        const consumer = collect(sut);
        await settle();
        const peakWhileBlocked = probe.peak;
        gate.open();
        await consumer;

        // Assert
        expect(peakWhileBlocked).toBe(defaultLimitFor('ioBound'));
      });
    });
  });
});
