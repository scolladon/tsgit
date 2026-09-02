import { describe, expect, it } from 'vitest';
import {
  createPackRecordStore,
  type PackRecordStore,
} from '../../../../../src/application/primitives/internal/pack-records.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import { PACK_ENTRY_TYPE, PACK_HEADER_SIZE } from '../../../../../src/domain/storage/pack-entry.js';

/** A `digestLength`-byte oid whose every byte is `fill` — distinct fill
 *  values give distinct, trivially comparable oids without pulling in a
 *  real hash. */
const fixedOid = (digestLength: 20 | 32, fill: number): Uint8Array =>
  new Uint8Array(digestLength).fill(fill);

/** Materialises an ordinal range returned by `ofsChildren`/`refChildren`
 *  into a plain array, via the matching `*ChildOrdinalAt` accessor —
 *  exactly the shape a real caller (pass 2) would walk. */
const materialize = (
  range: { readonly start: number; readonly end: number },
  ordinalAt: (position: number) => number,
): number[] => {
  const out: number[] = [];
  for (let i = range.start; i < range.end; i += 1) out.push(ordinalAt(i));
  return out;
};

const materializeOfs = (sut: PackRecordStore, baseOffset: number): number[] =>
  materialize(sut.ofsChildren(baseOffset), sut.ofsChildOrdinalAt);

const materializeRef = (sut: PackRecordStore, baseOidBytes: Uint8Array): number[] =>
  materialize(sut.refChildren(baseOidBytes), sut.refChildOrdinalAt);

describe('Given a pack record store (20-byte digest)', () => {
  describe('When three entries are appended, oid-set, and marked resolved', () => {
    it('Then reading back offset, crc32, type, and oid for the first, a middle, and the last entry returns exactly what was written', () => {
      // Arrange
      const sut = createPackRecordStore(20, 3);
      const specs = [
        { offset: 12, crcValue: 111, type: PACK_ENTRY_TYPE.BLOB, oid: fixedOid(20, 0x01) },
        { offset: 50, crcValue: 222, type: PACK_ENTRY_TYPE.TREE, oid: fixedOid(20, 0x02) },
        { offset: 90, crcValue: 333, type: PACK_ENTRY_TYPE.COMMIT, oid: fixedOid(20, 0x03) },
      ] as const;

      // Act
      for (const spec of specs) {
        const ordinal = sut.append(spec.offset, spec.crcValue, spec.type);
        sut.setOid(ordinal, spec.oid);
        sut.markResolved(ordinal);
      }

      // Assert — entry 0, the middle entry (1), and the last entry (2)
      const view = sut.view();
      for (const position of [0, 1, 2] as const) {
        const spec = specs[position];
        expect(sut.offsetOf(position)).toBe(spec.offset);
        expect(view.crcValues[position]).toBe(spec.crcValue);
        expect(sut.typeOf(position)).toBe(spec.type);
        const range = sut.oidRangeOf(position);
        expect(view.oids.subarray(range.start, range.end)).toEqual(spec.oid);
      }
    });
  });
});

describe('Given a pack record store (32-byte digest)', () => {
  describe('When three entries are appended, oid-set, and marked resolved', () => {
    it('Then reading back offset, crc32, type, and oid for the first, a middle, and the last entry returns exactly what was written', () => {
      // Arrange
      const sut = createPackRecordStore(32, 3);
      const specs = [
        { offset: 12, crcValue: 11, type: PACK_ENTRY_TYPE.BLOB, oid: fixedOid(32, 0x11) },
        { offset: 80, crcValue: 22, type: PACK_ENTRY_TYPE.TAG, oid: fixedOid(32, 0x22) },
        { offset: 200, crcValue: 33, type: PACK_ENTRY_TYPE.TREE, oid: fixedOid(32, 0x33) },
      ] as const;

      // Act
      for (const spec of specs) {
        const ordinal = sut.append(spec.offset, spec.crcValue, spec.type);
        sut.setOid(ordinal, spec.oid);
        sut.markResolved(ordinal);
      }

      // Assert
      const view = sut.view();
      for (const position of [0, 1, 2] as const) {
        const spec = specs[position];
        expect(sut.offsetOf(position)).toBe(spec.offset);
        expect(view.crcValues[position]).toBe(spec.crcValue);
        expect(sut.typeOf(position)).toBe(spec.type);
        const range = sut.oidRangeOf(position);
        expect(view.oids.subarray(range.start, range.end)).toEqual(spec.oid);
      }
    });
  });
});

