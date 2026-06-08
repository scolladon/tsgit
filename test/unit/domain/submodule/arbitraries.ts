import fc from 'fast-check';

// A path segment: non-empty ASCII without NUL, '/', or ':' (the chars that
// drive component boundaries) — exercises the resolver over its safe subset.
const arbSegment = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom('a', 'b', 'super.git', 'x', 'sub', '.git', 'A', '_'), {
      minLength: 1,
      maxLength: 1,
    })
    .map((parts) => parts.join(''));

const arbSegments = (max: number): fc.Arbitrary<string> =>
  fc.array(arbSegment(), { minLength: 1, maxLength: max }).map((parts) => parts.join('/'));

/**
 * A `/`-joined submodule name or path that passes `isUnsafeSubmoduleName`: 1–4
 * non-empty, non-`.`/`..` segments with no leading/trailing slash. Drives the
 * gitlink-path algebra over its declared safe subset.
 */
export const arbSafeSubmoduleName = (max = 4): fc.Arbitrary<string> => arbSegments(max);

/** A non-relative base: absolute path, https URL, or scp-style URL. */
export const arbNonRelativeBase = (): fc.Arbitrary<string> =>
  fc.oneof(
    arbSegments(4).map((p) => `/${p}`),
    arbSegments(4).map((p) => `https://h.x/${p}`),
    arbSegments(4).map((p) => `git@h.x:${p}`),
  );

/** A relative submodule url: one or more `./` / `../` prefixes plus a tail. */
export const arbRelativeUrl = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.array(fc.constantFrom('./', '../'), { minLength: 1, maxLength: 3 }).map((p) => p.join('')),
      arbSegment(),
    )
    .map(([prefix, tail]) => `${prefix}${tail}`);

/** An absolute / remote url that must be returned verbatim. */
export const arbVerbatimUrl = (): fc.Arbitrary<string> =>
  fc.oneof(
    arbSegments(3).map((p) => `https://other/${p}`),
    arbSegments(3).map((p) => `git@other:${p}`),
    arbSegments(3).map((p) => `/abs/${p}`),
  );
