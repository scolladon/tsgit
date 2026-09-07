/**
 * POSIX-only integration tests pinning `NodeFileSystem`'s write and rename
 * refusal codes. Every row here is driven by a real POSIX errno (`EISDIR`,
 * `EEXIST`, `ENOTDIR`, `ENOTEMPTY`, `EINVAL`) surfaced by the real
 * filesystem through `mkdir`/`writeFile`/`rename` syscalls — Windows maps a
 * different, smaller errno set for the same shapes (no `EINVAL` self-nesting
 * refusal, different directory-vs-file conflict codes), so these exact codes
 * cannot be pinned on the Windows runner. This suite characterises
 * unchanged, pre-existing adapter behaviour: it exists so later guards added
 * to the memory adapter have a verified node oracle to match, and so the
 * two `data.path` anchoring oddities noted below cannot drift silently.
 *
 * @proves
 *   surface: nodeFs.writeRenameRefusals
 *   bucket:  platform-only
 *   unique:  POSIX errno mapping for directory- and symlink-occupant write and rename refusals through NodeFileSystem
 */
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeFileSystem } from '../../../src/adapters/node/node-file-system.js';
import { TsgitError } from '../../../src/domain/index.js';
import { captureError, dataFor } from '../../fixtures/tsgit-error-data.js';

const makeFs = async (): Promise<{
  fs: NodeFileSystem;
  rootDir: string;
  cleanup: () => Promise<void>;
}> => {
  const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-write-rename-'));
  const rootDir = await fsPromises.realpath(tempRoot);
  const fs = new NodeFileSystem(rootDir);
  return {
    fs,
    rootDir,
    cleanup: async () => fsPromises.rm(rootDir, { recursive: true, force: true }),
  };
};