describe('Given a pack record store with one unresolved entry and one entry resolved to the all-zero oid', () => {
  describe('When isResolved is read for each', () => {
    it('Then it distinguishes "unresolved" from "resolved to the all-zero oid" — the zero oid is never treated as an unresolved sentinel', () => {
      // Arrange
      const sut = createPackRecordStore(20, 2);
      const unresolvedOrdinal = sut.append(12, 1, PACK_ENTRY_TYPE.BLOB);
      const zeroOidOrdinal = sut.append(50, 2, PACK_ENTRY_TYPE.BLOB);
      sut.setOid(zeroOidOrdinal, new Uint8Array(20));
      sut.markResolved(zeroOidOrdinal);

      // Act + Assert
      expect(sut.isResolved(unresolvedOrdinal)).toBe(false);
      expect(sut.isResolved(zeroOidOrdinal)).toBe(true);
      const range = sut.oidRangeOf(zeroOidOrdinal);
      expect(sut.view().oids.subarray(range.start, range.end)).toEqual(new Uint8Array(20));
    });
  });
});

describe('Given a pack record store with a generous structural clamp', () => {
  describe('When entries are appended one below, exactly at, and one above the capacity boundary', () => {
    it('Then capacity stays put until the boundary is crossed, then grows, and every prior entry survives every growth', () => {
      // Arrange
      const sut = createPackRecordStore(20, 1000);
      const initialCapacity = sut.view().offsets.length;
      let next = 0;
      const fill = (howMany: number): void => {
        for (let i = 0; i < howMany; i += 1) {
          next += 1;
          const ordinal = sut.append(next, next, PACK_ENTRY_TYPE.BLOB);
          sut.setOid(ordinal, fixedOid(20, next & 0xff));
        }
      };

      // Act — one below the boundary
      fill(initialCapacity - 1);
      const belowCapacity = sut.view().offsets.length;

      // Act — exactly at the boundary
      fill(1);
      const atBoundaryCapacity = sut.view().offsets.length;

      // Act — one past the boundary
      fill(1);
      const aboveBoundaryCapacity = sut.view().offsets.length;

      // Assert — timing of the growth
      expect(belowCapacity).toBe(initialCapacity);
      expect(atBoundaryCapacity).toBe(initialCapacity);
      expect(aboveBoundaryCapacity).toBeGreaterThan(initialCapacity);

      // Assert — the very first entry, written before any growth, is intact
      // after every growth step since.
      expect(sut.offsetOf(0)).toBe(1);
      const range0 = sut.oidRangeOf(0);
      expect(sut.view().oids.subarray(range0.start, range0.end)).toEqual(fixedOid(20, 1));
    });
  });
});

describe('Given a structural clamp that sits below what plain doubling would reach', () => {
  describe('When enough entries are appended to force one growth step', () => {
    it('Then capacity grows only as far as the structural clamp, never past it', () => {
      // Arrange
      const probe = createPackRecordStore(20, 1_000_000);
      const initialCapacity = probe.view().offsets.length;
      const clampedMax = initialCapacity + 1;
      const sut = createPackRecordStore(20, clampedMax);

      // Act
      for (let i = 0; i < clampedMax; i += 1) {
        const ordinal = sut.append(i + 1, i, PACK_ENTRY_TYPE.BLOB);
        sut.setOid(ordinal, fixedOid(20, (i + 1) & 0xff));
      }

      // Assert
      expect(sut.view().offsets.length).toBe(clampedMax);
    });
  });
});

