import fc from 'fast-check';
import type { TreeEntry } from '../../../../src/domain/objects/index.js';
import { FILE_MODE, ObjectId } from '../../../../src/domain/objects/index.js';

const HEX = [...'0123456789abcdef'];

const hexString = (length: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...HEX), { minLength: length, maxLength: length })
    .map((chars) => chars.join(''));

export const arbOid = (): fc.Arbitrary<ObjectId> => hexString(40).map((hex) => ObjectId.from(hex));

export const arbFanout = (): fc.Arbitrary<number> => fc.constantFrom(0, 1, 2);

export const arbDistinctOids = (): fc.Arbitrary<ReadonlyArray<ObjectId>> =>
  fc.uniqueArray(arbOid(), { maxLength: 25 });

interface SlottedSpec {
  readonly nibble: number;
  readonly isNote: boolean;
  readonly tail: string;
  readonly id: ObjectId;
}

export interface RootEntriesSpec {
  readonly entries: ReadonlyArray<TreeEntry>;
  readonly noteCount: number;
  readonly preserved: ReadonlyArray<TreeEntry>;
}

const slottedEntry = (spec: SlottedSpec): TreeEntry => {
  const head = spec.nibble.toString(16);
  return spec.isNote
    ? { mode: FILE_MODE.REGULAR, name: head + spec.tail.slice(1), id: spec.id }
    : { mode: FILE_MODE.DIRECTORY, name: head + spec.tail.slice(1, 2), id: spec.id };
};

const arbSlotted = (): fc.Arbitrary<ReadonlyArray<SlottedSpec>> =>
  fc.uniqueArray(
    fc.record({
      nibble: fc.integer({ min: 0, max: 15 }),
      isNote: fc.boolean(),
      tail: hexString(40),
      id: arbOid(),
    }),
    { selector: (spec) => spec.nibble, maxLength: 16 },
  );

const arbPreserved = (): fc.Arbitrary<ReadonlyArray<TreeEntry>> =>
  fc.array(
    fc
      .record({ name: fc.stringMatching(/^[g-z]{3,8}$/), id: arbOid() })
      .map((record): TreeEntry => ({ mode: FILE_MODE.REGULAR, name: record.name, id: record.id })),
    { maxLength: 4 },
  );

export const arbRootEntries = (): fc.Arbitrary<RootEntriesSpec> =>
  fc.tuple(arbSlotted(), arbPreserved()).map(([slotted, preserved]) => {
    const slottedEntries = slotted.map(slottedEntry);
    const noteCount = slotted.filter((spec) => spec.isNote).length;
    return { entries: [...slottedEntries, ...preserved], noteCount, preserved };
  });
