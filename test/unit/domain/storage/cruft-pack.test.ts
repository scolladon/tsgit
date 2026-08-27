import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import {
  parseCruftMtimes,
  serializeCruftMtimes,
} from '../../../../src/domain/storage/cruft-pack.js';
import type { CruftMtimesCheck } from '../../../../src/domain/storage/error.js';
import { sortPackIndexEntries } from '../../../../src/domain/storage/pack-order.js';
import type { PackIndexWriterEntry } from '../../../../src/domain/storage/pack-writer.js';

// --- Fixture helpers -------------------------------------------------------

function fourEntries(): PackIndexWriterEntry[] {
  return [
    { id: `aa${'00'.repeat(19)}`, crc32: 0, offset: 10 },
    { id: `bb${'00'.repeat(19)}`, crc32: 0, offset: 40 },
    { id: `cc${'00'.repeat(19)}`, crc32: 0, offset: 20 },
    { id: `dd${'00'.repeat(19)}`, crc32: 0, offset: 30 },
  ];
}

// Real bytes, `git gc` over a repo with 4 unreachable objects sharing one
// forced mtime — every field of a 68-byte SHA-1 sidecar.
const PIN_P_HEADER_BODY_CHECKSUM_HEX =
  '4d544d45' +
  '00000001' +
  '00000001' +
  '6a8ef72a'.repeat(4) +
  'a204c436941c335bcc59e413fe79e7fa46d2c380';
const PIN_P_SELF_CHECKSUM_HEX = '5bfde0b728b507a500a7ba48c7daef7fc8ae844f';
const PIN_P_PACK_CHECKSUM = hexToBytes('a204c436941c335bcc59e413fe79e7fa46d2c380');
const PIN_P_MTIME = 0x6a8ef72a;

function pokeByte(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  copy[offset] = value;
  return copy;
}

function pokeUint32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value);
  return copy;
}

function expectRefusal(act: () => unknown, check: CruftMtimesCheck, reasonContains: string): void {
  // Captured OUTSIDE the try — an expect.fail thrown inside would be
  // swallowed by this function's own catch.
  let caught: unknown;
  try {
    act();
  } catch (e) {
    caught = e;
  }
  if (caught === undefined) {
    expect.fail('Should have thrown');
  }
  const data = (caught as TsgitError).data;
  if (data.code !== 'INVALID_CRUFT_MTIMES') {
    expect.fail(`expected INVALID_CRUFT_MTIMES, got ${data.code}`);
  }
  expect(data.check).toBe(check);
  expect(data.reason).toContain(reasonContains);
}