describe('Given a store with far more capacity than entries', () => {
  describe('When two entries are appended into room for many more', () => {
    it('Then the exposed PackIndexEntries reports count, not the over-allocated array length', () => {
      // Arrange
      const sut = createPackRecordStore(20, 1000);

      // Act
      sut.append(12, 1, PACK_ENTRY_TYPE.BLOB);
      sut.append(50, 2, PACK_ENTRY_TYPE.BLOB);

      // Assert
      const view = sut.view();
      expect(view.count).toBe(2);
      expect(view.offsets.length).toBeGreaterThan(view.count);
    });
  });

  describe("When the last entry's oid range is computed", () => {
    it('Then it names the last digestLength bytes within count, never reaching into the over-allocated tail', () => {
      // Arrange
      const sut = createPackRecordStore(20, 1000);
      const ordinals = [0, 1, 2].map((i) => sut.append(i + 1, i, PACK_ENTRY_TYPE.BLOB));
      ordinals.forEach((ordinal, i) => {
        sut.setOid(ordinal, fixedOid(20, i + 1));
      });

      // Act
      const range = sut.oidRangeOf(2);

      // Assert
      expect(range).toEqual({ start: 40, end: 60 });
      expect(range.end).toBe(sut.view().count * 20);
      expect(range.end).toBeLessThan(sut.view().oids.length);
    });
  });
});

describe('Given a store with no deltas recorded at all', () => {
  describe('When the child indexes are built and queried', () => {
    it('Then both ofsChildren and refChildren return zero children', () => {
      // Arrange
      const sut = createPackRecordStore(20, 10);
      sut.append(100, 0, PACK_ENTRY_TYPE.BLOB);

      // Act
      sut.buildChildIndexes();

      // Assert
      expect(materializeOfs(sut, 12)).toEqual([]);
      expect(materializeRef(sut, fixedOid(20, 0x99))).toEqual([]);
    });
  });
});

describe('Given a store with exactly one OFS delta recorded', () => {
  describe('When ofsChildren is queried for its base offset', () => {
    it("Then it returns exactly that one delta's own entry ordinal", () => {
      // Arrange
      const sut = createPackRecordStore(20, 10);
      const baseOrdinal = sut.append(12, 0, PACK_ENTRY_TYPE.BLOB);
      const deltaOrdinal = sut.append(100, 0, PACK_ENTRY_TYPE.BLOB);
      sut.recordOfsDelta(deltaOrdinal, sut.offsetOf(baseOrdinal));

      // Act
      sut.buildChildIndexes();

      // Assert
      expect(materializeOfs(sut, 12)).toEqual([deltaOrdinal]);
    });
  });
});

describe('Given two OFS deltas recorded against the same base offset', () => {
  describe('When ofsChildren is queried for that base offset', () => {
    it('Then it returns both delta ordinals, adjacent in the sorted index', () => {
      // Arrange
      const sut = createPackRecordStore(20, 10);
      const baseOrdinal = sut.append(12, 0, PACK_ENTRY_TYPE.BLOB);
      const firstChild = sut.append(100, 0, PACK_ENTRY_TYPE.BLOB);
      const secondChild = sut.append(200, 0, PACK_ENTRY_TYPE.BLOB);
      const baseOffset = sut.offsetOf(baseOrdinal);
      sut.recordOfsDelta(firstChild, baseOffset);
      sut.recordOfsDelta(secondChild, baseOffset);

      // Act
      sut.buildChildIndexes();

      // Assert
      expect(materializeOfs(sut, baseOffset).sort((a, b) => a - b)).toEqual(
        [firstChild, secondChild].sort((a, b) => a - b),
      );
    });
  });
});

describe('Given OFS deltas against several different bases, recorded in an order scrambled relative to those base offsets', () => {
  describe('When ofsChildren is queried for each distinct base offset', () => {
    it('Then each query returns exactly its own group, unaffected by the interleaving', () => {
      // Arrange
      const sut = createPackRecordStore(20, 20);
      const baseA = sut.append(12, 0, PACK_ENTRY_TYPE.BLOB);
      const baseB = sut.append(50, 0, PACK_ENTRY_TYPE.BLOB);
      const offsetA = sut.offsetOf(baseA);
      const offsetB = sut.offsetOf(baseB);
      const childA1 = sut.append(100, 0, PACK_ENTRY_TYPE.BLOB);
      const childB1 = sut.append(120, 0, PACK_ENTRY_TYPE.BLOB);
      const childA2 = sut.append(140, 0, PACK_ENTRY_TYPE.BLOB);
      sut.recordOfsDelta(childA1, offsetA);
      sut.recordOfsDelta(childB1, offsetB);
      sut.recordOfsDelta(childA2, offsetA);

      // Act
      sut.buildChildIndexes();

      // Assert
      expect(materializeOfs(sut, offsetA).sort((a, b) => a - b)).toEqual(
        [childA1, childA2].sort((a, b) => a - b),
      );
      expect(materializeOfs(sut, offsetB)).toEqual([childB1]);
    });
  });
});

