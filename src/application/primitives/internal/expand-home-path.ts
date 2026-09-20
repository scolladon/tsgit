/**
 * git's `interpolate_path` for the one prefix every pathname-typed config key
 * shares: a leading `~/`. Every key git routes through `git_config_pathname`
 * (`core.hooksPath`, `fsck.skipList`, `core.excludesFile`, …) gets it, so the
 * rule lives here once rather than beside each reader.
 */

/** The only prefix this expands: git's own `~/`. A bare `~` and a `~user/`
 *  lookup both go through the passwd database, which no adapter port reaches. */
export const HOME_PREFIX = '~/';

/**
 * `path` with a leading `~/` replaced by the user's home directory. A path
 * that does not start `~/` is returned exactly as written. `undefined` when
 * the path asks for a home and no home is known — the caller decides what an
 * unresolvable home means for its own key.
 */
export const expandHomePrefix = (path: string, homeDir: string | undefined): string | undefined => {
  if (!path.startsWith(HOME_PREFIX)) return path;
  if (homeDir === undefined) return undefined;
  return `${homeDir}/${path.slice(HOME_PREFIX.length)}`;
};
