import { describe, expect, it } from 'vitest';

import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { sortPackIndexEntries } from '../../../../src/domain/storage/pack-order.js';
import { packIndexEntriesOf } from '../../../fixtures/storage/pack-index-entries.js';

const DIGEST_LENGTH = 20;

function makeEntry(id: string, offset = 0): { id: string; crc32: number; offset: number } {
  return { id, crc32: 0, offset };
}

describe('pack-order', () => {
  describe('sortPackIndexEntries', () => {
    describe('Given entries out of oid order', () => {
      describe('When sorting', () => {
        it('Then returns an order that reads the oids back ascending', () => {
          // Arrange
          const cc = makeEntry(`cc${'00'.repeat(19)}`);
          const aa = makeEntry(`aa${'00'.repeat(19)}`);
          const bb = makeEntry(`bb${'00'.repeat(19)}`);
          const entries = packIndexEntriesOf([cc, aa, bb], DIGEST_LENGTH);
          const sut = sortPackIndexEntries;

          // Act
          const result = sut(entries);

          // Assert
          const idsInOrder = Array.from(result.order, (k) =>
            entries.oids.subarray(k * DIGEST_LENGTH, (k + 1) * DIGEST_LENGTH),
          );
          expect(idsInOrder).toEqual([hexToBytes(aa.id), hexToBytes(bb.id), hexToBytes(cc.id)]);
        });

        it('Then each order position pairs with its own oid bytes', () => {
          // Arrange
          const aa = makeEntry(`aa${'00'.repeat(19)}`);
          const entries = packIndexEntriesOf([aa], DIGEST_LENGTH);
          const sut = sortPackIndexEntries;

          // Act
          const result = sut(entries);

          // Assert
          expect(result.order).toEqual(new Uint32Array([0]));
          expect(result.entries).toBe(entries);
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
          const first = packIndexEntriesOf([bb, cc, aa], DIGEST_LENGTH);
          const second = packIndexEntriesOf([cc, aa, bb], DIGEST_LENGTH);
          const sut = sortPackIndexEntries;

          // Act
          const firstResult = sut(first);
          const secondResult = sut(second);

          // Assert
          const idAt = (entries: typeof first, order: Uint32Array, p: number): Uint8Array => {
            const k = order[p]!;
            return entries.oids.subarray(k * DIGEST_LENGTH, (k + 1) * DIGEST_LENGTH);
          };
          const firstIds = [0, 1, 2].map((p) => idAt(first, firstResult.order, p));
          const secondIds = [0, 1, 2].map((p) => idAt(second, secondResult.order, p));
          expect(firstIds).toEqual(secondIds);
        });
      });
    });

    describe('Given no entries', () => {
      describe('When sorting', () => {
        it('Then returns an empty order', () => {
          // Arrange
          const entries = packIndexEntriesOf([], DIGEST_LENGTH);
          const sut = sortPackIndexEntries;

          // Act
          const result = sut(entries);

          // Assert
          expect(result.order).toEqual(new Uint32Array(0));
        });
      });
    });
  });
});
