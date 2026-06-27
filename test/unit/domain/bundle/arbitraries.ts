import fc from 'fast-check';

import type { BundlePrerequisite, BundleRef } from '../../../../src/domain/bundle/types.js';
import { ObjectId, RefName } from '../../../../src/domain/objects/object-id.js';

const HEX_CHARS = '0123456789abcdef'.split('');
const REF_COMPONENT_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');

/** Arbitrary valid 40-hex SHA-1 oid */
export const arbObjectId = (): fc.Arbitrary<ObjectId> =>
  fc
    .array(fc.constantFrom(...HEX_CHARS), { minLength: 40, maxLength: 40 })
    .map((chars) => ObjectId.from(chars.join('')));

/** Arbitrary non-empty comment string (printable ASCII, no newlines) */
const arbComment = (): fc.Arbitrary<string> => fc.stringMatching(/^[ -~]{0,40}$/);

/** Arbitrary refname prefix + suffix */
const arbRefName = (): fc.Arbitrary<RefName> =>
  fc
    .oneof(
      fc.constant('HEAD'),
      fc
        .tuple(
          fc.constantFrom('refs/heads/', 'refs/tags/', 'refs/remotes/'),
          fc
            .array(fc.constantFrom(...REF_COMPONENT_CHARS), { minLength: 1, maxLength: 16 })
            .map((chars) => chars.join('')),
        )
        .map(([prefix, name]) => `${prefix}${name}`),
    )
    .map((name) => RefName.from(name));

/** Arbitrary BundlePrerequisite */
export const arbBundlePrerequisite = (): fc.Arbitrary<BundlePrerequisite> =>
  fc.record({
    oid: arbObjectId(),
    comment: arbComment(),
  });

/** Arbitrary array of unique-oid BundlePrerequisites (deduped by oid) */
export const arbBundlePrerequisites = (): fc.Arbitrary<ReadonlyArray<BundlePrerequisite>> =>
  fc.array(arbBundlePrerequisite(), { minLength: 0, maxLength: 5 }).map((prereqs) => {
    const seen = new Set<string>();
    return prereqs.filter((p) => {
      if (seen.has(p.oid)) return false;
      seen.add(p.oid);
      return true;
    });
  });

/** Arbitrary BundleRef */
export const arbBundleRef = (): fc.Arbitrary<BundleRef> =>
  fc.record({
    oid: arbObjectId(),
    name: arbRefName(),
  });

/** Arbitrary array of BundleRefs with at least one entry */
export const arbBundleRefs = (): fc.Arbitrary<ReadonlyArray<BundleRef>> =>
  fc.array(arbBundleRef(), { minLength: 1, maxLength: 5 });
