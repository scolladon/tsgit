/**
 * The grammar-level contract of `iterateReftableRefsFrom`, which the example
 * file next to it fixes at one shape (600 refs, 256-byte blocks, restart
 * interval 4). Two properties: the walk is a TOTAL function over any table
 * the writer accepts and any floor over the ref-name alphabet, and the names
 * it yields are exactly the names at or after that floor — whatever block
 * boundary, restart interval or index depth sits between them.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MemoryCompressor } from '../../../../../src/adapters/memory/memory-compressor.js';
import type { RefName } from '../../../../../src/domain/objects/index.js';
import { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { ReftableRefRecord } from '../../../../../src/domain/refs/reftable/reftable-block.js';
import {
  iterateReftableRefs,
  iterateReftableRefsFrom,
} from '../../../../../src/domain/refs/reftable/reftable-block.js';
import { parseReftable } from '../../../../../src/domain/refs/reftable/reftable-format.js';
import { serializeReftable } from '../../../../../src/domain/refs/reftable/reftable-writer.js';

const compressor = new MemoryCompressor();

/** Composition / invariant tier. */
const RUNS = 100;

const OID = ObjectId.fromRaw(new Uint8Array(20).fill(0x11));

/** Ref names of a drawn width, so a run exercises both short keys (many per
 *  block) and long ones (few per block, deeper index). */
const arbNames = (): fc.Arbitrary<ReadonlyArray<RefName>> =>
  fc
    .record({
      width: fc.integer({ min: 3, max: 40 }),
      count: fc.integer({ min: 1, max: 400 }),
    })
    .map(({ width, count }) =>
      Array.from(
        { length: count },
        (_, index) => `refs/heads/${'n'.repeat(width)}${String(index).padStart(5, '0')}` as RefName,
      ),
    );

/** Block size and restart interval together decide how many blocks a table
 *  has and how deep its ref index descends; `0` leaves the table unaligned,
 *  which has no index at all. */
const arbLayout = (): fc.Arbitrary<{ blockSize: number; restartInterval: number }> =>
  fc.record({
    blockSize: fc.constantFrom(0, 128, 256, 1024, 4096),
    restartInterval: fc.integer({ min: 1, max: 16 }),
  });

const buildTable = async (
  names: ReadonlyArray<RefName>,
  layout: { blockSize: number; restartInterval: number },
) => {
  const refs: ReftableRefRecord[] = names.map((name) => ({
    name,
    updateIndex: 1n,
    value: { kind: 'direct', id: OID },
  }));
  const bytes = await serializeReftable(
    refs,
    [],
    {
      hashId: 'sha1',
      blockSize: layout.blockSize,
      restartInterval: layout.restartInterval,
      indexObjects: false,
      minUpdateIndex: 1n,
      maxUpdateIndex: 1n,
    },
    compressor.deflate,
  );
  return parseReftable(bytes);
};

describe('reftable seek properties', () => {
  describe('Given an arbitrary table and an arbitrary floor over the ref-name alphabet', () => {
    describe('When the seeked walk runs', () => {
      it('Then it yields exactly the names at or after the floor, in order', async () => {
        // Arrange
        const sut = iterateReftableRefsFrom;

        // Act + Assert
        await fc.assert(
          fc.asyncProperty(
            arbNames(),
            arbLayout(),
            fc.string({ minLength: 0, maxLength: 24 }),
            async (names, layout, suffix) => {
              const table = await buildTable(names, layout);
              const all = [...iterateReftableRefs(table)].map((entry) => entry.name);
              const floor = `refs/heads/${suffix}` as RefName;

              const seen = [...sut(table, floor)].map((entry) => entry.name);

              expect(seen).toEqual(all.filter((name) => name >= floor));
            },
          ),
          { numRuns: RUNS },
        );
      });
    });

    describe('When the walk is seeked to a name the table carries', () => {
      it('Then that name is the first one it yields', async () => {
        // Arrange
        const sut = iterateReftableRefsFrom;

        // Act + Assert
        await fc.assert(
          fc.asyncProperty(arbNames(), arbLayout(), fc.nat(), async (names, layout, pick) => {
            const table = await buildTable(names, layout);
            const all = [...iterateReftableRefs(table)].map((entry) => entry.name);
            const target = all[pick % all.length] as RefName;

            const seen = [...sut(table, target)].map((entry) => entry.name);

            expect(seen[0]).toBe(target);
            expect(seen).toHaveLength(all.length - all.indexOf(target));
          }),
          { numRuns: RUNS },
        );
      });
    });
  });
});
