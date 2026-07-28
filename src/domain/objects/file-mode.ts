import { decode, encode } from './encoding.js';
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

// Zero-copy byte-range matcher: the raw tree cursor calls this per emitted
// entry and must not decode a string on the accepted path. Dispatch on
// length first, then compare bytes directly against the mode's own encoding
// (computed once at module load, not per call).
const DIRECTORY_5_BYTES = encode(FILE_MODE.DIRECTORY);
const DIRECTORY_6_BYTES = encode('040000');
const REGULAR_6_BYTES = encode(FILE_MODE.REGULAR);
const EXECUTABLE_6_BYTES = encode(FILE_MODE.EXECUTABLE);
const SYMLINK_6_BYTES = encode(FILE_MODE.SYMLINK);
const GITLINK_6_BYTES = encode(FILE_MODE.GITLINK);

export function matchFileModeBytes(buf: Uint8Array, start: number, end: number): FileMode {
  const length = end - start;
  if (length === 5 && matchesBytes(buf, start, DIRECTORY_5_BYTES)) return FILE_MODE.DIRECTORY;
  if (length === 6) {
    const matched = matchSixByteMode(buf, start);
    if (matched !== undefined) return matched;
  }
  throw invalidFileMode(decode(buf.subarray(start, end)));
}

function matchSixByteMode(buf: Uint8Array, start: number): FileMode | undefined {
  if (matchesBytes(buf, start, REGULAR_6_BYTES)) return FILE_MODE.REGULAR;
  if (matchesBytes(buf, start, EXECUTABLE_6_BYTES)) return FILE_MODE.EXECUTABLE;
  if (matchesBytes(buf, start, SYMLINK_6_BYTES)) return FILE_MODE.SYMLINK;
  if (matchesBytes(buf, start, GITLINK_6_BYTES)) return FILE_MODE.GITLINK;
  if (matchesBytes(buf, start, DIRECTORY_6_BYTES)) return FILE_MODE.DIRECTORY;
  return undefined;
}

function matchesBytes(buf: Uint8Array, start: number, target: Uint8Array): boolean {
  for (let i = 0; i < target.length; i++) {
    if (buf[start + i] !== target[i]) return false;
  }
  return true;
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
