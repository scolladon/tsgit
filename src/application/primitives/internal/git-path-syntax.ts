/** A path split at git's `offset_1st_component`; the root's separators are git's `/`. */
export interface RootedPath {
  readonly root: string;
  readonly rest: string;
}

/** How a git build reads a path: POSIX builds know only `/`, Windows builds also `\`, drives and UNC. */
export interface GitPathSyntax {
  /** git's `is_absolute_path`. */
  readonly isAbsolute: (path: string) => boolean;
  /** git's `get_root_part`: the root (converted to `/` separators) and what follows it. */
  readonly splitRoot: (path: string) => RootedPath;
  /** git's `get_next_component` loop: the non-empty names between separators. */
  readonly components: (path: string) => string[];
}

const POSIX_SEPARATOR = '/';
const WINDOWS_SEPARATORS = /[\\/]/;
const WINDOWS_SEPARATORS_GLOBAL = /\\/g;
const DRIVE_COLON = ':';
const UNC_SERVER_START = 2;
const NON_ASCII_RUN = /^[\u0080-\uffff]+/;
/** git scans at most four bytes of a non-ASCII drive letter before its colon. */
const MAX_DRIVE_LETTER_BYTES = 4;

const nonEmpty = (name: string): boolean => name !== '';
const utf8 = new TextEncoder();

export const posixGitPathSyntax: GitPathSyntax = {
  isAbsolute: (path) => path.startsWith(POSIX_SEPARATOR),
  splitRoot: (path) =>
    path.startsWith(POSIX_SEPARATOR)
      ? { root: POSIX_SEPARATOR, rest: path.slice(1) }
      : { root: '', rest: path },
  components: (path) => path.split(POSIX_SEPARATOR).filter(nonEmpty),
};

const isWindowsSeparator = (char: string | undefined): boolean => char === '/' || char === '\\';

/** git's `win32_has_dos_drive_prefix`: any ASCII byte, or a short non-ASCII run, then `:`. */
const drivePrefixLength = (path: string): number => {
  const run = NON_ASCII_RUN.exec(path)?.[0];
  if (run === undefined) return path[1] === DRIVE_COLON ? 2 : 0;
  const fits = utf8.encode(run).length <= MAX_DRIVE_LETTER_BYTES;
  return fits && path[run.length] === DRIVE_COLON ? run.length + 1 : 0;
};

const indexOfWindowsSeparator = (path: string, from: number): number => {
  const found = path.slice(from).search(WINDOWS_SEPARATORS);
  return found < 0 ? found : from + found;
};

/** End of a `\\server\share` prefix, or `undefined` for a share-less, malformed one. */
const uncShareEnd = (path: string): number | undefined => {
  const serverEnd = indexOfWindowsSeparator(path, UNC_SERVER_START);
  if (serverEnd < 0) return undefined;
  const shareEnd = indexOfWindowsSeparator(path, serverEnd + 1);
  return shareEnd < 0 ? path.length : shareEnd;
};

/** git's `win32_offset_1st_component`. */
const windowsRootLength = (path: string): number => {
  const drive = drivePrefixLength(path);
  const isUnc = drive === 0 && isWindowsSeparator(path[0]) && isWindowsSeparator(path[1]);
  const end = isUnc ? uncShareEnd(path) : drive;
  if (end === undefined) return 0;
  return isWindowsSeparator(path[end]) ? end + 1 : end;
};

export const windowsGitPathSyntax: GitPathSyntax = {
  isAbsolute: (path) => isWindowsSeparator(path[0]) || drivePrefixLength(path) > 0,
  splitRoot: (path) => {
    const length = windowsRootLength(path);
    return {
      root: path.slice(0, length).replace(WINDOWS_SEPARATORS_GLOBAL, POSIX_SEPARATOR),
      rest: path.slice(length),
    };
  },
  components: (path) => path.split(WINDOWS_SEPARATORS).filter(nonEmpty),
};

/** The syntax of the git build a host emulates: Windows when it says so, POSIX otherwise. */
export const gitPathSyntaxOf = (host: { readonly windowsPathSyntax?: boolean }): GitPathSyntax =>
  host.windowsPathSyntax === true ? windowsGitPathSyntax : posixGitPathSyntax;
