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