describe('NodeFileSystem — write and rename refusal codes (POSIX)', () => {
  let env: Awaited<ReturnType<typeof makeFs>>;

  beforeEach(async () => {
    env = await makeFs();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  describe('Given an empty directory at the write leaf, When write', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;
      const leaf = nodePath.join(env.rootDir, 'empty-dir');
      await fsPromises.mkdir(leaf);

      // Act
      const caught = await captureError(() => sut.write(leaf, new Uint8Array([1])));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(leaf);
    });
  });

  describe('Given a directory with children at the write leaf, When write', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;
      const leaf = nodePath.join(env.rootDir, 'dir-with-children');
      await fsPromises.mkdir(leaf);
      await fsPromises.writeFile(nodePath.join(leaf, 'child.txt'), 'child');

      // Act
      const caught = await captureError(() => sut.write(leaf, new Uint8Array([1])));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(leaf);
    });
  });

  describe('Given the write leaf is rootDir, When write', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;

      // Act
      const caught = await captureError(() => sut.write(env.rootDir, new Uint8Array([1])));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(env.rootDir);
    });
  });

  describe('Given a directory at the write leaf, When writeUtf8', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;
      const leaf = nodePath.join(env.rootDir, 'dir-for-write-utf8');
      await fsPromises.mkdir(leaf);

      // Act
      const caught = await captureError(() => sut.writeUtf8(leaf, 'hello'));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(leaf);
    });
  });

  describe('Given a directory at the write leaf, When writeStream', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;
      const leaf = nodePath.join(env.rootDir, 'dir-for-write-stream');
      await fsPromises.mkdir(leaf);

      // Act
      const caught = await captureError(() =>
        sut.writeStream(
          leaf,
          (async function* () {
            yield new Uint8Array([1]);
          })(),
        ),
      );

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(leaf);
    });
  });

  describe('Given a directory at the write leaf, When appendUtf8', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;
      const leaf = nodePath.join(env.rootDir, 'dir-for-append-utf8');
      await fsPromises.mkdir(leaf);

      // Act
      const caught = await captureError(() => sut.appendUtf8(leaf, 'hello'));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(leaf);
    });
  });

  describe('Given a live symlink at the write leaf, When write', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;
      const target = nodePath.join(env.rootDir, 'live-target.txt');
      const leaf = nodePath.join(env.rootDir, 'live-link');
      await fsPromises.writeFile(target, Buffer.from([1]));
      await fsPromises.symlink(target, leaf);

      // Act
      const caught = await captureError(() => sut.write(leaf, new Uint8Array([2])));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(leaf);
    });
  });

  describe('Given a dangling symlink at the write leaf, When write', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;
      const leaf = nodePath.join(env.rootDir, 'dangling-link');
      await fsPromises.symlink(nodePath.join(env.rootDir, 'missing-target'), leaf);

      // Act
      const caught = await captureError(() => sut.write(leaf, new Uint8Array([3])));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(leaf);
    });
  });

  describe("Given a regular file at the write leaf's immediate parent, When write", () => {
    it('Then throws FILE_EXISTS', async () => {
      // Arrange
      const sut = env.fs;
      const parentAsFile = nodePath.join(env.rootDir, 'immediate-parent-file');
      await fsPromises.writeFile(parentAsFile, Buffer.from([1]));
      const leaf = nodePath.join(parentAsFile, 'leaf.txt');

      // Act
      const caught = await captureError(() => sut.write(leaf, new Uint8Array([4])));

      // Assert
      expect(dataFor(caught, 'FILE_EXISTS').path).toBe(leaf);
    });
  });

  describe("Given a regular file at the write leaf's grandparent, When write", () => {
    it('Then throws NOT_A_DIRECTORY', async () => {
      // Arrange
      const sut = env.fs;
      const grandparentAsFile = nodePath.join(env.rootDir, 'grandparent-file');
      await fsPromises.writeFile(grandparentAsFile, Buffer.from([1]));
      const leaf = nodePath.join(grandparentAsFile, 'subdir', 'leaf.txt');

      // Act
      const caught = await captureError(() => sut.write(leaf, new Uint8Array([5])));

      // Assert
      expect(dataFor(caught, 'NOT_A_DIRECTORY').path).toBe(leaf);
    });
  });

  describe('Given a file renamed onto an empty directory, When rename', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r1-file');
      const dst = nodePath.join(env.rootDir, 'r1-empty-dir');
      await fsPromises.writeFile(src, 'r1');
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
      const src = nodePath.join(env.rootDir, 'r2-file');
      const dst = nodePath.join(env.rootDir, 'r2-dir-with-children');
      await fsPromises.writeFile(src, 'r2');
      await fsPromises.mkdir(dst);
      await fsPromises.writeFile(nodePath.join(dst, 'child.txt'), 'child');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(src);
    });
  });

  describe('Given a symlink renamed onto an empty directory, When rename', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;
      const target = nodePath.join(env.rootDir, 'r3-target.txt');
      const src = nodePath.join(env.rootDir, 'r3-link');
      const dst = nodePath.join(env.rootDir, 'r3-empty-dir');
      await fsPromises.writeFile(target, 'r3');
      await fsPromises.symlink(target, src);
      await fsPromises.mkdir(dst);

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(src);
    });
  });

  describe('Given a file renamed onto the containment root, When rename', () => {
    it('Then throws PERMISSION_DENIED or DIRECTORY_NOT_EMPTY', async () => {
      // Arrange — a non-directory source renamed onto one of its own
      // ancestors is the one rename(2) shape POSIX does not order: darwin's
      // kernel checks EISDIR before ENOTEMPTY, ubuntu's checks the reverse.
      // Not an emptiness axis — a file onto a *sibling* non-empty directory
      // is PERMISSION_DENIED on both (see the row above).
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r4-file');
      const data = 'r4';
      await fsPromises.writeFile(src, data);

      // Act
      const caught = await captureError(() => sut.rename(src, env.rootDir));

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const { data: errData } = caught as TsgitError;
      expect(['PERMISSION_DENIED', 'DIRECTORY_NOT_EMPTY']).toContain(errData.code);
      const { path } = errData as Extract<
        TsgitError['data'],
        { code: 'PERMISSION_DENIED' | 'DIRECTORY_NOT_EMPTY' }
      >;
      expect(path).toBe(src);
      expect(await fsPromises.readFile(src, 'utf8')).toBe(data);
      expect(await fsPromises.readdir(env.rootDir)).toContain('r4-file');
    });
  });

  describe('Given an empty directory renamed onto a regular file, When rename', () => {
    it('Then throws NOT_A_DIRECTORY', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r5-empty-dir');
      const dst = nodePath.join(env.rootDir, 'r5-file');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(dst, 'r5');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'NOT_A_DIRECTORY').path).toBe(src);
    });
  });

  describe('Given a directory with children renamed onto a regular file, When rename', () => {
    it('Then throws NOT_A_DIRECTORY', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r6-dir-with-children');
      const dst = nodePath.join(env.rootDir, 'r6-file');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(nodePath.join(src, 'child.txt'), 'child');
      await fsPromises.writeFile(dst, 'r6');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'NOT_A_DIRECTORY').path).toBe(src);
    });
  });

  describe('Given a directory renamed onto a symlink, When rename', () => {
    it('Then throws NOT_A_DIRECTORY', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r7-dir');
      const target = nodePath.join(env.rootDir, 'r7-target.txt');
      const dst = nodePath.join(env.rootDir, 'r7-link');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(target, 'r7');
      await fsPromises.symlink(target, dst);

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'NOT_A_DIRECTORY').path).toBe(src);
    });
  });

  describe('Given an empty directory renamed onto a directory with children, When rename', () => {
    it('Then throws DIRECTORY_NOT_EMPTY', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r8-empty-dir');
      const dst = nodePath.join(env.rootDir, 'r8-dir-with-children');
      await fsPromises.mkdir(src);
      await fsPromises.mkdir(dst);
      await fsPromises.writeFile(nodePath.join(dst, 'child.txt'), 'child');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'DIRECTORY_NOT_EMPTY').path).toBe(src);
    });
  });

  describe('Given a directory with children renamed onto a directory with children, When rename', () => {
    it('Then throws DIRECTORY_NOT_EMPTY', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r9-src-dir');
      const dst = nodePath.join(env.rootDir, 'r9-dst-dir');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(nodePath.join(src, 'src-child.txt'), 'src-child');
      await fsPromises.mkdir(dst);
      await fsPromises.writeFile(nodePath.join(dst, 'dst-child.txt'), 'dst-child');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'DIRECTORY_NOT_EMPTY').path).toBe(src);
    });
  });

  describe('Given a directory renamed onto its own parent, When rename', () => {
    it('Then throws DIRECTORY_NOT_EMPTY', async () => {
      // Arrange
      const sut = env.fs;
      const parent = nodePath.join(env.rootDir, 'r10-parent');
      const src = nodePath.join(parent, 'r10-child');
      await fsPromises.mkdir(parent);
      await fsPromises.mkdir(src);

      // Act
      const caught = await captureError(() => sut.rename(src, parent));

      // Assert
      expect(dataFor(caught, 'DIRECTORY_NOT_EMPTY').path).toBe(src);
    });
  });

  describe('Given a directory with children renamed onto the containment root, When rename', () => {
    it('Then throws DIRECTORY_NOT_EMPTY', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r11-dir-with-children');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(nodePath.join(src, 'child.txt'), 'child');

      // Act
      const caught = await captureError(() => sut.rename(src, env.rootDir));

      // Assert
      expect(dataFor(caught, 'DIRECTORY_NOT_EMPTY').path).toBe(src);
    });
  });

  describe('Given an absent path renamed onto anything, When rename', () => {
    it('Then throws FILE_NOT_FOUND', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r12-missing-src');
      const dst = nodePath.join(env.rootDir, 'r12-dst');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'FILE_NOT_FOUND').path).toBe(src);
    });
  });

  describe('Given a directory renamed onto an absent path inside itself, When rename', () => {
    it('Then throws UNSUPPORTED_OPERATION with no path', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r13-dir');
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
    it('Then throws UNSUPPORTED_OPERATION with no path', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r14-dir');
      const dst = nodePath.join(src, 'nested-existing');
      await fsPromises.mkdir(src);
      await fsPromises.mkdir(dst);

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      const data = dataFor(caught, 'UNSUPPORTED_OPERATION');
      expect(data.operation).toBe('filesystem');
      expect(data.reason).toBe('EINVAL');
    });
  });

  describe('Given the containment root renamed onto a fresh name inside it, When rename', () => {
    it('Then throws UNSUPPORTED_OPERATION with no path', async () => {
      // Arrange
      const sut = env.fs;
      const dst = nodePath.join(env.rootDir, 'r15-fresh');

      // Act
      const caught = await captureError(() => sut.rename(env.rootDir, dst));

      // Assert
      const data = dataFor(caught, 'UNSUPPORTED_OPERATION');
      expect(data.operation).toBe('filesystem');
      expect(data.reason).toBe('EINVAL');
    });
  });

  describe('Given a file renamed onto a destination whose immediate parent is a regular file, When rename', () => {
    it('Then throws FILE_EXISTS anchored on src', async () => {
      // Arrange — anchoring oddity, pinned deliberately: the underlying
      // EEXIST originates from resolving `dst`'s parent, but `rename`'s
      // error-mapping path is always anchored on `src`.
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r16-file');
      const parentAsFile = nodePath.join(env.rootDir, 'r16-parent-file');
      await fsPromises.writeFile(src, 'r16');
      await fsPromises.writeFile(parentAsFile, 'r16-parent');
      const dst = nodePath.join(parentAsFile, 'r16-leaf');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'FILE_EXISTS').path).toBe(src);
    });
  });

  describe('Given a file renamed onto a destination whose grandparent is a regular file, When rename', () => {
    it('Then throws NOT_A_DIRECTORY anchored on dst', async () => {
      // Arrange — the second anchoring oddity: this refusal is raised
      // while resolving `dst` itself, before `src` re-enters the picture,
      // so `data.path` is `dst` here rather than `src`.
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r17-file');
      const grandparentAsFile = nodePath.join(env.rootDir, 'r17-grandparent-file');
      await fsPromises.writeFile(src, 'r17');
      await fsPromises.writeFile(grandparentAsFile, 'r17-grandparent');
      const dst = nodePath.join(grandparentAsFile, 'subdir', 'r17-leaf');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'NOT_A_DIRECTORY').path).toBe(dst);
    });
  });

  describe('Given a source whose immediate parent is a regular file renamed onto a fresh name, When rename', () => {
    it('Then throws NOT_A_DIRECTORY anchored on src', async () => {
      // Arrange
      const sut = env.fs;
      const parentAsFile = nodePath.join(env.rootDir, 'r18-parent-file');
      await fsPromises.writeFile(parentAsFile, 'r18-parent');
      const src = nodePath.join(parentAsFile, 'r18-leaf');
      const dst = nodePath.join(env.rootDir, 'r18-fresh');

      // Act
      const caught = await captureError(() => sut.rename(src, dst));

      // Assert
      expect(dataFor(caught, 'NOT_A_DIRECTORY').path).toBe(src);
    });
  });

  describe('Given a directory with children renamed onto an empty directory, When rename', () => {
    it('Then succeeds, replacing: every child lands under dst, none remains under src', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'p1-src-dir');
      const dst = nodePath.join(env.rootDir, 'p1-dst-dir');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(nodePath.join(src, 'child.txt'), 'child-bytes');
      await fsPromises.mkdir(dst);

      // Act
      await sut.rename(src, dst);

      // Assert
      expect(await sut.exists(src)).toBe(false);
      expect(await sut.readUtf8(nodePath.join(dst, 'child.txt'))).toBe('child-bytes');
    });
  });

  describe('Given a regular file renamed onto itself, When rename', () => {
    it('Then succeeds, no-op: bytes unchanged', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'p2-file');
      await fsPromises.writeFile(src, 'p2-bytes');

      // Act
      await sut.rename(src, src);

      // Assert
      expect(await sut.readUtf8(src)).toBe('p2-bytes');
    });
  });

  describe('Given a directory with children renamed onto itself, When rename', () => {
    it('Then succeeds, no-op: every child still reachable', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'p3-dir');
      await fsPromises.mkdir(src);
      await fsPromises.writeFile(nodePath.join(src, 'child.txt'), 'p3-child');

      // Act
      await sut.rename(src, src);

      // Assert
      expect(await sut.exists(nodePath.join(src, 'child.txt'))).toBe(true);
    });
  });

  describe('Given a directory with a nested subtree renamed onto a fresh name, When rename', () => {
    it('Then succeeds: whole subtree moves', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'p4-src-dir');
      const nested = nodePath.join(src, 'nested');
      await fsPromises.mkdir(nested, { recursive: true });
      await fsPromises.writeFile(nodePath.join(nested, 'deep.txt'), 'p4-deep');
      const dst = nodePath.join(env.rootDir, 'p4-fresh-name');

      // Act
      await sut.rename(src, dst);

      // Assert
      expect(await sut.exists(src)).toBe(false);
      expect(await sut.readUtf8(nodePath.join(dst, 'nested', 'deep.txt'))).toBe('p4-deep');
    });
  });

  describe('Given an empty directory renamed onto a fresh name, When rename', () => {
    it('Then succeeds', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'p5-empty-dir');
      const dst = nodePath.join(env.rootDir, 'p5-fresh-name');
      await fsPromises.mkdir(src);

      // Act
      await sut.rename(src, dst);

      // Assert
      expect(await sut.exists(src)).toBe(false);
      expect(await sut.exists(dst)).toBe(true);
    });
  });
});
