import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { ObjectId, type RefName } from '../../../../src/domain/objects/index.js';
import {
  iterateReftableRefsFrom,
  parseReftable,
  type Reftable,
  type ReftableRefRecord,
} from '../../../../src/domain/refs/index.js';
import { serializeReftable } from '../../../../src/domain/refs/reftable/reftable-writer.js';

/**
 * Wall-clock guard for the seeked ref walk. This is a PERFORMANCE test, not a
 * unit test: it asserts an elapsed-time budget, which is load-dependent and so
 * lives in the dedicated `perf` project (`npm run test:perf`) that Stryker
 * never mutates.
 *
 * The walk used to reach the block the seek landed in by re-enumerating the
 * section from its FIRST block and discarding every block before it, so a run
 * of seeks cost the whole section once per seek.
 */
const REF_COUNT = 20_000;
const SMALL_BLOCK_SIZE = 256;
const RESTART_INTERVAL = 4;
/** Measured on an idle machine: 114 ms continuing forward against 2 006 ms
 *  re-enumerating from the first block — 17.6x. The budget sits seven times
 *  above the first and two and a half times below the second, so a loaded
 *  machine does not flake it and the regression still fails it. */
const BUDGET_MS = 800;

const oid = (n: number): ObjectId =>
  ObjectId.fromRaw(new Uint8Array(20).fill(0).map((_unused, i) => (i === 19 ? n % 251 : 0x11)));

const refName = (index: number): RefName =>
  `refs/heads/b${String(index).padStart(5, '0')}` as RefName;

const buildTable = async (): Promise<Reftable> => {
  const ctx = createMemoryContext();
  const refs: ReftableRefRecord[] = Array.from({ length: REF_COUNT }, (_unused, index) => ({
    name: refName(index),
    updateIndex: 1n,
    value: { kind: 'direct' as const, id: oid(index) },
  }));
  const bytes = await serializeReftable(
    refs,
    [],
    {
      hashId: 'sha1',
      blockSize: SMALL_BLOCK_SIZE,
      restartInterval: RESTART_INTERVAL,
      indexObjects: true,
      minUpdateIndex: 1n,
      maxUpdateIndex: 1n,
    },
    ctx.compressor.deflate,
  );
  return parseReftable(bytes);
};

describe('iterateReftableRefsFrom (performance)', () => {
  describe('Given a table whose refs span hundreds of indexed blocks', () => {
    describe('When one seek is made per ref and only its first record taken', () => {
      it('Then the whole run finishes inside a per-seek budget', async () => {
        // Arrange
        const table = await buildTable();
        const sut = iterateReftableRefsFrom;

        // Act
        const start = performance.now();
        let landed = 0;
        for (let index = 0; index < REF_COUNT; index += 1) {
          const [first] = sut(table, refName(index));
          if (first?.name === refName(index)) landed += 1;
        }
        const elapsedMs = performance.now() - start;

        // Assert — every seek landed on its own name, and quickly.
        expect(landed).toBe(REF_COUNT);
        expect(elapsedMs).toBeLessThan(BUDGET_MS);
      });
    });
  });
});
