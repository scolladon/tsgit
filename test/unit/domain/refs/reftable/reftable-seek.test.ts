/**
 * The seeked ref walk `iterateReftableRefsFrom` gives the stack: it must land
 * on the first name at or after the floor whatever block that name falls in —
 * the block the index points at, the one after it, or none at all — and it
 * must reach that name without decoding the records before it.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import type { RefName } from '../../../../../src/domain/objects/index.js';
import { ObjectId } from '../../../../../src/domain/objects/index.js';
import {
  iterateReftableRefs,
  iterateReftableRefsFrom,
  parseReftable,
  type Reftable,
  type ReftableRefRecord,
} from '../../../../../src/domain/refs/index.js';
import { serializeReftable } from '../../../../../src/domain/refs/reftable/reftable-writer.js';

/** Small enough that a few hundred refs span many blocks, so the seek has
 *  real block boundaries to cross. */
const SMALL_BLOCK_SIZE = 256;
const RESTART_INTERVAL = 4;
const REF_COUNT = 600;

const oid = (n: number): ObjectId =>
  ObjectId.fromRaw(new Uint8Array(20).fill(0).map((_, i) => (i === 19 ? n % 251 : 0x11)));

const refName = (index: number): RefName =>
  `refs/heads/b${String(index).padStart(5, '0')}` as RefName;

const record = (index: number): ReftableRefRecord => ({
  name: refName(index),
  updateIndex: 1n,
  value: { kind: 'direct', id: oid(index) },
});

/** One table holding `REF_COUNT` name-sorted refs across many small blocks. */
const buildTable = async (): Promise<Reftable> => {
  const ctx = createMemoryContext();
  const refs = Array.from({ length: REF_COUNT }, (_, index) => record(index));
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

const namesFrom = (table: Reftable, from: string): ReadonlyArray<string> =>
  [...iterateReftableRefsFrom(table, from as RefName)].map((entry) => entry.name);

describe('reftable — the seeked ref walk', () => {
  describe('Given a table whose refs span many blocks', () => {
    describe('When the walk is seeked to a name the table carries', () => {
      it('Then it yields that name and every name after it, in order', async () => {
        // Arrange
        const table = await buildTable();
        const sut = iterateReftableRefsFrom;

        // Act
        const seen = [...sut(table, refName(REF_COUNT - 3))].map((entry) => entry.name);

        // Assert
        expect(seen).toEqual([
          refName(REF_COUNT - 3),
          refName(REF_COUNT - 2),
          refName(REF_COUNT - 1),
        ]);
      });
    });

    describe('When the walk is seeked to every possible floor between names', () => {
      it('Then each one starts exactly where the full walk would', async () => {
        // Arrange — `<name>~` sorts strictly after `<name>` and before its
        // successor, so every floor lands between two records; the loop
        // crosses every block boundary the table has.
        const table = await buildTable();
        const all = [...iterateReftableRefs(table)].map((entry) => entry.name);
        const sut = namesFrom;

        // Act
        const mismatches = all.filter(
          (name, index) => sut(table, `${name}~`)[0] !== (all[index + 1] ?? undefined),
        );

        // Assert
        expect(mismatches).toEqual([]);
      });
    });

    describe('When the walk is seeked past every name the table carries', () => {
      it('Then it yields nothing', async () => {
        // Arrange
        const table = await buildTable();
        const sut = namesFrom;

        // Act
        const seen = sut(table, 'refs/zzz');

        // Assert
        expect(seen).toEqual([]);
      });
    });

    describe('When the walk is seeked before every name the table carries', () => {
      it('Then it yields every name', async () => {
        // Arrange
        const table = await buildTable();
        const sut = namesFrom;

        // Act
        const seen = sut(table, 'refs/aaa');

        // Assert
        expect(seen).toHaveLength(REF_COUNT);
        expect(seen[0]).toBe(refName(0));
      });
    });

    describe('When the walk is seeked near the end of the ref space', () => {
      it('Then it decodes far fewer records than the full walk does', async () => {
        // Arrange — every live ref record decodes one object id, so the
        // `fromRaw` count is the record-decode count.
        const table = await buildTable();
        const sut = namesFrom;

        // Act
        const full = countDecodes(() => {
          for (const _entry of iterateReftableRefs(table)) {
            // drain
          }
        });
        const seeked = countDecodes(() => sut(table, refName(REF_COUNT - 2)));

        // Assert
        expect(full).toBeGreaterThanOrEqual(REF_COUNT);
        expect(seeked * 4).toBeLessThan(full);
      });
    });
  });
});

/** How many object ids `run` decodes — one per ref record it reads. */
const countDecodes = (run: () => void): number => {
  const original = ObjectId.fromRaw;
  let calls = 0;
  (ObjectId as { fromRaw: typeof ObjectId.fromRaw }).fromRaw = (bytes) => {
    calls += 1;
    return original(bytes);
  };
  try {
    run();
  } finally {
    (ObjectId as { fromRaw: typeof ObjectId.fromRaw }).fromRaw = original;
  }
  return calls;
};