describe("Given a delta table with entries but none based on a particular real entry's own offset", () => {
  describe("When ofsChildren is queried for that entry's offset", () => {
    it('Then it returns zero children even though the table is not empty', () => {
      // Arrange
      const sut = createPackRecordStore(20, 20);
      const baseOrdinal = sut.append(12, 0, PACK_ENTRY_TYPE.BLOB);
      const uninvolvedOrdinal = sut.append(50, 0, PACK_ENTRY_TYPE.BLOB);
      const childOrdinal = sut.append(100, 0, PACK_ENTRY_TYPE.BLOB);
      sut.recordOfsDelta(childOrdinal, sut.offsetOf(baseOrdinal));

      // Act
      sut.buildChildIndexes();

      // Assert
      expect(materializeOfs(sut, sut.offsetOf(uninvolvedOrdinal))).toEqual([]);
    });
  });
});

describe('Given a store with no REF deltas recorded', () => {
  describe('When refChildren is queried', () => {
    it('Then it returns zero children', () => {
      // Arrange
      const sut = createPackRecordStore(20, 10);
      sut.append(12, 0, PACK_ENTRY_TYPE.BLOB);

      // Act
      sut.buildChildIndexes();

      // Assert
      expect(materializeRef(sut, fixedOid(20, 0x42))).toEqual([]);
    });
  });
});

describe('Given exactly one REF delta recorded', () => {
  describe('When refChildren is queried for its base oid', () => {
    it("Then it returns exactly that one delta's own entry ordinal", () => {
      // Arrange
      const sut = createPackRecordStore(20, 10);
      const deltaOrdinal = sut.append(100, 0, PACK_ENTRY_TYPE.BLOB);
      const baseOid = fixedOid(20, 0x07);
      sut.recordRefDelta(deltaOrdinal, baseOid);

      // Act
      sut.buildChildIndexes();

      // Assert
      expect(materializeRef(sut, baseOid)).toEqual([deltaOrdinal]);
    });
  });
});

describe('Given two REF deltas recorded against equal base oid bytes', () => {
  describe('When refChildren is queried for that oid', () => {
    it('Then both entries are found — a duplicate oid in the pack is tolerated, not collapsed', () => {
      // Arrange
      const sut = createPackRecordStore(20, 10);
      const baseOid = fixedOid(20, 0x07);
      const firstChild = sut.append(100, 0, PACK_ENTRY_TYPE.BLOB);
      const secondChild = sut.append(200, 0, PACK_ENTRY_TYPE.BLOB);
      sut.recordRefDelta(firstChild, baseOid);
      sut.recordRefDelta(secondChild, baseOid);

      // Act
      sut.buildChildIndexes();

      // Assert
      expect(materializeRef(sut, baseOid).sort((a, b) => a - b)).toEqual(
        [firstChild, secondChild].sort((a, b) => a - b),
      );
    });
  });
});

describe('Given REF deltas against several different base oids, recorded in an order scrambled relative to those oids', () => {
  describe('When refChildren is queried for each distinct base oid', () => {
    it('Then each query returns exactly its own group, unaffected by the interleaving', () => {
      // Arrange
      const sut = createPackRecordStore(20, 20);
      const oidA = fixedOid(20, 0x01);
      const oidB = fixedOid(20, 0x02);
      const childA1 = sut.append(100, 0, PACK_ENTRY_TYPE.BLOB);
      const childB1 = sut.append(120, 0, PACK_ENTRY_TYPE.BLOB);
      const childA2 = sut.append(140, 0, PACK_ENTRY_TYPE.BLOB);
      sut.recordRefDelta(childA1, oidA);
      sut.recordRefDelta(childB1, oidB);
      sut.recordRefDelta(childA2, oidA);

      // Act
      sut.buildChildIndexes();

      // Assert
      expect(materializeRef(sut, oidA).sort((a, b) => a - b)).toEqual(
        [childA1, childA2].sort((a, b) => a - b),
      );
      expect(materializeRef(sut, oidB)).toEqual([childB1]);
    });
  });
});

