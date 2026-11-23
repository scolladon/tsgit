/**
 * Which index paths exist on disk, spending as few probes as the layout allows: once a directory
 * is known missing, every later path beneath it is absent without a probe. Ports the ordered
 * presence decision of git's `clear_skip_worktree_from_present_files`.
 */
export type PathProbe = (path: string) => Promise<boolean>;

const SLASH = '/';

/** Length of the prefix of `a` and `b` up to and including the last `/` at which they still agree. */
export const commonDirectoryPrefix = (a: string, b: string): number => {
  let prefix = 0;
  for (let i = 0; a[i] !== undefined && a[i] === b[i]; i++) {
    if (a[i] === SLASH) prefix = i + 1;
  }
  return prefix;
};

/** The first missing directory on the way to `path`, or `path/` when every parent exists. */
const firstMissingDirectory = async (
  path: string,
  known: string,
  probe: PathProbe,
): Promise<string> => {
  let end = commonDirectoryPrefix(path, known);
  for (let slash = path.indexOf(SLASH, end); slash !== -1; slash = path.indexOf(SLASH, end)) {
    end = slash + 1;
    if (!(await probe(path.slice(0, end)))) return path.slice(0, end);
  }
  return `${path}${SLASH}`;
};

/** Paths (index order) that a successful probe finds; a cached missing directory answers the rest. */
export const presentPaths = async (
  paths: ReadonlyArray<string>,
  probe: PathProbe,
): Promise<ReadonlySet<string>> => {
  const present = new Set<string>();
  let missing = '';
  for (const path of paths) {
    if (missing !== '' && path.startsWith(missing)) continue;
    if (await probe(path)) present.add(path);
    else missing = await firstMissingDirectory(path, missing, probe);
  }
  return present;
};

/** What a synchronous pass found, and the missing directory it ended on, so a later pass can resume from it. */
export interface SyncPass {
  readonly present: ReadonlySet<string>;
  readonly missing: string;
}

/**
 * The same decisions as {@link presentPaths} for a probe that answers at once, resumable from the
 * `missing` directory a previous pass ended on. A twin rather than a shared generator: a
 * promise-free loop is the point, and a generator costs more per probe than the `lstat` it wraps.
 */
export const presentPathsSync = (
  paths: ReadonlyArray<string>,
  probe: (path: string) => boolean,
  from = '',
): SyncPass => {
  const present = new Set<string>();
  let missing = from;
  for (const path of paths) {
    if (missing !== '' && path.startsWith(missing)) continue;
    if (probe(path)) present.add(path);
    else missing = firstMissingDirectorySync(path, missing, probe);
  }
  return { present, missing };
};

const firstMissingDirectorySync = (
  path: string,
  known: string,
  probe: (path: string) => boolean,
): string => {
  let end = commonDirectoryPrefix(path, known);
  for (let slash = path.indexOf(SLASH, end); slash !== -1; slash = path.indexOf(SLASH, end)) {
    end = slash + 1;
    if (!probe(path.slice(0, end))) return path.slice(0, end);
  }
  return `${path}${SLASH}`;
};
