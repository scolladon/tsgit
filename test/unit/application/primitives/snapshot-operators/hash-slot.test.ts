import { describe, expect, it } from 'vitest';
import { defaultLimitFor } from '../../../../../src/application/primitives/internal/concurrency.js';
import { hashSlot } from '../../../../../src/application/primitives/snapshot-operators/hash-slot.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';

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
  readonly workdir?: { hash: () => Promise<ObjectId> };
};

const makeProbe = (): Probe => ({ inflight: 0, peak: 0 });

const makeGate = (): Gate => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

const probedRow = (path: string, probe: Probe, gate: Gate): Row => ({
  path: path as FilePath,
  workdir: {
    hash: async (): Promise<ObjectId> => {
      probe.inflight += 1;
      if (probe.inflight > probe.peak) probe.peak = probe.inflight;
      await gate.opened;
      probe.inflight -= 1;
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

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('hashSlot — concurrency default', () => {
  describe('Given opts.concurrency is set', () => {
    describe('When hashSlot runs', () => {
      it('Then it wins over the derived bound', async () => {
        // Arrange — the derived floor for cpuBound is 1; an explicit
        // concurrency of 3 must still be honoured over that floor.
        const probe = makeProbe();
        const gate = makeGate();
        const rows = Array.from({ length: 6 }, (_unused, i) => probedRow(`p${i}`, probe, gate));
        const sut = hashSlot<Row>('workdir', { concurrency: 3 })(stream(rows));

        // Act
        const consumer = collect(sut);
        await settle();
        const peakWhileBlocked = probe.peak;
        gate.open();
        await consumer;

        // Assert
        expect(peakWhileBlocked).toBe(3);
      });
    });
  });

  describe('Given opts.concurrency is absent', () => {
    describe('When hashSlot runs', () => {
      it('Then the derived bound is used', async () => {
        // Arrange
        const probe = makeProbe();
        const gate = makeGate();
        const rows = Array.from({ length: 6 }, (_unused, i) => probedRow(`p${i}`, probe, gate));
        const sut = hashSlot<Row>('workdir', {})(stream(rows));

        // Act
        const consumer = collect(sut);
        await settle();
        const peakWhileBlocked = probe.peak;
        gate.open();
        await consumer;

        // Assert
        expect(peakWhileBlocked).toBe(defaultLimitFor('cpuBound'));
      });
    });
  });
});
