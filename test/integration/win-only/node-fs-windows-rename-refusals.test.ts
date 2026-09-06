/**
 * Real-NTFS integration tests pinning `NodeFileSystem`'s emulated rename
 * kind rules — the Windows mirror of
 * `test/integration/posix-only/node-fs-write-rename-refusals.test.ts`. The
 * node adapter emulates POSIX's `rename(2)` kind rules on a platform whose
 * own rename does not honour them, and real NTFS through the composed
 * adapter is the only place that emulation meets the platform it targets:
 * none of these codes can be pinned anywhere except a real Windows runner.
 *
 * @proves
 *   surface: nodeFs.windowsRenameRefusals
 *   bucket:  platform-only
 *   unique:  the POSIX rename kind rules the node adapter emulates on NTFS
 */
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeFileSystem } from '../../../src/adapters/node/node-file-system.js';
import { captureError, dataFor } from '../../fixtures/tsgit-error-data.js';

const makeFs = async (): Promise<{
  fs: NodeFileSystem;
  rootDir: string;
  cleanup: () => Promise<void>;
}> => {
  const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-win-rename-'));
  const rootDir = await fsPromises.realpath(tempRoot);
  const fs = new NodeFileSystem(rootDir);
  return {
    fs,
    rootDir,
    cleanup: async () => fsPromises.rm(rootDir, { recursive: true, force: true }),
  };
};

/**
 * Probes whether the runner can create symlinks. `fs.symlink` requires
 * developer-mode or admin on Windows; GitHub Actions' `windows-latest`
 * image has developer-mode enabled but we don't bet the suite on it.
 */
const canCreateSymlinks = async (): Promise<boolean> => {
  const probeRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-symprobe-'));
  try {
    const target = nodePath.join(probeRoot, 'target.bin');
    const link = nodePath.join(probeRoot, 'link.bin');
    await fsPromises.writeFile(target, Buffer.from([1]));
    try {
      await fsPromises.symlink(target, link);
      return true;
    } catch {
      return false;
    }
  } finally {
    await fsPromises.rm(probeRoot, { recursive: true, force: true });
  }
};

/** Readlink text can carry either separator on Windows; compare loosely. */
const normalizeLinkText = (value: string): string => value.replace(/\\/g, '/');

