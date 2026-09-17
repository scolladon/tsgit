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

const NAME_PREFIX = 'refs/heads/';
const NAME_SUFFIX_WIDTH = 5;
/** An index level has to be strictly smaller than the level below it, which
 *  needs a block wide enough for two summary keys. The writer refuses a
 *  narrower one outright, so the generator stays on its safe subset. */
const INDEX_ENTRY_OVERHEAD = 24;

interface SeekScenario {
  readonly names: ReadonlyArray<RefName>;
  readonly blockSize: number;
  readonly restartInterval: number;
}

/** Ref names of a drawn width, paired with a block size wide enough to
 *  summarise them: short keys pack many per block (deep index, many
 *  boundaries to cross), long ones few (shallow index, wide blocks).
 *  `blockSize` 0 leaves the table unaligned, which has no index at all. */
const arbScenario = (): fc.Arbitrary<SeekScenario> =>
  fc
    .record({
      width: fc.integer({ min: 3, max: 40 }),
      count: fc.integer({ min: 1, max: 400 }),
      blockSize: fc.constantFrom(0, 128, 256, 1024, 4096),
      restartInterval: fc.integer({ min: 1, max: 16 }),
    })
    .filter(({ width, blockSize }) => {
      const nameLength = NAME_PREFIX.length + width + NAME_SUFFIX_WIDTH;
      return blockSize === 0 || blockSize >= 2 * nameLength + INDEX_ENTRY_OVERHEAD;
    })
    .map(({ width, count, blockSize, restartInterval }) => ({
      names: Array.from(
        { length: count },
        (_, index) =>
          `${NAME_PREFIX}${'n'.repeat(width)}${String(index).padStart(NAME_SUFFIX_WIDTH, '0')}` as RefName,
      ),
      blockSize,
      restartInterval,
    }));

/** A floor to seek to, chosen once the table's own names are known: a free
 *  name over the alphabet, or the gap immediately after one of the names the
 *  table carries — the gap is what lands a floor past the last key of the
 *  block the index points at, so the walk has to continue into the next. */
const arbFloor = (): fc.Arbitrary<(names: ReadonlyArray<RefName>) => RefName> =>
  fc.oneof(
    fc
      .string({ minLength: 0, maxLength: 24 })
      .map((suffix) => () => `${NAME_PREFIX}${suffix}` as RefName),
    fc
      .nat()
      .map(
        (pick) => (names: ReadonlyArray<RefName>) => `${names[pick % names.length]}~` as RefName,
      ),
  );

const buildTable = async (scenario: SeekScenario) => {
  const refs: ReftableRefRecord[] = scenario.names.map((name) => ({
    name,
    updateIndex: 1n,
    value: { kind: 'direct', id: OID },
  }));
  const bytes = await serializeReftable(
    refs,
    [],
    {
      hashId: 'sha1',
      blockSize: scenario.blockSize,
      restartInterval: scenario.restartInterval,
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
          fc.asyncProperty(arbScenario(), arbFloor(), async (scenario, chooseFloor) => {
            const table = await buildTable(scenario);
            const all = [...iterateReftableRefs(table)].map((entry) => entry.name);
            const floor = chooseFloor(all);

            const seen = [...sut(table, floor)].map((entry) => entry.name);

            expect(seen).toEqual(all.filter((name) => name >= floor));
          }),
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
          fc.asyncProperty(arbScenario(), fc.nat(), async (scenario, pick) => {
            const table = await buildTable(scenario);
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
