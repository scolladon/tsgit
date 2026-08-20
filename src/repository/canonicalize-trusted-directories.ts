/**
 * Physical resolution of a trusted-directory allowlist.
 *
 * The node adapter confines by realpath, so the repository path the trust gate
 * matches against is already physical. An allowlist entry compared against it
 * lexically would therefore stop matching the moment a symlink is involved —
 * on macOS that is the everyday `/tmp` -> `/private/tmp` and `/var` ->
 * `/private/var` case, not an exotic one.
 *
 * Two entry shapes must NOT be resolved as plain paths:
 *
 * - `'*'` is the whole grammar, not a path. Realpathing it would produce
 *   `<cwd>/*` and quietly turn "trust everything" into "trust nothing".
 * - A trailing `/*` is a grammar token on a path PREFIX. Realpathing the whole
 *   entry fails (the star is not a directory), and the failure is silent — the
 *   resolver hands back the entry unchanged — so the prefix would never be
 *   canonicalised at all and the entry would compare lexically against a
 *   physical path.
 *
 * Lives in its own module, rather than inline in the node shim, so the rule is
 * unit-testable without an alien-owned fixture: the verdict it feeds only
 * flips on a repository the caller does not own, which most environments
 * cannot create.
 */

/** Resolves a path physically, or hands it back unchanged when it cannot. */
export type PathResolver = (path: string) => Promise<string>;

const WILDCARD_ALL = '*';
const WILDCARD_SUFFIX = '/*';

export const canonicalizeTrustedDirectories = async (
  trustedDirectories: ReadonlyArray<string> | undefined,
  resolve: PathResolver,
): Promise<ReadonlyArray<string> | undefined> => {
  if (trustedDirectories === undefined) return undefined;
  return Promise.all(
    trustedDirectories.map(async (entry) => {
      if (entry === WILDCARD_ALL) return entry;
      if (entry.endsWith(WILDCARD_SUFFIX)) {
        return `${await resolve(entry.slice(0, -WILDCARD_SUFFIX.length))}${WILDCARD_SUFFIX}`;
      }
      return resolve(entry);
    }),
  );
};