describe('NodeFileSystem — rename refusal codes (Windows)', () => {
  let env: Awaited<ReturnType<typeof makeFs>>;

  beforeEach(async () => {
    env = await makeFs();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  describe('Given an empty directory renamed onto a regular file, When rename', () => {
    it('Then throws NOT_A_DIRECTORY, destination bytes byte-identical', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr1-empty-dir');
      const dst = nodePath.join(env.rootDir, 'wr1-file');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(dst, 'wr1-bytes');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'NOT_A_DIRECTORY').path).toBe(src);
      expect(await fsPromises.readFile(dst, 'utf8')).toBe('wr1-bytes');
    });
  });

  describe('Given a directory with a child renamed onto a regular file, When rename', () => {
    it('Then throws NOT_A_DIRECTORY, the child still under src', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr2-dir-with-child');
      const child = nodePath.join(src, 'child.txt');
      const dst = nodePath.join(env.rootDir, 'wr2-file');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(child, 'wr2-child');
      await fsPromises.writeFile(dst, 'wr2-bytes');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'NOT_A_DIRECTORY').path).toBe(src);
      expect(await fsPromises.readFile(child, 'utf8')).toBe('wr2-child');
      expect(await fsPromises.readFile(dst, 'utf8')).toBe('wr2-bytes');
    });
  });

  describe('Given a directory renamed onto a symlink, When rename', () => {
    it('Then throws NOT_A_DIRECTORY, the link target intact', async ({ skip }) => {
      if (!(await canCreateSymlinks())) {
        skip();
        return;
      }

      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr3-dir');
      const target = nodePath.join(env.rootDir, 'wr3-target.txt');
      const dst = nodePath.join(env.rootDir, 'wr3-link');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(target, 'wr3-bytes');
      await fsPromises.symlink(target, dst);

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'NOT_A_DIRECTORY').path).toBe(src);
      expect(normalizeLinkText(await sut.readlink(dst))).toBe(normalizeLinkText(target));
    });
  });

  describe('Given an empty directory renamed onto a non-empty directory, When rename', () => {
    it('Then throws DIRECTORY_NOT_EMPTY, neither tree merged', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr4-empty-dir');
      const dst = nodePath.join(env.rootDir, 'wr4-dir-with-child');
      const dstChild = nodePath.join(dst, 'dst-child.txt');
      await fsPromises.mkdir(src);
      await fsPromises.mkdir(dst);
      await fsPromises.writeFile(dstChild, 'wr4-dst-child');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'DIRECTORY_NOT_EMPTY').path).toBe(src);
      expect(await fsPromises.readdir(dst)).toEqual(['dst-child.txt']);
    });
  });

  describe('Given a directory with a child renamed onto a non-empty directory, When rename', () => {
    it('Then throws DIRECTORY_NOT_EMPTY, each tree holds exactly its own child', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr5-src-dir');
      const dst = nodePath.join(env.rootDir, 'wr5-dst-dir');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(nodePath.join(src, 'src-child.txt'), 'wr5-src-child');
      await fsPromises.mkdir(dst);
      await fsPromises.writeFile(nodePath.join(dst, 'dst-child.txt'), 'wr5-dst-child');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'DIRECTORY_NOT_EMPTY').path).toBe(src);
      expect(await fsPromises.readdir(src)).toEqual(['src-child.txt']);
      expect(await fsPromises.readdir(dst)).toEqual(['dst-child.txt']);
    });
  });

  describe('Given a directory renamed onto its own parent, When rename', () => {
    it('Then throws DIRECTORY_NOT_EMPTY, nothing moved', async () => {
      // Arrange
      const sut = env.fs;
      const parent = nodePath.join(env.rootDir, 'wr6-parent');
      const src = nodePath.join(parent, 'wr6-child');
      await fsPromises.mkdir(parent);
      await fsPromises.mkdir(src);

      // Act
      const caught = await captureError(() => sut.rename(src, parent));

      // Assert
      expect(dataFor(caught, 'DIRECTORY_NOT_EMPTY').path).toBe(src);
      expect(await fsPromises.readdir(parent)).toEqual(['wr6-child']);
    });
  });

  describe('Given a directory with a child renamed onto the containment root, When rename', () => {
    it('Then throws DIRECTORY_NOT_EMPTY, nothing moved', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr7-dir-with-child');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(nodePath.join(src, 'child.txt'), 'wr7-child');

      // Act
      const caught = await captureError(() => sut.rename(src, env.rootDir));

      // Assert
      expect(dataFor(caught, 'DIRECTORY_NOT_EMPTY').path).toBe(src);
      expect(await fsPromises.readdir(src)).toEqual(['child.txt']);
    });
  });

  describe('Given a file renamed onto an empty directory, When rename', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr8-file');
      const dst = nodePath.join(env.rootDir, 'wr8-empty-dir');
      await fsPromises.writeFile(src, 'wr8-bytes');
      await fsPromises.mkdir(dst);

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(src);
    });
  });

  describe('Given a file renamed onto a directory with children, When rename', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr9-file');
      const dst = nodePath.join(env.rootDir, 'wr9-dir-with-children');
      await fsPromises.writeFile(src, 'wr9-bytes');
      await fsPromises.mkdir(dst);
      await fsPromises.writeFile(nodePath.join(dst, 'child.txt'), 'wr9-child');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(src);
    });
  });

  describe('Given a symlink renamed onto an empty directory, When rename', () => {
    it('Then throws PERMISSION_DENIED', async ({ skip }) => {
      if (!(await canCreateSymlinks())) {
        skip();
        return;
      }

      // Arrange
      const sut = env.fs;
      const target = nodePath.join(env.rootDir, 'wr10-target.txt');
      const src = nodePath.join(env.rootDir, 'wr10-link');
      const dst = nodePath.join(env.rootDir, 'wr10-empty-dir');
      await fsPromises.writeFile(target, 'wr10-bytes');
      await fsPromises.symlink(target, src);
      await fsPromises.mkdir(dst);

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(src);
    });
  });

  describe('Given a file renamed onto the containment root, When rename', () => {
    it('Then throws PERMISSION_DENIED — the Windows shape is a single code', async () => {
      // Arrange — unlike the POSIX file's enumerated pair (darwin and ubuntu
      // disagree there), Windows and darwin agree on exactly one code for
      // this arrangement.
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr11-file');
      await fsPromises.writeFile(src, 'wr11-bytes');

      // Act
      const caught = await captureError(() => sut.rename(src, env.rootDir));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(src);
    });
  });

  describe('Given a directory renamed onto an absent path inside itself, When rename', () => {
    it('Then throws UNSUPPORTED_OPERATION with no path', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr12-dir');
      const dst = nodePath.join(src, 'nested-absent');
      await fsPromises.mkdir(src);

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      const data = dataFor(caught, 'UNSUPPORTED_OPERATION');
      expect(data.operation).toBe('filesystem');
      expect(data.reason).toBe('EINVAL');
    });
  });

  describe('Given a directory renamed onto an existing directory inside itself, When rename', () => {
    it('Then throws UNSUPPORTED_OPERATION with no path, the inner directory still exists', async () => {
      // Arrange — proves the containment arm delegated instead of taking the
      // replace arm and destroying the inner directory.
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr13-dir');
      const dst = nodePath.join(src, 'nested-existing');
      await fsPromises.mkdir(src);
      await fsPromises.mkdir(dst);

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      const data = dataFor(caught, 'UNSUPPORTED_OPERATION');
      expect(data.operation).toBe('filesystem');
      expect(data.reason).toBe('EINVAL');
      expect(await sut.exists(dst)).toBe(true);
    });
  });

  describe('Given a directory renamed onto an existing file inside itself, When rename', () => {
    it('Then throws UNSUPPORTED_OPERATION with no path, the file bytes intact', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr14-dir');
      const dst = nodePath.join(src, 'nested-file');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(dst, 'wr14-bytes');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      const data = dataFor(caught, 'UNSUPPORTED_OPERATION');
      expect(data.operation).toBe('filesystem');
      expect(data.reason).toBe('EINVAL');
      expect(await fsPromises.readFile(dst, 'utf8')).toBe('wr14-bytes');
    });
  });

  describe('Given a directory renamed onto an existing symlink inside itself, When rename', () => {
    it('Then throws UNSUPPORTED_OPERATION with no path, the link intact', async ({ skip }) => {
      if (!(await canCreateSymlinks())) {
        skip();
        return;
      }
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr14b-dir');
      const target = nodePath.join(env.rootDir, 'wr14b-target');
      const dst = nodePath.join(src, 'nested-link');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(target, 'wr14b-bytes');
      await fsPromises.symlink(target, dst);

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      const data = dataFor(caught, 'UNSUPPORTED_OPERATION');
      expect(data.operation).toBe('filesystem');
      expect(data.reason).toBe('EINVAL');
      expect((await fsPromises.lstat(dst)).isSymbolicLink()).toBe(true);
      expect(await fsPromises.readFile(target, 'utf8')).toBe('wr14b-bytes');
    });
  });

  describe('Given a directory renamed onto its own name spelled with a trailing dot, When rename', () => {
    it('Then it resolves as a no-op and the directory keeps its child', async () => {
      // Arrange — Win32 strips a trailing dot, so both spellings are one entry;
      // the adapter must see the identity before it removes anything.
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr18-dir');
      const child = nodePath.join(src, 'child.txt');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(child, 'wr18-child');

      // Act
      await sut.rename(src, `${src}.`);

      // Assert
      expect((await fsPromises.lstat(src)).isDirectory()).toBe(true);
      expect(await fsPromises.readFile(child, 'utf8')).toBe('wr18-child');
    });
  });

  describe('Given the containment root renamed onto a fresh name inside it, When rename', () => {
    it('Then throws UNSUPPORTED_OPERATION with no path', async () => {
      // Arrange
      const sut = env.fs;
      const dst = nodePath.join(env.rootDir, 'wr15-fresh');

      // Act
      const caught = await captureError(() => sut.rename(env.rootDir, dst));

      // Assert
      const data = dataFor(caught, 'UNSUPPORTED_OPERATION');
      expect(data.operation).toBe('filesystem');
      expect(data.reason).toBe('EINVAL');
    });
  });

  describe('Given a file renamed onto a destination whose grandparent is a regular file, When rename', () => {
    it('Then throws NOT_A_DIRECTORY anchored on src — the first Windows-shaped oddity', async () => {
      // Arrange — the POSIX sibling anchors this refusal on dst; on Windows
      // the code is unchanged but the anchor flips to src.
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wr16-file');
      const grandparentAsFile = nodePath.join(env.rootDir, 'wr16-grandparent-file');
      await fsPromises.writeFile(src, 'wr16-bytes');
      await fsPromises.writeFile(grandparentAsFile, 'wr16-grandparent');
      const dst = nodePath.join(grandparentAsFile, 'subdir', 'wr16-leaf');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'NOT_A_DIRECTORY').path).toBe(src);
    });
  });

  describe('Given a source whose immediate parent is a regular file renamed onto a fresh name, When rename', () => {
    it('Then throws FILE_NOT_FOUND anchored on src — the second Windows-shaped oddity', async () => {
      // Arrange — the POSIX sibling refuses NOT_A_DIRECTORY on the same
      // anchor; on Windows only the code differs.
      const sut = env.fs;
      const parentAsFile = nodePath.join(env.rootDir, 'wr17-parent-file');
      await fsPromises.writeFile(parentAsFile, 'wr17-parent');
      const src = nodePath.join(parentAsFile, 'wr17-leaf');
      const dst = nodePath.join(env.rootDir, 'wr17-fresh');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'FILE_NOT_FOUND').path).toBe(src);
    });
  });

  describe('Given a directory with a child renamed onto an empty directory, When rename', () => {
    it('Then succeeds, the child reachable under dst and src gone', async () => {
      // Arrange — the row this whole leg exists for.
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wp1-src-dir');
      const dst = nodePath.join(env.rootDir, 'wp1-dst-dir');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(nodePath.join(src, 'child.txt'), 'wp1-child-bytes');
      await fsPromises.mkdir(dst);

      // Act
      await sut.rename(src, dst);

      // Assert
      expect(await sut.exists(src)).toBe(false);
      expect(await sut.readUtf8(nodePath.join(dst, 'child.txt'))).toBe('wp1-child-bytes');
    });
  });

  describe('Given a regular file renamed onto itself, When rename', () => {
    it('Then succeeds, bytes unchanged', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wp2-file');
      await fsPromises.writeFile(src, 'wp2-bytes');

      // Act
      await sut.rename(src, src);

      // Assert
      expect(await sut.readUtf8(src)).toBe('wp2-bytes');
    });
  });

  describe('Given a directory with children renamed onto itself, When rename', () => {
    it('Then succeeds, every child still reachable', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wp3-dir');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(nodePath.join(src, 'child.txt'), 'wp3-child');

      // Act
      await sut.rename(src, src);

      // Assert
      expect(await sut.exists(nodePath.join(src, 'child.txt'))).toBe(true);
    });
  });

  describe('Given a directory with a nested subtree renamed onto a fresh name, When rename', () => {
    it('Then succeeds, the whole subtree moves', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wp4-src-dir');
      const nested = nodePath.join(src, 'nested');
      await fsPromises.mkdir(nested, { recursive: true });
      await fsPromises.writeFile(nodePath.join(nested, 'deep.txt'), 'wp4-deep');
      const dst = nodePath.join(env.rootDir, 'wp4-fresh-name');

      // Act
      await sut.rename(src, dst);

      // Assert
      expect(await sut.exists(src)).toBe(false);
      expect(await sut.readUtf8(nodePath.join(dst, 'nested', 'deep.txt'))).toBe('wp4-deep');
    });
  });

  describe('Given an empty directory renamed onto a fresh name, When rename', () => {
    it('Then succeeds', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'wp5-empty-dir');
      const dst = nodePath.join(env.rootDir, 'wp5-fresh-name');
      await fsPromises.mkdir(src);

      // Act
      await sut.rename(src, dst);

      // Assert
      expect(await sut.exists(src)).toBe(false);
      expect(await sut.exists(dst)).toBe(true);
    });
  });

  describe('Given a live symlink at the writeExclusive leaf, When writeExclusive', () => {
    it('Then throws FILE_EXISTS, the link still points where it did', async ({ skip }) => {
      if (!(await canCreateSymlinks())) {
        skip();
        return;
      }

      // Arrange
      const sut = env.fs;
      const target = nodePath.join(env.rootDir, 'we1-target.txt');
      const leaf = nodePath.join(env.rootDir, 'we1-link');
      await fsPromises.writeFile(target, Buffer.from([1]));
      await fsPromises.symlink(target, leaf);

      // Act
      const caught = await captureError(() => sut.writeExclusive(leaf, new Uint8Array([2])));

      // Assert
      expect(dataFor(caught, 'FILE_EXISTS').path).toBe(leaf);
      expect(normalizeLinkText(await sut.readlink(leaf))).toBe(normalizeLinkText(target));
    });
  });

  describe('Given a dangling symlink at the writeExclusive leaf, When writeExclusive', () => {
    it('Then throws FILE_EXISTS, the link target still absent', async ({ skip }) => {
      if (!(await canCreateSymlinks())) {
        skip();
        return;
      }

      // Arrange — the half the platform's own exclusive open gets wrong: a
      // raw `fs.open(path, 'wx')` over a dangling link follows it and
      // materialises the target on Windows.
      const sut = env.fs;
      const missingTarget = nodePath.join(env.rootDir, 'missing-target');
      const leaf = nodePath.join(env.rootDir, 'we2-link');
      await fsPromises.symlink(missingTarget, leaf);

      // Act
      const caught = await captureError(() => sut.writeExclusive(leaf, new Uint8Array([3])));

      // Assert
      expect(dataFor(caught, 'FILE_EXISTS').path).toBe(leaf);
      expect(await sut.exists(missingTarget)).toBe(false);
    });
  });

  describe('Given a live symlink at the write leaf, When write', () => {
    it('Then throws PERMISSION_DENIED', async ({ skip }) => {
      if (!(await canCreateSymlinks())) {
        skip();
        return;
      }

      // Arrange
      const sut = env.fs;
      const target = nodePath.join(env.rootDir, 'we3-target.txt');
      const leaf = nodePath.join(env.rootDir, 'we3-link');
      await fsPromises.writeFile(target, Buffer.from([1]));
      await fsPromises.symlink(target, leaf);

      // Act
      const caught = await captureError(() => sut.write(leaf, new Uint8Array([2])));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(leaf);
    });
  });

  describe('Given a dangling symlink at the write leaf, When write', () => {
    it('Then throws PERMISSION_DENIED, the target still absent', async ({ skip }) => {
      if (!(await canCreateSymlinks())) {
        skip();
        return;
      }

      // Arrange
      const sut = env.fs;
      const missingTarget = nodePath.join(env.rootDir, 'missing-target');
      const leaf = nodePath.join(env.rootDir, 'we4-link');
      await fsPromises.symlink(missingTarget, leaf);

      // Act
      const caught = await captureError(() => sut.write(leaf, new Uint8Array([3])));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(leaf);
      expect(await sut.exists(missingTarget)).toBe(false);
    });
  });
});