describe('Given a REF delta table with entries but none based on a particular oid', () => {
  describe('When refChildren is queried for that oid', () => {
    it('Then it returns zero children even though the table is not empty', () => {
      // Arrange
      const sut = createPackRecordStore(20, 20);
      const childOrdinal = sut.append(100, 0, PACK_ENTRY_TYPE.BLOB);
      sut.recordRefDelta(childOrdinal, fixedOid(20, 0x01));

      // Act
      sut.buildChildIndexes();

      // Assert
      expect(materializeRef(sut, fixedOid(20, 0x02))).toEqual([]);
    });
  });
});

describe('Given a store with no REF deltas recorded, before buildChildIndexes is ever called', () => {
  describe('When refDeltaCount is read', () => {
    it('Then it is zero', () => {
      // Arrange
      const sut = createPackRecordStore(20, 10);
      sut.append(12, 0, PACK_ENTRY_TYPE.BLOB);

      // Assert
      expect(sut.refDeltaCount).toBe(0);
    });
  });
});

describe('Given two REF deltas recorded in append order, before buildChildIndexes is ever called', () => {
  describe('When refDeltaCount, refDeltaOrdinalAt and refDeltaBaseOidAt are read', () => {
    it('Then they report the raw append order, not the oid-sorted order refChildren uses', () => {
      // Arrange
      const sut = createPackRecordStore(20, 10);
      const oidHigh = fixedOid(20, 0xff);
      const oidLow = fixedOid(20, 0x01);
      const firstDelta = sut.append(100, 0, PACK_ENTRY_TYPE.REF_DELTA);
      const secondDelta = sut.append(200, 0, PACK_ENTRY_TYPE.REF_DELTA);
      // Recorded with the HIGHER oid first — an oid-sorted read would flip
      // this order; the raw append-order accessors must not.
      sut.recordRefDelta(firstDelta, oidHigh);
      sut.recordRefDelta(secondDelta, oidLow);

      // Assert
      expect(sut.refDeltaCount).toBe(2);
      expect(sut.refDeltaOrdinalAt(0)).toBe(firstDelta);
      expect(sut.refDeltaOrdinalAt(1)).toBe(secondDelta);
      expect(sut.refDeltaBaseOidAt(0)).toEqual(oidHigh);
      expect(sut.refDeltaBaseOidAt(1)).toEqual(oidLow);
    });
  });
});

describe('Given an OFS delta whose base offset points before the pack body', () => {
  describe('When recordOfsDelta is called', () => {
    it('Then it throws INVALID_PACK_HEADER with git\'s "out of bound" reason', () => {
      // Arrange
      const sut = createPackRecordStore(20, 10);
      const deltaOrdinal = sut.append(100, 0, PACK_ENTRY_TYPE.BLOB);

      // Act
      let caught: unknown;
      try {
        sut.recordOfsDelta(deltaOrdinal, PACK_HEADER_SIZE - 1);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as {
        readonly code: string;
        readonly reason: string;
      };
      expect(data.code).toBe('INVALID_PACK_HEADER');
      expect(data.reason).toBe('delta base offset is out of bound');
    });
  });
});

describe('Given an OFS delta whose base offset equals its own entry offset (distance zero)', () => {
  describe('When recordOfsDelta is called', () => {
    it('Then it throws INVALID_PACK_HEADER — a self-referential delta is refused, not folded into an unresolved count', () => {
      // Arrange
      const sut = createPackRecordStore(20, 10);
      const deltaOrdinal = sut.append(100, 0, PACK_ENTRY_TYPE.BLOB);

      // Act
      let caught: unknown;
      try {
        sut.recordOfsDelta(deltaOrdinal, 100);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as {
        readonly code: string;
        readonly reason: string;
      };
      expect(data.code).toBe('INVALID_PACK_HEADER');
      expect(data.reason).toBe('delta base offset is out of bound');
    });
  });
});
