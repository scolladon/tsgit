import type { FileMode } from '../objects/index.js';
import { FILE_MODE } from '../objects/index.js';

export type ModeKind = 'file' | 'symlink' | 'directory' | 'gitlink';

export function kindOf(mode: FileMode): ModeKind {
  if (mode === FILE_MODE.REGULAR || mode === FILE_MODE.EXECUTABLE) return 'file';
  if (mode === FILE_MODE.SYMLINK) return 'symlink';
  if (mode === FILE_MODE.DIRECTORY) return 'directory';
  return 'gitlink';
}

export function isSameKind(a: FileMode, b: FileMode): boolean {
  return kindOf(a) === kindOf(b);
}

export function isGitlink(mode: FileMode): boolean {
  return kindOf(mode) === 'gitlink';
}
