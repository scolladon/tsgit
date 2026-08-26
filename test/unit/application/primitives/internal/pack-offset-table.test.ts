import { describe, expect, it, vi } from 'vitest';
import type { ArtefactLoad } from '../../../../../src/application/primitives/internal/pack-artefact-source.js';
import {
  nextOffsetForEntry,
  resolveOffsetTable,
} from '../../../../../src/application/primitives/internal/pack-offset-table.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { ObjectId } from '../../../../../src/domain/objects/object-id.js';
import {
  invalidPackRevIndex,
  type PackIndex,
  type PackRevIndex,
  parsePackIndex,
  parsePackRevIndex,
  REASON_REV_INDEX_CORRUPT,
} from '../../../../../src/domain/storage/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import {
  buildRevIndex,
  buildTestIndex,
  type TestIndexEntry,
} from '../../../domain/storage/arbitraries.js';

const DIGEST_LENGTH = 20;

function makeEntry(id: string, offset: number): TestIndexEntry {
  return { id: id as ObjectId, offset, crc32: 0 };
}

/** A hex id whose ordinal grows with `i`, so entries built from an ascending
 *  `i` sort into the SAME order by oid as by array position — index position
 *  `i` then holds exactly `offsets[i]`, and a test can reason about "index
 *  position" and "array position" as the same thing. */
function oidAt(i: number): string {
  return `${(0x10 + i).toString(16).padStart(2, '0')}${'0'.repeat(38)}`;
}

function entriesWithOffsets(offsets: ReadonlyArray<number>): TestIndexEntry[] {
  return offsets.map((offset, i) => makeEntry(oidAt(i), offset));
}

function buildIndex(offsets: ReadonlyArray<number>): PackIndex {
  return parsePackIndex(buildTestIndex(entriesWithOffsets(offsets)), DIGEST_LENGTH);
}

function buildRev(body: ReadonlyArray<number>): PackRevIndex {
  const bytes = buildRevIndex({
    hashId: 1,
    digestLength: DIGEST_LENGTH,
    body,
    packChecksum: new Uint8Array(DIGEST_LENGTH),
  });
  return parsePackRevIndex(bytes, DIGEST_LENGTH, body.length);
}

const usableLoad =
  (rev: PackRevIndex): (() => Promise<ArtefactLoad<PackRevIndex>>) =>
  async () => ({ kind: 'usable', value: rev, bytes: new Uint8Array(0) });

const absentLoad = async (): Promise<ArtefactLoad<PackRevIndex>> => ({ kind: 'absent' });

const unreadableLoad = async (): Promise<ArtefactLoad<PackRevIndex>> => ({ kind: 'unreadable' });

const refusedLoad = async (): Promise<ArtefactLoad<PackRevIndex>> => ({
  kind: 'refused',
  data: invalidPackRevIndex('size', REASON_REV_INDEX_CORRUPT).data,
});

const contextWith = (warn: ReturnType<typeof vi.fn>): Context =>
  ({ logger: { warn } }) as unknown as Context;