describe('cruft-pack', () => {
  describe('serializeCruftMtimes', () => {
    describe('Given the Pin P fixture (4 objects sharing one mtime, SHA-1)', () => {
      describe('When serializing', () => {
        it('Then bytes [0, 48) equal the real git sidecar and bytes [48, 68) are zero', () => {
          // Arrange
          const entries = fourEntries();
          const sut = serializeCruftMtimes;

          // Act
          const result = sut(entries, PIN_P_PACK_CHECKSUM, () => PIN_P_MTIME);

          // Assert
          expect(result.length).toBe(68);
          expect(result.subarray(0, 48)).toEqual(hexToBytes(PIN_P_HEADER_BODY_CHECKSUM_HEX));
          expect(result.subarray(48, 68)).toEqual(new Uint8Array(20));
        });
      });
    });

    describe('Given three oids with non-monotonic mtimes and offsets that disagree with oid order', () => {
      describe('When serializing', () => {
        it('Then each mtime lands at its OID rank, never its pack-offset rank', () => {
          // Arrange — offset-ascending order is e522 < 862d < 77a2, the
          // reverse of oid-ascending order (77a2 < 862d < e522). An
          // offset-indexed implementation places 1785538860 at position 0;
          // the correct, oid-indexed one places 1767225660 there.
          const entries: PackIndexWriterEntry[] = [
            { id: '77a24379436bd40df5c2c855e8a0c11408109968', crc32: 0, offset: 300 },
            { id: '862dcbda8e8d9fa19e65785e262f33b03c1e9156', crc32: 0, offset: 200 },
            { id: 'e522cdc3d5447b9b90ab38314fd550b036d1168f', crc32: 0, offset: 100 },
          ];
          const mtimeByOid = new Map<string, number>([
            ['77a24379436bd40df5c2c855e8a0c11408109968', 1767225660],
            ['862dcbda8e8d9fa19e65785e262f33b03c1e9156', 1787754322],
            ['e522cdc3d5447b9b90ab38314fd550b036d1168f', 1785538860],
          ]);
          const packChecksum = new Uint8Array(20).fill(0xab);
          const sut = serializeCruftMtimes;

          // Act
          const result = sut(entries, packChecksum, (oid) => mtimeByOid.get(oid)!);

          // Assert
          const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
          expect(view.getUint32(12)).toBe(1767225660);
          expect(view.getUint32(16)).toBe(1787754322);
          expect(view.getUint32(20)).toBe(1785538860);
        });
      });
    });

    describe('Given a 32-byte (SHA-256) checksum and 3 entries', () => {
      describe('When serializing', () => {
        it('Then hashId is 2 and size is 12 + 4N + 64', () => {
          // Arrange
          const entries: PackIndexWriterEntry[] = [
            { id: `aa${'00'.repeat(19)}`, crc32: 0, offset: 10 },
            { id: `bb${'00'.repeat(19)}`, crc32: 0, offset: 20 },
            { id: `cc${'00'.repeat(19)}`, crc32: 0, offset: 5 },
          ];
          const packChecksum = new Uint8Array(32).fill(0xcc);
          const sut = serializeCruftMtimes;

          // Act
          const result = sut(entries, packChecksum, () => 1);

          // Assert
          const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
          expect(view.getUint32(8)).toBe(2);
          expect(result.length).toBe(12 + 4 * 3 + 64);
          expect(result.subarray(12 + 4 * 3, 12 + 4 * 3 + 32)).toEqual(packChecksum);
        });
      });
    });

    describe('Given a packChecksum of 0 bytes', () => {
      describe('When serializing', () => {
        it('Then refuses with hash-id rather than truncating', () => {
          // Arrange
          const entries = [{ id: `aa${'00'.repeat(19)}`, crc32: 0, offset: 1 }];

          // Act & Assert
          expectRefusal(
            () => serializeCruftMtimes(entries, new Uint8Array(0), () => 0),
            'hash-id',
            'got 0',
          );
        });
      });
    });

    describe('Given a packChecksum of 33 bytes', () => {
      describe('When serializing', () => {
        it('Then refuses with hash-id rather than truncating', () => {
          // Arrange
          const entries = [{ id: `aa${'00'.repeat(19)}`, crc32: 0, offset: 1 }];

          // Act & Assert
          expectRefusal(
            () => serializeCruftMtimes(entries, new Uint8Array(33), () => 0),
            'hash-id',
            'got 33',
          );
        });
      });
    });

    describe('Given a presorted entry list computed by the caller', () => {
      describe('When serializing with it', () => {
        it('Then the body is identical to the unsorted call — the sort is reused, not repeated', () => {
          // Arrange
          const entries = fourEntries();
          const presorted = sortPackIndexEntries(entries);
          const sut = serializeCruftMtimes;

          // Act
          const withPresorted = sut(entries, PIN_P_PACK_CHECKSUM, () => PIN_P_MTIME, presorted);
          const withoutPresorted = sut(entries, PIN_P_PACK_CHECKSUM, () => PIN_P_MTIME);

          // Assert
          expect(withPresorted).toEqual(withoutPresorted);
        });
      });
    });

    describe('Given 0 entries', () => {
      describe('When serializing', () => {
        it('Then produces 52 bytes (header + empty body + checksum + zeroed self-checksum)', () => {
          // Arrange
          const packChecksum = new Uint8Array(20).fill(0xaa);
          const sut = serializeCruftMtimes;

          // Act
          const result = sut([], packChecksum, () => 0);

          // Assert
          expect(result.length).toBe(52);
          expect(result.subarray(12, 32)).toEqual(packChecksum);
          expect(result.subarray(32, 52)).toEqual(new Uint8Array(20));
        });
      });
    });
  });

  describe('parseCruftMtimes', () => {
    describe('Given the Pin P fixture bytes with the real self-checksum', () => {
      describe('When parsing with a matching selfChecksum', () => {
        it('Then every oid maps to the shared mtime and the checksum is accepted', () => {
          // Arrange
          const bytes = hexToBytes(PIN_P_HEADER_BODY_CHECKSUM_HEX + PIN_P_SELF_CHECKSUM_HEX);
          const oidsInIndexOrder = [
            `aa${'00'.repeat(19)}`,
            `bb${'00'.repeat(19)}`,
            `cc${'00'.repeat(19)}`,
            `dd${'00'.repeat(19)}`,
          ] as ObjectId[];
          const selfChecksum = hexToBytes(PIN_P_SELF_CHECKSUM_HEX);
          const sut = parseCruftMtimes;

          // Act
          const result = sut(bytes, oidsInIndexOrder, selfChecksum);

          // Assert
          expect(result.size).toBe(4);
          for (const oid of oidsInIndexOrder) {
            expect(result.get(oid)).toBe(PIN_P_MTIME);
          }
        });
      });
    });

    describe('Given the non-monotonic 3-oid fixture', () => {
      describe('When serializing then parsing with the .idx oid list', () => {
        it('Then each oid recovers exactly its own mtime — not its neighbour’s', () => {
          // Arrange
          const entries: PackIndexWriterEntry[] = [
            { id: '77a24379436bd40df5c2c855e8a0c11408109968', crc32: 0, offset: 300 },
            { id: '862dcbda8e8d9fa19e65785e262f33b03c1e9156', crc32: 0, offset: 200 },
            { id: 'e522cdc3d5447b9b90ab38314fd550b036d1168f', crc32: 0, offset: 100 },
          ];
          const mtimeByOid = new Map<string, number>([
            ['77a24379436bd40df5c2c855e8a0c11408109968', 1767225660],
            ['862dcbda8e8d9fa19e65785e262f33b03c1e9156', 1787754322],
            ['e522cdc3d5447b9b90ab38314fd550b036d1168f', 1785538860],
          ]);
          const packChecksum = new Uint8Array(20).fill(0xab);
          const oidsInIndexOrder = [...mtimeByOid.keys()].sort() as ObjectId[];
          const bytes = serializeCruftMtimes(entries, packChecksum, (oid) => mtimeByOid.get(oid)!);

          // Act
          const result = parseCruftMtimes(bytes, oidsInIndexOrder);

          // Assert
          for (const oid of oidsInIndexOrder) {
            expect(result.get(oid)).toBe(mtimeByOid.get(oid));
          }
        });
      });
    });

    describe('Given a count that disagrees with the .idx', () => {
      describe('When parsing with too few oids', () => {
        it('Then it refuses with count', () => {
          // Arrange
          const entries = fourEntries();
          const bytes = serializeCruftMtimes(entries, PIN_P_PACK_CHECKSUM, () => PIN_P_MTIME);
          const tooFewOids = [`aa${'00'.repeat(19)}`, `bb${'00'.repeat(19)}`] as ObjectId[];

          // Act & Assert
          expectRefusal(() => parseCruftMtimes(bytes, tooFewOids), 'count', 'disagrees');
        });
      });

      describe('When parsing with too many oids', () => {
        it('Then it refuses with count', () => {
          // Arrange
          const entries = fourEntries();
          const bytes = serializeCruftMtimes(entries, PIN_P_PACK_CHECKSUM, () => PIN_P_MTIME);
          const tooManyOids = [
            `aa${'00'.repeat(19)}`,
            `bb${'00'.repeat(19)}`,
            `cc${'00'.repeat(19)}`,
            `dd${'00'.repeat(19)}`,
            `ee${'00'.repeat(19)}`,
          ] as ObjectId[];

          // Act & Assert
          expectRefusal(() => parseCruftMtimes(bytes, tooManyOids), 'count', 'disagrees');
        });
      });
    });

    describe('Given a bad self-checksum', () => {
      describe('When parsing with a selfChecksum that disagrees with the trailer', () => {
        it('Then it refuses with checksum', () => {
          // Arrange
          const bytes = hexToBytes(PIN_P_HEADER_BODY_CHECKSUM_HEX + PIN_P_SELF_CHECKSUM_HEX);
          const oidsInIndexOrder = [
            `aa${'00'.repeat(19)}`,
            `bb${'00'.repeat(19)}`,
            `cc${'00'.repeat(19)}`,
            `dd${'00'.repeat(19)}`,
          ] as ObjectId[];
          const wrongChecksum = new Uint8Array(20).fill(0x01);

          // Act & Assert
          expectRefusal(
            () => parseCruftMtimes(bytes, oidsInIndexOrder, wrongChecksum),
            'checksum',
            'mismatch',
          );
        });
      });

      describe('When parsing without a selfChecksum argument', () => {
        it('Then it does not refuse — verification is opt-in', () => {
          // Arrange
          const bytes = hexToBytes(PIN_P_HEADER_BODY_CHECKSUM_HEX + PIN_P_SELF_CHECKSUM_HEX);
          const oidsInIndexOrder = [
            `aa${'00'.repeat(19)}`,
            `bb${'00'.repeat(19)}`,
            `cc${'00'.repeat(19)}`,
            `dd${'00'.repeat(19)}`,
          ] as ObjectId[];

          // Act
          const result = parseCruftMtimes(bytes, oidsInIndexOrder);

          // Assert
          expect(result.size).toBe(4);
        });
      });
    });

    describe('Given a file below the header size', () => {
      describe('When parsing an empty file', () => {
        it('Then it refuses with size', () => {
          // Act & Assert
          expectRefusal(() => parseCruftMtimes(new Uint8Array(0), []), 'size', 'too small');
        });
      });

      describe('When parsing an 11-byte file', () => {
        it('Then it refuses with size', () => {
          // Act & Assert
          expectRefusal(() => parseCruftMtimes(new Uint8Array(11), []), 'size', 'too small');
        });
      });
    });

    describe('Given a sidecar with the 4th signature byte flipped', () => {
      describe('When parsing', () => {
        it('Then it refuses with signature', () => {
          // Arrange
          const entries = fourEntries();
          const valid = serializeCruftMtimes(entries, PIN_P_PACK_CHECKSUM, () => PIN_P_MTIME);
          const bytes = pokeByte(valid, 3, valid[3]! ^ 0xff);
          const oids = entries.map((e) => e.id) as ObjectId[];

          // Act & Assert
          expectRefusal(() => parseCruftMtimes(bytes, oids), 'signature', 'signature');
        });
      });
    });

    describe('Given a sidecar with version 0', () => {
      describe('When parsing', () => {
        it('Then it refuses with version', () => {
          // Arrange
          const entries = fourEntries();
          const valid = serializeCruftMtimes(entries, PIN_P_PACK_CHECKSUM, () => PIN_P_MTIME);
          const bytes = pokeUint32(valid, 4, 0);
          const oids = entries.map((e) => e.id) as ObjectId[];

          // Act & Assert
          expectRefusal(() => parseCruftMtimes(bytes, oids), 'version', 'version');
        });
      });
    });

    describe('Given a sidecar with version 2', () => {
      describe('When parsing', () => {
        it('Then it refuses with version — there is no v2', () => {
          // Arrange
          const entries = fourEntries();
          const valid = serializeCruftMtimes(entries, PIN_P_PACK_CHECKSUM, () => PIN_P_MTIME);
          const bytes = pokeUint32(valid, 4, 2);
          const oids = entries.map((e) => e.id) as ObjectId[];

          // Act & Assert
          expectRefusal(() => parseCruftMtimes(bytes, oids), 'version', 'version');
        });
      });
    });

    describe('Given a sidecar with hashId 0', () => {
      describe('When parsing', () => {
        it('Then it refuses with hash-id', () => {
          // Arrange
          const entries = fourEntries();
          const valid = serializeCruftMtimes(entries, PIN_P_PACK_CHECKSUM, () => PIN_P_MTIME);
          const bytes = pokeUint32(valid, 8, 0);
          const oids = entries.map((e) => e.id) as ObjectId[];

          // Act & Assert
          expectRefusal(() => parseCruftMtimes(bytes, oids), 'hash-id', 'hash id');
        });
      });
    });

    describe('Given a sidecar with hashId 3', () => {
      describe('When parsing', () => {
        it('Then it refuses with hash-id', () => {
          // Arrange
          const entries = fourEntries();
          const valid = serializeCruftMtimes(entries, PIN_P_PACK_CHECKSUM, () => PIN_P_MTIME);
          const bytes = pokeUint32(valid, 8, 3);
          const oids = entries.map((e) => e.id) as ObjectId[];

          // Act & Assert
          expectRefusal(() => parseCruftMtimes(bytes, oids), 'hash-id', 'hash id');
        });
      });
    });
  });
});
