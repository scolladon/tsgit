import fc from 'fast-check';

import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { ObjectId as OID } from '../../../../src/domain/objects/object-id.js';

const HEX_CHARS = '0123456789abcdef'.split('');

export const oidArb = (): fc.Arbitrary<ObjectId> =>
  fc
    .array(fc.constantFrom(...HEX_CHARS), { minLength: 40, maxLength: 40 })
    .map((chars) => OID.from(chars.join('')));

export const wantsArb = (): fc.Arbitrary<ReadonlyArray<ObjectId>> =>
  fc.array(oidArb(), { minLength: 1, maxLength: 5 });

export const havesArb = (): fc.Arbitrary<ReadonlyArray<ObjectId>> =>
  fc.array(oidArb(), { minLength: 0, maxLength: 5 });

export const doneArb = (): fc.Arbitrary<boolean> => fc.boolean();
