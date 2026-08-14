import { describe, expect, it } from 'vitest';

import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { sortPackIndexEntries } from '../../../../src/domain/storage/pack-order.js';
import type { PackIndexWriterEntry } from '../../../../src/domain/storage/pack-writer.js';

function makeEntry(id: string, offset = 0): PackIndexWriterEntry {
  return { id, crc32: 0, offset };
}

describe('pack-order', () => {
  describe('sortPackIndexEntries', () => {
    describe('Given entries out of oid order', () => {
      describe('When sorting', () => {
        it('Then returns them oid-ascending', () => {
          // Arrange
          const cc = makeEntry(`cc${'00'.repeat(19)}`);
          const aa = makeEntry(`aa${'00'.repeat(19)}`);
          const bb = makeEntry(`bb${'00'.repeat(19)}`);
          const sut = sortPackIndexEntries;

          // Act
          const result = sut([cc, aa, bb]);

          // Assert
          expect(result.map((e) => e.entry.id)).toEqual([aa.id, bb.id, cc.id]);
        });

        it('Then pairs each entry with its own raw oid bytes', () => {
          // Arrange
          const aa = makeEntry(`aa${'00'.repeat(19)}`);
          const sut = sortPackIndexEntries;

          // Act
          const result = sut([aa]);

          // Assert
          expect(result[0]!.shaBytes).toEqual(hexToBytes(aa.id));
          expect(result[0]!.entry).toBe(aa);
        });
      });
    });

    describe('Given distinct oids fed in every relative order', () => {
      describe('When sorting a shuffled and its reverse', () => {
        it('Then produces the same total order regardless of input order', () => {
          // Arrange
          const aa = makeEntry(`aa${'00'.repeat(19)}`);
          const bb = makeEntry(`bb${'00'.repeat(19)}`);
          const cc = makeEntry(`cc${'00'.repeat(19)}`);
          const sut = sortPackIndexEntries;

          // Act
          const first = sut([bb, cc, aa]);
          const second = sut([cc, aa, bb]);

          // Assert
          expect(first.map((e) => e.entry.id)).toEqual(second.map((e) => e.entry.id));
        });
      });
    });

    describe('Given no entries', () => {
      describe('When sorting', () => {
        it('Then returns an empty array', () => {
          // Arrange
          const sut = sortPackIndexEntries;

          // Act
          const result = sut([]);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });
  });
});
