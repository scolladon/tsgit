import fc from 'fast-check';

import type {
  BundleHashAlgorithm,
  BundlePrerequisite,
  BundleRef,
  BundleVersion,
} from '../../../../src/domain/bundle/types.js';
import { ObjectId, RefName } from '../../../../src/domain/objects/object-id.js';

const HEX_CHARS = '0123456789abcdef'.split('');
const REF_COMPONENT_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');

/** Arbitrary valid hex oid of the given width (40 = sha1, 64 = sha256). */
export const arbObjectId = (hexLength: 40 | 64 = 40): fc.Arbitrary<ObjectId> =>
  fc
    .array(fc.constantFrom(...HEX_CHARS), { minLength: hexLength, maxLength: hexLength })
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

/** Arbitrary BundlePrerequisite at the given oid width */
export const arbBundlePrerequisite = (hexLength: 40 | 64 = 40): fc.Arbitrary<BundlePrerequisite> =>
  fc.record({
    oid: arbObjectId(hexLength),
    comment: arbComment(),
  });

/** Arbitrary array of unique-oid BundlePrerequisites (deduped by oid) at the given oid width */
export const arbBundlePrerequisites = (
  hexLength: 40 | 64 = 40,
): fc.Arbitrary<ReadonlyArray<BundlePrerequisite>> =>
  fc.array(arbBundlePrerequisite(hexLength), { minLength: 0, maxLength: 5 }).map((prereqs) => {
    const seen = new Set<string>();
    return prereqs.filter((p) => {
      if (seen.has(p.oid)) return false;
      seen.add(p.oid);
      return true;
    });
  });

/** Arbitrary BundleRef at the given oid width */
export const arbBundleRef = (hexLength: 40 | 64 = 40): fc.Arbitrary<BundleRef> =>
  fc.record({
    oid: arbObjectId(hexLength),
    name: arbRefName(),
  });

/** Arbitrary array of BundleRefs with at least one entry, at the given oid width */
export const arbBundleRefs = (hexLength: 40 | 64 = 40): fc.Arbitrary<ReadonlyArray<BundleRef>> =>
  fc.array(arbBundleRef(hexLength), { minLength: 1, maxLength: 5 });

const hexLengthFor = (hashAlgorithm: BundleHashAlgorithm): 40 | 64 =>
  hashAlgorithm === 'sha256' ? 64 : 40;

/** Arbitrary (version, algorithm) pair drawn from the legal set: v2 admits only sha1; v3 admits either. */
export const arbVersionAndAlgorithm = (): fc.Arbitrary<{
  readonly version: BundleVersion;
  readonly hashAlgorithm: BundleHashAlgorithm;
}> =>
  fc.oneof(
    fc.constant({ version: 2 as const, hashAlgorithm: 'sha1' as const }),
    fc.constant({ version: 3 as const, hashAlgorithm: 'sha1' as const }),
    fc.constant({ version: 3 as const, hashAlgorithm: 'sha256' as const }),
  );

/**
 * Arbitrary full set of `serializeBundleHeader` inputs: a legal
 * (version, algorithm) pair plus prerequisites/refs whose oid width matches
 * that pair's algorithm — a sha256 pair never generates 40-hex oids and vice
 * versa.
 */
export const arbBundleHeaderInputs = (): fc.Arbitrary<{
  readonly version: BundleVersion;
  readonly hashAlgorithm: BundleHashAlgorithm;
  readonly prerequisites: ReadonlyArray<BundlePrerequisite>;
  readonly refs: ReadonlyArray<BundleRef>;
}> =>
  arbVersionAndAlgorithm().chain(({ version, hashAlgorithm }) => {
    const hexLength = hexLengthFor(hashAlgorithm);
    return fc.record({
      version: fc.constant(version),
      hashAlgorithm: fc.constant(hashAlgorithm),
      prerequisites: arbBundlePrerequisites(hexLength),
      refs: arbBundleRefs(hexLength),
    });
  });
