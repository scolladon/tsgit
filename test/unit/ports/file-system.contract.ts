import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsgitError } from '../../../src/domain/index.js';
import type { FileSystem } from '../../../src/ports/file-system.js';

export interface FileSystemContractEnv {
  readonly fs: FileSystem;
  readonly rootDir: string;
  readonly getRootDirSibling: () => Promise<string>;
  readonly getExistingInRoot: () => Promise<string>;
  readonly cleanup?: () => Promise<void>;
}

interface PathCall {
  readonly name: string;
  readonly invoke: (env: FileSystemContractEnv, path: string) => Promise<unknown>;
}

const pathCalls: ReadonlyArray<PathCall> = [
  { name: 'read', invoke: (e, p) => e.fs.read(p) },
  { name: 'readSlice', invoke: (e, p) => e.fs.readSlice(p, 0, 1) },
  { name: 'readUtf8', invoke: (e, p) => e.fs.readUtf8(p) },
  { name: 'write', invoke: (e, p) => e.fs.write(p, new Uint8Array()) },
  { name: 'writeExclusive', invoke: (e, p) => e.fs.writeExclusive(p, new Uint8Array()) },
  { name: 'writeUtf8', invoke: (e, p) => e.fs.writeUtf8(p, '') },
  { name: 'appendUtf8', invoke: (e, p) => e.fs.appendUtf8(p, '') },
  { name: 'exists', invoke: (e, p) => e.fs.exists(p) },
  { name: 'stat', invoke: (e, p) => e.fs.stat(p) },
  { name: 'lstat', invoke: (e, p) => e.fs.lstat(p) },
  { name: 'readdir', invoke: (e, p) => e.fs.readdir(p) },
  { name: 'mkdir', invoke: (e, p) => e.fs.mkdir(p) },
  { name: 'rm', invoke: (e, p) => e.fs.rm(p) },
  {
    name: 'rename-src',
    invoke: async (e, p) => {
      const validDst = await e.getExistingInRoot();
      return e.fs.rename(p, `${validDst}-renamed`);
    },
  },
  {
    name: 'rename-dst',
    invoke: async (e, p) => {
      const validSrc = await e.getExistingInRoot();
      return e.fs.rename(validSrc, p);
    },
  },
  { name: 'readlink', invoke: (e, p) => e.fs.readlink(p) },
  { name: 'symlink', invoke: (e, p) => e.fs.symlink('target', p) },
  { name: 'chmod', invoke: (e, p) => e.fs.chmod(p, 0o644) },
  { name: 'rmRecursive', invoke: (e, p) => e.fs.rmRecursive(p) },
];

function assertFileNotFound(err: unknown): void {
  expect(err).toBeInstanceOf(TsgitError);
  expect((err as TsgitError).data.code).toBe('FILE_NOT_FOUND');
}

function assertPermissionDenied(err: unknown): void {
  expect(err).toBeInstanceOf(TsgitError);
  expect((err as TsgitError).data.code).toBe('PERMISSION_DENIED');
}

function assertFileExists(err: unknown): void {
  expect(err).toBeInstanceOf(TsgitError);
  expect((err as TsgitError).data.code).toBe('FILE_EXISTS');
}

function assertNotADirectory(err: unknown): void {
  expect(err).toBeInstanceOf(TsgitError);
  expect((err as TsgitError).data.code).toBe('NOT_A_DIRECTORY');
}

