import fc from 'fast-check';
import type { Candidate } from '../../../../src/domain/describe/types.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';

/** An arbitrary candidate with a bounded depth / foundOrder. */
export const arbCandidate = (): fc.Arbitrary<Candidate> =>
  fc
    .record({
      depth: fc.nat({ max: 1_000 }),
      foundOrder: fc.nat({ max: 100 }),
    })
    .map(({ depth, foundOrder }) => ({
      name: 'v',
      commitOid: ObjectId.from('a'.repeat(40)),
      depth,
      foundOrder,
    }));

/** An arbitrary tag short name (segments of safe chars, optionally slashed). */
export const arbTagName = (): fc.Arbitrary<string> =>
  fc
    .array(fc.stringMatching(/^[a-z0-9.]{1,6}$/), { minLength: 1, maxLength: 3 })
    .map((segments) => segments.join('/'));
