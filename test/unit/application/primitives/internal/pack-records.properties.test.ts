import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createPackRecordStore } from '../../../../../src/application/primitives/internal/pack-records.js';
import { bytesToHex } from '../../../../../src/domain/objects/encoding.js';
import { PACK_ENTRY_TYPE } from '../../../../../src/domain/storage/pack-entry.js';
import {
  arbPackRecordDeltaRoles,
  arbPackRecordEntrySpecs,
  PACK_RECORD_ROLE_CARRIER_OFFSET_BASE,
  type PackRecordDeltaRole,
} from './arbitraries.js';

const DIGEST_LENGTH = 20;
const CARRIER_OFFSET_STEP = 4;

interface DeltaScenario {
  readonly sut: ReturnType<typeof createPackRecordStore>;
  readonly paired: ReadonlyArray<{ readonly role: PackRecordDeltaRole; readonly ordinal: number }>;
}

/** One synthetic carrier entry per role, offset well past every generated
 *  OFS base offset (`arbPackRecordDeltaRoles`'s own invariant), then each
 *  role recorded against its own carrier's ordinal in the same pass — so
 *  callers zip role and ordinal back together via `paired` instead of
 *  re-indexing two parallel arrays. */
const buildDeltaScenario = (roles: ReadonlyArray<PackRecordDeltaRole>): DeltaScenario => {
  const sut = createPackRecordStore(DIGEST_LENGTH, roles.length + 1);
  const paired = roles.map((role, i) => {
    const ordinal = sut.append(
      PACK_RECORD_ROLE_CARRIER_OFFSET_BASE + i * CARRIER_OFFSET_STEP,
      0,
      PACK_ENTRY_TYPE.BLOB,
    );
    if (role.kind === 'ofs') sut.recordOfsDelta(ordinal, role.baseOffset);
    else sut.recordRefDelta(ordinal, role.baseOid);
    return { role, ordinal };
  });
  return { sut, paired };
};

const materialize = (
  range: { readonly start: number; readonly end: number },
  ordinalAt: (position: number) => number,
): number[] => {
  const out: number[] = [];
  for (let i = range.start; i < range.end; i += 1) out.push(ordinalAt(i));
  return out;
};

const sortedNumbers = (values: ReadonlyArray<number>): number[] =>
  [...values].sort((a, b) => a - b);

describe('pack-records — round-trip and compositional-matcher properties', () => {
  describe('Given an arbitrary list of pack records', () => {
    describe('When each is appended, oid-set, and read back by its own ordinal', () => {
      it('Then every ordinal returns exactly the offset, crc32, type, and oid it was written with', () => {
        fc.assert(
          fc.property(arbPackRecordEntrySpecs(DIGEST_LENGTH), (specs) => {
            // Arrange
            const sut = createPackRecordStore(DIGEST_LENGTH, specs.length);

            // Act
            const written = specs.map((spec) => {
              const ordinal = sut.append(spec.offset, spec.crcValue, spec.type);
              sut.setOid(ordinal, spec.oid);
              return { spec, ordinal };
            });

            // Assert
            const view = sut.view();
            for (const { spec, ordinal } of written) {
              expect(sut.offsetOf(ordinal)).toBe(spec.offset);
              expect(view.crcValues[ordinal]).toBe(spec.crcValue);
              expect(sut.typeOf(ordinal)).toBe(spec.type);
              const range = sut.oidRangeOf(ordinal);
              expect(view.oids.subarray(range.start, range.end)).toEqual(spec.oid);
            }
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary collection of OFS deltas recorded against synthetic carrier entries', () => {
    describe('When ofsChildren is queried for every base offset that appears, plus one that never does', () => {
      it('Then it returns exactly the ordinals whose recorded base offset equals that key', () => {
        fc.assert(
          fc.property(arbPackRecordDeltaRoles(), (roles) => {
            // Arrange
            const { sut, paired } = buildDeltaScenario(roles);
            const expected = new Map<number, number[]>();
            for (const { role, ordinal } of paired) {
              if (role.kind !== 'ofs') continue;
              const group = expected.get(role.baseOffset) ?? [];
              group.push(ordinal);
              expected.set(role.baseOffset, group);
            }

            // Act
            sut.buildChildIndexes();

            // Assert — every key that appears
            for (const [baseOffset, expectedOrdinals] of expected) {
              const actual = materialize(sut.ofsChildren(baseOffset), sut.ofsChildOrdinalAt);
              expect(sortedNumbers(actual)).toEqual(sortedNumbers(expectedOrdinals));
            }
            // Assert — a key absent from every generated role
            const absentKey = PACK_RECORD_ROLE_CARRIER_OFFSET_BASE + 1;
            expect(materialize(sut.ofsChildren(absentKey), sut.ofsChildOrdinalAt)).toEqual([]);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary collection of REF deltas recorded against synthetic carrier entries, duplicate base oids included', () => {
    describe('When refChildren is queried for every base oid that appears, plus one that never does', () => {
      it('Then it returns exactly the ordinals whose recorded base oid equals that key', () => {
        fc.assert(
          fc.property(arbPackRecordDeltaRoles(), (roles) => {
            // Arrange
            const { sut, paired } = buildDeltaScenario(roles);
            const expected = new Map<
              string,
              { readonly oid: Uint8Array; readonly ordinals: number[] }
            >();
            for (const { role, ordinal } of paired) {
              if (role.kind !== 'ref') continue;
              const key = bytesToHex(role.baseOid);
              const entry = expected.get(key) ?? { oid: role.baseOid, ordinals: [] };
              entry.ordinals.push(ordinal);
              expected.set(key, entry);
            }

            // Act
            sut.buildChildIndexes();

            // Assert — every oid that appears
            for (const { oid, ordinals: expectedOrdinals } of expected.values()) {
              const actual = materialize(sut.refChildren(oid), sut.refChildOrdinalAt);
              expect(sortedNumbers(actual)).toEqual(sortedNumbers(expectedOrdinals));
            }
            // Assert — an oid vanishingly unlikely to have been generated
            const absentOid = new Uint8Array(DIGEST_LENGTH).fill(0xee);
            expect(materialize(sut.refChildren(absentOid), sut.refChildOrdinalAt)).toEqual([]);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary collection of OFS and REF deltas together', () => {
    describe("When every distinct key's child count is summed across both child indexes", () => {
      it('Then the total equals the number of deltas recorded', () => {
        fc.assert(
          fc.property(arbPackRecordDeltaRoles(), (roles) => {
            // Arrange
            const { sut } = buildDeltaScenario(roles);
            const distinctOfsKeys = new Set(
              roles.filter((r) => r.kind === 'ofs').map((r) => r.baseOffset),
            );
            const distinctRefKeys = new Map<string, Uint8Array>();
            for (const role of roles) {
              if (role.kind === 'ref') distinctRefKeys.set(bytesToHex(role.baseOid), role.baseOid);
            }

            // Act
            sut.buildChildIndexes();
            let total = 0;
            for (const baseOffset of distinctOfsKeys) {
              const range = sut.ofsChildren(baseOffset);
              total += range.end - range.start;
            }
            for (const baseOid of distinctRefKeys.values()) {
              const range = sut.refChildren(baseOid);
              total += range.end - range.start;
            }

            // Assert
            expect(total).toBe(roles.length);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