export function fileSystemContractTests(createSut: () => Promise<FileSystemContractEnv>): void {
  describe('FileSystem contract', () => {
    let env: FileSystemContractEnv;

    beforeEach(async () => {
      env = await createSut();
    });

    afterEach(async () => {
      await env.cleanup?.();
    });

    it('Given written file, When reading, Then returns same bytes', async () => {
      // Arrange
      const path = `${env.rootDir}/file.bin`;
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      // Act
      await env.fs.write(path, data);
      const result = await env.fs.read(path);

      // Assert
      expect(result).toEqual(data);
    });

    it('Given written UTF-8 file, When readUtf8, Then returns same string', async () => {
      // Arrange
      const path = `${env.rootDir}/file.txt`;
      const content = 'hello world';

      // Act
      await env.fs.writeUtf8(path, content);
      const result = await env.fs.readUtf8(path);

      // Assert
      expect(result).toBe(content);
    });

    it('Given non-existent path, When read, Then throws FILE_NOT_FOUND', async () => {
      // Arrange
      const path = `${env.rootDir}/missing.bin`;

      // Act
      try {
        await env.fs.read(path);
        expect.fail('expected FILE_NOT_FOUND');
      } catch (err) {
        // Assert
        assertFileNotFound(err);
      }
    });

    it('Given non-existent path, When stat, Then throws FILE_NOT_FOUND', async () => {
      // Arrange
      const path = `${env.rootDir}/missing.bin`;

      // Act
      try {
        await env.fs.stat(path);
        expect.fail('expected FILE_NOT_FOUND');
      } catch (err) {
        // Assert
        assertFileNotFound(err);
      }
    });

    it('Given non-existent path, When exists, Then returns false', async () => {
      // Arrange
      const path = `${env.rootDir}/missing.bin`;

      // Act
      const result = await env.fs.exists(path);

      // Assert
      expect(result).toBe(false);
    });

    it('Given existing file, When exists, Then returns true', async () => {
      // Arrange
      const path = await env.getExistingInRoot();

      // Act
      const result = await env.fs.exists(path);

      // Assert
      expect(result).toBe(true);
    });

    it('Given written file, When stat, Then size matches data length', async () => {
      // Arrange
      const path = `${env.rootDir}/sized.bin`;
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);

      // Act
      await env.fs.write(path, data);
      const stat = await env.fs.stat(path);

      // Assert
      expect(stat.size).toBe(data.length);
    });

    it('Given written file, When stat, Then isFile is true', async () => {
      // Arrange
      const path = `${env.rootDir}/file.bin`;
      await env.fs.write(path, new Uint8Array([1]));

      // Act
      const stat = await env.fs.stat(path);

      // Assert
      expect(stat.isFile).toBe(true);
    });

    it('Given directory, When stat, Then isDirectory is true', async () => {
      // Arrange
      const path = `${env.rootDir}/subdir`;
      await env.fs.mkdir(path);

      // Act
      const stat = await env.fs.stat(path);

      // Assert
      expect(stat.isDirectory).toBe(true);
    });

    it('Given nested path, When write, Then creates parent directories', async () => {
      // Arrange
      const path = `${env.rootDir}/a/b/c.txt`;
      const data = new Uint8Array([42]);

      // Act
      await env.fs.write(path, data);
      const result = await env.fs.exists(path);

      // Assert
      expect(result).toBe(true);
    });

    it('Given existing file, When write, Then overwrites', async () => {
      // Arrange
      const path = `${env.rootDir}/overwrite.bin`;
      await env.fs.write(path, new Uint8Array([1, 2, 3]));

      // Act
      await env.fs.write(path, new Uint8Array([9, 9]));
      const result = await env.fs.read(path);

      // Assert
      expect(result).toEqual(new Uint8Array([9, 9]));
    });

    it('Given empty Uint8Array, When write then read, Then returns empty array', async () => {
      // Arrange
      const path = `${env.rootDir}/empty.bin`;

      // Act
      await env.fs.write(path, new Uint8Array());
      const result = await env.fs.read(path);

      // Assert
      expect(result).toEqual(new Uint8Array());
    });

    it('Given file, When rm, Then file no longer exists', async () => {
      // Arrange
      const path = `${env.rootDir}/to-remove.bin`;
      await env.fs.write(path, new Uint8Array([1]));

      // Act
      await env.fs.rm(path);
      const result = await env.fs.exists(path);

      // Assert
      expect(result).toBe(false);
    });

    it('Given non-existent path, When rm, Then throws FILE_NOT_FOUND', async () => {
      // Arrange
      const path = `${env.rootDir}/nope.bin`;

      // Act
      try {
        await env.fs.rm(path);
        expect.fail('expected FILE_NOT_FOUND');
      } catch (err) {
        // Assert
        assertFileNotFound(err);
      }
    });

    it('Given file, When rename, Then old path gone, new path exists with same data', async () => {
      // Arrange
      const src = `${env.rootDir}/src.bin`;
      const dst = `${env.rootDir}/dst.bin`;
      const data = new Uint8Array([1, 2, 3]);
      await env.fs.write(src, data);

      // Act
      await env.fs.rename(src, dst);

      // Assert
      expect(await env.fs.exists(src)).toBe(false);
      expect(await env.fs.exists(dst)).toBe(true);
      expect(await env.fs.read(dst)).toEqual(data);
    });

    it('Given rename to existing file, When rename, Then atomically replaces target', async () => {
      // Arrange
      const src = `${env.rootDir}/src.bin`;
      const dst = `${env.rootDir}/dst.bin`;
      const srcData = new Uint8Array([1, 2, 3]);
      await env.fs.write(src, srcData);
      await env.fs.write(dst, new Uint8Array([9, 9, 9]));

      // Act
      await env.fs.rename(src, dst);

      // Assert
      expect(await env.fs.exists(src)).toBe(false);
      expect(await env.fs.read(dst)).toEqual(srcData);
    });

    it('Given existing file, When writeExclusive, Then throws FILE_EXISTS', async () => {
      // Arrange
      const path = await env.getExistingInRoot();

      // Act
      try {
        await env.fs.writeExclusive(path, new Uint8Array([1]));
        expect.fail('expected FILE_EXISTS');
      } catch (err) {
        // Assert
        assertFileExists(err);
      }
    });

    it('Given non-existent path, When writeExclusive, Then creates file', async () => {
      // Arrange
      const path = `${env.rootDir}/new-exclusive.bin`;
      const data = new Uint8Array([1, 2, 3]);

      // Act
      await env.fs.writeExclusive(path, data);

      // Assert
      expect(await env.fs.read(path)).toEqual(data);
    });

    it('Given file with known content, When readSlice(0, 3), Then returns first 3 bytes', async () => {
      // Arrange
      const path = `${env.rootDir}/slice.bin`;
      await env.fs.write(path, new Uint8Array([10, 20, 30, 40, 50]));

      // Act
      const result = await env.fs.readSlice(path, 0, 3);

      // Assert
      expect(result).toEqual(new Uint8Array([10, 20, 30]));
    });

    it('Given file with known content, When readSlice(5, 3), Then returns bytes at offset 5', async () => {
      // Arrange
      const path = `${env.rootDir}/slice.bin`;
      await env.fs.write(path, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

      // Act
      const result = await env.fs.readSlice(path, 5, 3);

      // Assert
      expect(result).toEqual(new Uint8Array([5, 6, 7]));
    });

    it('Given readSlice with offset beyond EOF, When reading, Then returns empty array', async () => {
      // Arrange
      const path = `${env.rootDir}/slice.bin`;
      await env.fs.write(path, new Uint8Array(10));

      // Act
      const result = await env.fs.readSlice(path, 100, 5);

      // Assert
      expect(result).toEqual(new Uint8Array());
    });

    it('Given readSlice with negative offset, When reading, Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const path = `${env.rootDir}/slice.bin`;
      await env.fs.write(path, new Uint8Array([1, 2, 3]));

      // Act
      try {
        await env.fs.readSlice(path, -1, 1);
        expect.fail('expected PERMISSION_DENIED');
      } catch (err) {
        // Assert
        assertPermissionDenied(err);
      }
    });

    it('Given non-existent file, When readSlice, Then throws FILE_NOT_FOUND', async () => {
      // Arrange
      const path = `${env.rootDir}/missing.bin`;

      // Act
      try {
        await env.fs.readSlice(path, 0, 1);
        expect.fail('expected FILE_NOT_FOUND');
      } catch (err) {
        // Assert
        assertFileNotFound(err);
      }
    });

    it('Given directory with files, When readdir, Then returns entries with correct names and isFile flags', async () => {
      // Arrange
      const dir = `${env.rootDir}/listing`;
      await env.fs.mkdir(dir);
      await env.fs.write(`${dir}/a.txt`, new Uint8Array([1]));
      await env.fs.write(`${dir}/b.txt`, new Uint8Array([2]));
      await env.fs.write(`${dir}/c.txt`, new Uint8Array([3]));

      // Act
      const entries = await env.fs.readdir(dir);

      // Assert
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(['a.txt', 'b.txt', 'c.txt']);
      for (const entry of entries) {
        expect(entry.isFile).toBe(true);
        expect(entry.isDirectory).toBe(false);
        expect(entry.isSymbolicLink).toBe(false);
      }
    });

    it("Given freshly-mkdir'd empty subdirectory, When readdir, Then returns empty array", async () => {
      // Arrange
      const dir = `${env.rootDir}/empty-dir`;
      await env.fs.mkdir(dir);

      // Act
      const entries = await env.fs.readdir(dir);

      // Assert
      expect(entries).toEqual([]);
    });

    it('Given non-directory path, When readdir, Then throws NOT_A_DIRECTORY', async () => {
      // Arrange
      const path = `${env.rootDir}/not-a-dir.txt`;
      await env.fs.write(path, new Uint8Array([1]));

      // Act
      try {
        await env.fs.readdir(path);
        expect.fail('expected NOT_A_DIRECTORY');
      } catch (err) {
        // Assert
        assertNotADirectory(err);
      }
    });

    it('Given file of 10 bytes, When readSlice(8, 5), Then returns 2 bytes', async () => {
      // Arrange
      const path = `${env.rootDir}/slice.bin`;
      await env.fs.write(path, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

      // Act
      const result = await env.fs.readSlice(path, 8, 5);

      // Assert
      expect(result).toEqual(new Uint8Array([8, 9]));
    });

    it('Given readSlice with negative length, When reading, Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const path = `${env.rootDir}/slice.bin`;
      await env.fs.write(path, new Uint8Array([1, 2, 3]));

      // Act
      try {
        await env.fs.readSlice(path, 0, -1);
        expect.fail('expected PERMISSION_DENIED');
      } catch (err) {
        // Assert
        assertPermissionDenied(err);
      }
    });

    it('Given readSlice(0, 0), When reading, Then returns empty array', async () => {
      // Arrange
      const path = `${env.rootDir}/slice.bin`;
      await env.fs.write(path, new Uint8Array([1, 2, 3]));

      // Act
      const result = await env.fs.readSlice(path, 0, 0);

      // Assert
      expect(result).toEqual(new Uint8Array());
    });

    it('Given mkdir on existing file path, When mkdir, Then throws FILE_EXISTS or NOT_A_DIRECTORY', async () => {
      // Arrange
      const path = `${env.rootDir}/file.txt`;
      await env.fs.write(path, new Uint8Array([1]));

      // Act
      let caught: unknown;
      try {
        await env.fs.mkdir(path);
      } catch (err) {
        caught = err;
      }

      // Assert — exact code is platform-dependent (Node may surface EEXIST or ENOTDIR
      // depending on whether the mkdir is on the file path itself or a child-of-file path);
      // both are acceptable as long as it's a structured TsgitError.
      expect(caught).toBeInstanceOf(TsgitError);
      const code = (caught as TsgitError).data.code;
      expect(['FILE_EXISTS', 'NOT_A_DIRECTORY']).toContain(code);
    });

    it('Given symlink, When lstat, Then isSymbolicLink is true', async () => {
      // Arrange
      const target = `${env.rootDir}/target.txt`;
      const link = `${env.rootDir}/link.txt`;
      await env.fs.write(target, new Uint8Array([1]));
      await env.fs.symlink(target, link);

      // Act
      const stat = await env.fs.lstat(link);

      // Assert
      expect(stat.isSymbolicLink).toBe(true);
    });

    it('Given symlink, When stat, Then follows symlink (returns target stat)', async () => {
      // Arrange
      const target = `${env.rootDir}/target.txt`;
      const link = `${env.rootDir}/link.txt`;
      await env.fs.write(target, new Uint8Array([1, 2, 3]));
      await env.fs.symlink(target, link);

      // Act
      const stat = await env.fs.stat(link);

      // Assert
      expect(stat.isFile).toBe(true);
      expect(stat.isSymbolicLink).toBe(false);
      expect(stat.size).toBe(3);
    });

    it('Given nested path, When writeUtf8, Then creates parent directories', async () => {
      // Arrange
      const path = `${env.rootDir}/x/y/z.txt`;

      // Act
      await env.fs.writeUtf8(path, 'nested');

      // Assert
      expect(await env.fs.readUtf8(path)).toBe('nested');
    });

    it('Given non-existent path, When appendUtf8, Then creates the file with the content', async () => {
      // Arrange
      const path = `${env.rootDir}/append-new.txt`;

      // Act
      await env.fs.appendUtf8(path, 'first line\n');

      // Assert
      expect(await env.fs.readUtf8(path)).toBe('first line\n');
    });

    it('Given nested path, When appendUtf8, Then creates parent directories', async () => {
      // Arrange
      const path = `${env.rootDir}/logs/refs/heads/main`;

      // Act
      await env.fs.appendUtf8(path, 'entry\n');

      // Assert
      expect(await env.fs.readUtf8(path)).toBe('entry\n');
    });

    it('Given an existing file, When appendUtf8, Then content is appended after the existing data', async () => {
      // Arrange
      const path = `${env.rootDir}/append-existing.txt`;
      await env.fs.writeUtf8(path, 'first\n');

      // Act
      await env.fs.appendUtf8(path, 'second\n');

      // Assert
      expect(await env.fs.readUtf8(path)).toBe('first\nsecond\n');
    });

    it('Given sequential appendUtf8 calls, When reading, Then all writes accumulate in order', async () => {
      // Arrange
      const path = `${env.rootDir}/append-seq.txt`;

      // Act
      await env.fs.appendUtf8(path, 'a\n');
      await env.fs.appendUtf8(path, 'b\n');
      await env.fs.appendUtf8(path, 'c\n');

      // Assert
      expect(await env.fs.readUtf8(path)).toBe('a\nb\nc\n');
    });

    it('Given non-empty directory, When rm, Then throws a TsgitError', async () => {
      // Arrange
      const dir = `${env.rootDir}/non-empty`;
      await env.fs.mkdir(dir);
      await env.fs.write(`${dir}/inside.txt`, new Uint8Array([1]));

      // Act
      let caught: unknown;
      try {
        await env.fs.rm(dir);
      } catch (err) {
        caught = err;
      }

      // Assert — exact code is platform-dependent (Node returns ENOTEMPTY which maps to
      // UNSUPPORTED_OPERATION; other adapters may surface NOT_A_DIRECTORY or similar).
      // What matters is that a structured TsgitError is thrown, not the loose fact of throwing.
      expect(caught).toBeInstanceOf(TsgitError);
    });

    it('Given symlink(target=escape, path=in-root), Then SUCCEEDS (port does not validate target)', async () => {
      // Arrange
      const link = `${env.rootDir}/escaping-link`;

      // Act
      await env.fs.symlink('../../../escape', link);

      // Assert
      const stat = await env.fs.lstat(link);
      expect(stat.isSymbolicLink).toBe(true);
    });

    it('Given empty directory, When rmRecursive, Then directory is removed', async () => {
      // Arrange
      const dir = `${env.rootDir}/rm-empty`;
      await env.fs.mkdir(dir);

      // Act
      await env.fs.rmRecursive(dir);

      // Assert
      expect(await env.fs.exists(dir)).toBe(false);
    });

    it('Given missing path, When rmRecursive, Then resolves without error (idempotent)', async () => {
      // Arrange
      const path = `${env.rootDir}/never-existed`;

      // Act + Assert — must not throw.
      await env.fs.rmRecursive(path);
      expect(await env.fs.exists(path)).toBe(false);
    });

    it('Given nested tree, When rmRecursive at root, Then everything under it is removed', async () => {
      // Arrange
      const root = `${env.rootDir}/rm-tree`;
      await env.fs.write(`${root}/a/b/c.txt`, new Uint8Array([1]));
      await env.fs.write(`${root}/a/d.txt`, new Uint8Array([2]));
      await env.fs.write(`${root}/e.txt`, new Uint8Array([3]));

      // Act
      await env.fs.rmRecursive(root);

      // Assert
      expect(await env.fs.exists(root)).toBe(false);
      expect(await env.fs.exists(`${root}/a/b/c.txt`)).toBe(false);
      expect(await env.fs.exists(`${root}/a/d.txt`)).toBe(false);
      expect(await env.fs.exists(`${root}/e.txt`)).toBe(false);
    });

    it('Given single file, When rmRecursive, Then file is removed', async () => {
      // Arrange
      const path = `${env.rootDir}/lone.txt`;
      await env.fs.write(path, new Uint8Array([7]));

      // Act
      await env.fs.rmRecursive(path);

      // Assert
      expect(await env.fs.exists(path)).toBe(false);
    });

    it('Given regular file, When openWithNoFollow(read), Then can read its bytes', async () => {
      // Arrange
      const path = `${env.rootDir}/nofollow-read.bin`;
      await env.fs.write(path, new Uint8Array([1, 2, 3, 4, 5]));

      // Act
      const handle = await env.fs.openWithNoFollow(path, 'read');
      try {
        const buffer = new Uint8Array(5);
        const bytes = await handle.read(buffer, 0, 5, 0);

        // Assert
        expect(bytes).toBe(5);
        expect(buffer).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
      } finally {
        await handle.close();
      }
    });

    it('Given opened FileHandle, When stat is called, Then returns size matching file', async () => {
      // Arrange
      const path = `${env.rootDir}/nofollow-stat.bin`;
      await env.fs.write(path, new Uint8Array([1, 2, 3]));
      const handle = await env.fs.openWithNoFollow(path, 'read');

      // Act
      try {
        const stat = await handle.stat();

        // Assert
        expect(stat.size).toBe(3);
        expect(stat.isFile).toBe(true);
      } finally {
        await handle.close();
      }
    });

    it('Given opened FileHandle in write mode, When write is called, Then file content is updated', async () => {
      // Arrange
      const path = `${env.rootDir}/nofollow-write.bin`;
      await env.fs.write(path, new Uint8Array([0, 0, 0]));
      const handle = await env.fs.openWithNoFollow(path, 'write');

      // Act
      try {
        await handle.write(new Uint8Array([9, 9, 9]));
      } finally {
        await handle.close();
      }
      const result = await env.fs.read(path);

      // Assert
      expect(result).toEqual(new Uint8Array([9, 9, 9]));
    });

    it('Given non-existent path, When openWithNoFollow(read), Then throws FILE_NOT_FOUND', async () => {
      // Arrange
      const path = `${env.rootDir}/missing-nofollow.bin`;

      // Act
      try {
        await env.fs.openWithNoFollow(path, 'read');
        expect.fail('expected FILE_NOT_FOUND');
      } catch (err) {
        // Assert
        assertFileNotFound(err);
      }
    });

    it('Given closed FileHandle, When close is called again, Then resolves (idempotent)', async () => {
      // Arrange
      const path = `${env.rootDir}/nofollow-close.bin`;
      await env.fs.write(path, new Uint8Array([1]));
      const handle = await env.fs.openWithNoFollow(path, 'read');

      // Act
      await handle.close();

      // Assert — second close must not throw.
      await handle.close();
    });

    describe('security matrix', () => {
      for (const { name, invoke } of pathCalls) {
        it(`Given ${name} with .. traversal escaping root, Then throws PERMISSION_DENIED`, async () => {
          try {
            await invoke(env, '../outside-root');
            expect.fail('expected PERMISSION_DENIED');
          } catch (err) {
            assertPermissionDenied(err);
          }
        });

        it(`Given ${name} with sibling-directory path, Then throws PERMISSION_DENIED`, async () => {
          const sibling = await env.getRootDirSibling();
          try {
            await invoke(env, sibling);
            expect.fail('expected PERMISSION_DENIED');
          } catch (err) {
            assertPermissionDenied(err);
          }
        });
      }
    });
  });
}
