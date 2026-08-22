import { describe, expect, it } from 'vitest';
import type { FileHandle, FileStat, FileSystem } from '../../../src/ports/file-system.js';

const stubStat: FileStat = {
  ctimeMs: 0,
  mtimeMs: 0,
  dev: 0,
  ino: 0,
  mode: 0,
  uid: 0,
  gid: 0,
  size: 0,
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
};

const stubHandle: FileHandle = {
  read: async () => 0,
  write: async () => {},
  stat: async () => stubStat,
  close: async () => {},
};

// Implements every REQUIRED FileSystem member and deliberately omits
// `atomicRename` — the literal only type-checks if the port declares it
// optional. This is the compile-time obligation the test proves, not a
// runtime behaviour: `npm run check:types` is where an accidental widening
// back to required would be caught.
const requiredOnlyFs: FileSystem = {
  read: async () => new Uint8Array(),
  readSlice: async () => new Uint8Array(),
  readUtf8: async () => '',
  write: async () => {},
  writeStream: async () => {},
  writeExclusive: async () => {},
  writeUtf8: async () => {},
  appendUtf8: async () => {},
  exists: async () => false,
  stat: async () => stubStat,
  lstat: async () => stubStat,
  readdir: async () => [],
  mkdir: async () => {},
  rm: async () => {},
  rename: async () => {},
  readlink: async () => '',
  symlink: async () => {},
  chmod: async () => {},
  rmRecursive: async () => {},
  openWithNoFollow: async () => stubHandle,
  homedir: () => '/home/user',
  xdgConfigHome: () => '/home/user/.config',
  systemConfigPath: () => '/etc/gitconfig',
};

describe('Given a FileSystem test double that implements every required member and omits atomicRename', () => {
  describe('When atomicRename is read off the value', () => {
    it('Then it is undefined — the port does not require the capability', () => {
      // Arrange
      const sut = requiredOnlyFs;

      // Act
      const result = sut.atomicRename;

      // Assert
      expect(result).toBeUndefined();
    });
  });
});
