import { invalidFileMode } from './error.js';

export const FILE_MODE = {
  REGULAR: '100644',
  EXECUTABLE: '100755',
  SYMLINK: '120000',
  DIRECTORY: '40000',
  GITLINK: '160000',
} as const;

export type FileMode = (typeof FILE_MODE)[keyof typeof FILE_MODE];

const VALID_MODES: ReadonlySet<string> = new Set(Object.values(FILE_MODE));

const NORMALIZE_MAP: ReadonlyMap<string, FileMode> = new Map([['040000', FILE_MODE.DIRECTORY]]);

export function validateFileMode(mode: string): FileMode {
  if (!VALID_MODES.has(mode)) {
    throw invalidFileMode(mode);
  }
  return mode as FileMode;
}

export function normalizeFileMode(mode: string): FileMode {
  const normalized = NORMALIZE_MAP.get(mode) ?? mode;
  return validateFileMode(normalized);
}

export function isDirectory(mode: FileMode): boolean {
  return mode === FILE_MODE.DIRECTORY;
}

/**
 * Derive a working-tree file's git mode from its `lstat`. A symbolic link is
 * `120000` regardless of its permission bits; a regular file is `100755` when
 * any of the `0o111` execute bits is set, else `100644`. This is the single
 * definition staging and the working-tree comparison both use, so an added file
 * and a later modified-check agree on the mode.
 */
export function deriveWorkingMode(stat: {
  readonly isSymbolicLink: boolean;
  readonly mode: number;
}): FileMode {
  if (stat.isSymbolicLink) return FILE_MODE.SYMLINK;
  return (stat.mode & 0o111) !== 0 ? FILE_MODE.EXECUTABLE : FILE_MODE.REGULAR;
}