describe('resolveOffsetTable', () => {
  describe('Given a pack with a usable .rev', () => {
    describe('When the offset table is resolved', () => {
      it('Then it answers lazily and never materialises a sorted-offset table', async () => {
        // Arrange
        const index = buildIndex([12, 50, 90, 140]);
        const rev = buildRev([0, 1, 2, 3]);
        const sut = resolveOffsetTable;

        // Act
        const result = await sut(
          contextWith(vi.fn()),
          'pack-lazy',
          index,
          usableLoad(rev),
          220,
          200,
        );

        // Assert — the lazy arm structurally carries no sortedOffsets field,
        // so this is proof no eager table was built, not merely an unread one.
        expect(result.kind).toBe('lazy');
        expect(Object.hasOwn(result, 'sortedOffsets')).toBe(false);
      });
    });
  });

  describe('Given a pack whose .rev is absent', () => {
    describe('When the offset table is resolved and every entry is queried', () => {
      it('Then the fallback table answers the same successor offset the ascending order implies', async () => {
        // Arrange
        const index = buildIndex([30, 10, 70, 50]);
        const sut = resolveOffsetTable;

        // Act
        const table = await sut(contextWith(vi.fn()), 'pack-absent', index, absentLoad, 220, 200);

        // Assert — 10→30→50→70→trailerStart(200), the sort's own order
        expect(table.kind).toBe('sorted');
        expect(nextOffsetForEntry(table, 10)).toBe(30);
        expect(nextOffsetForEntry(table, 30)).toBe(50);
        expect(nextOffsetForEntry(table, 50)).toBe(70);
        expect(nextOffsetForEntry(table, 70)).toBe(200);
      });
    });
  });

  describe('Given a pack whose .rev is unreadable', () => {
    describe('When the offset table is resolved', () => {
      it('Then it falls back to the sort in silence — cannot-tell is not corrupt', async () => {
        // Arrange
        const index = buildIndex([30, 10, 70, 50]);
        const warn = vi.fn();
        const sut = resolveOffsetTable;

        // Act
        const result = await sut(
          contextWith(warn),
          'pack-unreadable',
          index,
          unreadableLoad,
          220,
          200,
        );

        // Assert
        expect(result.kind).toBe('sorted');
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a pack whose .rev is refused', () => {
    describe('When the offset table is resolved', () => {
      it('Then it falls back to the sort and warns once, naming the artefact', async () => {
        // Arrange
        const index = buildIndex([30, 10, 70, 50]);
        const warn = vi.fn();
        const sut = resolveOffsetTable;

        // Act
        const result = await sut(contextWith(warn), 'pack-refused', index, refusedLoad, 220, 200);

        // Assert
        expect(result.kind).toBe('sorted');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toMatchObject({
          rev: 'pack-refused.rev',
          reason: REASON_REV_INDEX_CORRUPT,
        });
      });
    });
  });
});

describe('nextOffsetForEntry — the lazy .rev-backed path', () => {
  describe('Given a pack whose .rev holds an out-of-range position', () => {
    describe('When the successor of the entry at that position is requested', () => {
      it('Then the pack degrades to the fallback instead of throwing', async () => {
        // Arrange — pack position 0's stored index position (4) names no
        // object of a 4-entry index; positions 1-3 are correct.
        const offsets = [12, 50, 90, 140];
        const index = buildIndex(offsets);
        const rev = buildRev([offsets.length, 1, 2, 3]);
        const table = await resolveOffsetTable(
          contextWith(vi.fn()),
          'pack-oob',
          index,
          usableLoad(rev),
          220,
          200,
        );
        const sut = nextOffsetForEntry;

        // Act
        const result = sut(table, 12);

        // Assert — the .rev was usable, so the table itself is still lazy…
        expect(table.kind).toBe('lazy');
        // …but the corrupt position degrades THIS query to the correct,
        // sort-derived answer rather than throwing.
        expect(result).toBe(50);
      });
    });
  });

  describe('Given a pack with large offsets (MSB set in the .idx)', () => {
    describe('When the successor of the entry before it is requested', () => {
      it('Then the successor is the large offset, read through the same indirection the .idx lookup uses', async () => {
        // Arrange
        const smallOffset = 100;
        const largeOffset = 0x200000000;
        const index = buildIndex([smallOffset, largeOffset]);
        const rev = buildRev([0, 1]);
        const table = await resolveOffsetTable(
          contextWith(vi.fn()),
          'pack-large',
          index,
          usableLoad(rev),
          largeOffset + 28,
          largeOffset + 8,
        );
        const sut = nextOffsetForEntry;

        // Act
        const result = sut(table, smallOffset);

        // Assert
        expect(table.kind).toBe('lazy');
        expect(result).toBe(largeOffset);
      });
    });
  });

  describe('Given a lazy table and an offset absent from it', () => {
    describe('When nextOffsetForEntry is called', () => {
      it('Then it throws INVALID_PACK_INDEX with reason "offset not in pack index: corrupt index"', async () => {
        // Arrange
        const index = buildIndex([10, 30, 50]);
        const rev = buildRev([0, 1, 2]);
        const table = await resolveOffsetTable(
          contextWith(vi.fn()),
          'pack-x',
          index,
          usableLoad(rev),
          90,
          70,
        );
        const sut = nextOffsetForEntry;

        // Act
        let caught: unknown;
        try {
          sut(table, 20);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — .data (code AND reason), never the class
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_PACK_INDEX');
        if (data.code === 'INVALID_PACK_INDEX') {
          expect(data.reason).toBe('offset not in pack index: corrupt index');
        }
      });
    });
  });
});

describe('nextOffsetForEntry — the sorted fallback path', () => {
  describe('Given a sorted table and an offset absent from it', () => {
    describe('When nextOffsetForEntry is called', () => {
      it('Then it throws INVALID_PACK_INDEX with reason "offset not in pack index: corrupt index"', async () => {
        // Arrange
        const index = buildIndex([10, 30, 50]);
        const table = await resolveOffsetTable(
          contextWith(vi.fn()),
          'pack-y',
          index,
          absentLoad,
          90,
          70,
        );
        const sut = nextOffsetForEntry;

        // Act
        let caught: unknown;
        try {
          sut(table, 20);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — .data (code AND reason), never the class
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_PACK_INDEX');
        if (data.code === 'INVALID_PACK_INDEX') {
          expect(data.reason).toBe('offset not in pack index: corrupt index');
        }
      });
    });
  });
});
