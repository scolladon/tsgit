/**
 * Shared fast-check generators for `commonAncestor` property tests. Fixes one
 * bare volume root per path family (`/` for POSIX, `C:\` for Windows) so
 * every generated path is rooted and comparable across the two policies.
 */
import fc from 'fast-check';
import {
  type PathPolicy,
  posixPolicy,
  windowsPolicy,
} from '../../../src/adapters/node/path-policy.js';

export function arbSegmentChar(): fc.Arbitrary<string> {
  return fc
    .oneof(
      fc.integer({ min: 97, max: 122 }), // a-z
      fc.integer({ min: 65, max: 90 }), // A-Z
      fc.integer({ min: 48, max: 57 }), // 0-9
    )
    .map((code) => String.fromCharCode(code));
}

export function arbSegment(): fc.Arbitrary<string> {
  return fc.string({ unit: arbSegmentChar(), minLength: 1, maxLength: 8 });
}

export interface RootedPolicy {
  readonly policy: PathPolicy;
  readonly root: string;
}

export function arbRootedPolicy(): fc.Arbitrary<RootedPolicy> {
  return fc.constantFrom(
    { policy: posixPolicy, root: '/' },
    { policy: windowsPolicy, root: 'C:\\' },
  );
}

/**
 * Builds an absolute path from a bare volume root and segments. `root`
 * already ends in the policy separator, so segments are joined among
 * themselves and appended directly — reducing with a leading separator
 * would double it (`'C:\\' + '\\' + 'a'` → malformed `'C:\\\\a'`).
 */
export function buildPath(
  policy: PathPolicy,
  root: string,
  segments: ReadonlyArray<string>,
): string {
  return root + segments.join(policy.sep);
}
