import type { FileSystem } from './file-system.js';

/** The read-only filesystem surface an object source (primary or alternate) is read through. */
export type ObjectSourceReader = Pick<
  FileSystem,
  | 'read'
  | 'readUtf8'
  | 'readSlice'
  | 'readdir'
  | 'stat'
  | 'lstat'
  | 'exists'
  | 'readlink'
  | 'openWithNoFollow'
>;

export type ObjectSourceAccess = ObjectSourceReader & Pick<FileSystem, 'utimeNow'>;

/** What resolving an alternate's path needs: link and stat inspection only. */
export type AlternatePathProbe = Pick<FileSystem, 'lstat' | 'readlink' | 'stat'>;
