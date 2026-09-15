import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsgitError } from '../../../src/domain/index.js';
import type { FileSystem } from '../../../src/ports/file-system.js';

export interface FileSystemContractEnv {
  readonly fs: FileSystem;
  readonly rootDir: string;
  readonly getRootDirSibling: () => Promise<string>;
  readonly getExistingInRoot: () => Promise<string>;
  readonly cleanup?: () => Promise<void>;
  /**
   * Optional per-adapter declaration for the in-root-symlink-escaping-read
   * row: `create` plants a symlink whose target lies outside every
   * containment root and returns the in-root path to read THROUGH (the
   * link itself, not its target). `expected` is the adapter's own
   * containment posture for a read that follows it — Node declares
   * `'allowed'` (git parity: reads follow symlinks, even escaping ones);
   * Memory declares `'refused'` (its containment is structural — every
   * lookup, including a symlink target reached mid-follow, is re-resolved
   * against its own root). Omit entirely to skip the row (e.g. an adapter
   * whose `symlink` is unsupported).
   */
  readonly symlinkReadEscape?: {
    readonly create: () => Promise<string>;
    readonly expected: 'allowed' | 'refused';
  };
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
  {
    name: 'writeStream',
    invoke: (e, p) =>
      e.fs.writeStream(
        p,
        (async function* () {
          yield new Uint8Array();
        })(),
      ),
  },
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

interface EnvCall {
  readonly name: string;
  readonly invoke: (env: FileSystemContractEnv) => Promise<unknown>;
}

/** Every surface that reaches the mutual symlink loop `refusal-loop-a` / `-b`, as a component
 *  or as a followed leaf, and `exists` on the leaf. */
const mutualLoopCalls: ReadonlyArray<EnvCall> = [
  { name: 'read', invoke: (e) => e.fs.read(`${e.rootDir}/refusal-loop-a`) },
  { name: 'stat', invoke: (e) => e.fs.stat(`${e.rootDir}/refusal-loop-a`) },
  { name: 'readdir', invoke: (e) => e.fs.readdir(`${e.rootDir}/refusal-loop-a`) },
  { name: 'read through it', invoke: (e) => e.fs.read(`${e.rootDir}/refusal-loop-a/x`) },
  { name: 'lstat through it', invoke: (e) => e.fs.lstat(`${e.rootDir}/refusal-loop-a/x`) },
  {
    name: 'write through it',
    invoke: (e) => e.fs.write(`${e.rootDir}/refusal-loop-a/x`, new Uint8Array()),
  },
  { name: 'rm through it', invoke: (e) => e.fs.rm(`${e.rootDir}/refusal-loop-a/x`) },
  { name: 'exists', invoke: (e) => e.fs.exists(`${e.rootDir}/refusal-loop-a`) },
];

/** Every read surface that refuses a directory where a file was expected. */
const directoryReadCalls: ReadonlyArray<EnvCall> = [
  { name: 'read', invoke: (e) => e.fs.read(`${e.rootDir}/refusal-dir`) },
  { name: 'readUtf8', invoke: (e) => e.fs.readUtf8(`${e.rootDir}/refusal-dir`) },
  { name: 'readSlice', invoke: (e) => e.fs.readSlice(`${e.rootDir}/refusal-dir`, 0, 1) },
];

/** Every surface that refuses a regular file occupying an intermediate path segment. */
const beneathFileCalls: ReadonlyArray<EnvCall> = [
  { name: 'read', invoke: (e) => e.fs.read(`${e.rootDir}/refusal-file.bin/x`) },
  { name: 'stat', invoke: (e) => e.fs.stat(`${e.rootDir}/refusal-file.bin/x`) },
  { name: 'lstat', invoke: (e) => e.fs.lstat(`${e.rootDir}/refusal-file.bin/x`) },
  { name: 'readlink', invoke: (e) => e.fs.readlink(`${e.rootDir}/refusal-file.bin/x`) },
  { name: 'rm', invoke: (e) => e.fs.rm(`${e.rootDir}/refusal-file.bin/x`) },
  {
    name: 'rename',
    invoke: (e) =>
      e.fs.rename(`${e.rootDir}/refusal-file.bin/x`, `${e.rootDir}/refusal-file-rename-dst`),
  },
  { name: 'rmRecursive', invoke: (e) => e.fs.rmRecursive(`${e.rootDir}/refusal-file.bin/x`) },
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

function assertDirectoryNotEmpty(err: unknown): void {
  expect(err).toBeInstanceOf(TsgitError);
  expect((err as TsgitError).data.code).toBe('DIRECTORY_NOT_EMPTY');
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

    it('Given a directory at the target path, When write, Then it refuses and the directory is intact', async () => {
      // Arrange
      const dir = `${env.rootDir}/write-leaf-dir`;
      const childData = new Uint8Array([1, 2, 3]);
      await env.fs.mkdir(dir);
      await env.fs.write(`${dir}/child.bin`, childData);

      // Act
      let caught: unknown;
      try {
        await env.fs.write(dir, new Uint8Array([9]));
        expect.fail('expected a refusal');
      } catch (err) {
        caught = err;
      }

      // Assert
      assertPermissionDenied(caught);
      const names = (await env.fs.readdir(dir)).map((entry) => entry.name);
      expect(names).toContain('child.bin');
      expect(await env.fs.read(`${dir}/child.bin`)).toEqual(childData);
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

    it('Given single-chunk async source, When writeStream then read, Then bytes are byte-identical', async () => {
      // Arrange
      const path = `${env.rootDir}/stream-single.bin`;
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      async function* source() {
        yield data;
      }

      // Act
      await env.fs.writeStream(path, source());
      const result = await env.fs.read(path);

      // Assert
      expect(result).toEqual(data);
    });

    it('Given multi-chunk async source, When writeStream then read, Then bytes equal in-order concatenation', async () => {
      // Arrange
      const path = `${env.rootDir}/stream-multi.bin`;
      const chunk1 = new Uint8Array([10, 20, 30]);
      const chunk2 = new Uint8Array([40, 50]);
      const chunk3 = new Uint8Array([60]);
      async function* source() {
        yield chunk1;
        yield chunk2;
        yield chunk3;
      }

      // Act
      await env.fs.writeStream(path, source());
      const result = await env.fs.read(path);

      // Assert
      expect(result).toEqual(new Uint8Array([10, 20, 30, 40, 50, 60]));
    });

    it('Given nested path whose parent does not exist, When writeStream, Then creates parent dirs and file exists', async () => {
      // Arrange
      const path = `${env.rootDir}/deep/nested/stream.bin`;
      const data = new Uint8Array([42]);
      async function* source() {
        yield data;
      }

      // Act
      await env.fs.writeStream(path, source());

      // Assert
      expect(await env.fs.exists(path)).toBe(true);
      expect(await env.fs.read(path)).toEqual(data);
    });

    it('Given existing file, When writeStream, Then overwrites with new bytes', async () => {
      // Arrange
      const path = `${env.rootDir}/stream-overwrite.bin`;
      await env.fs.write(path, new Uint8Array([1, 2, 3]));
      const newData = new Uint8Array([9, 9]);
      async function* source() {
        yield newData;
      }

      // Act
      await env.fs.writeStream(path, source());
      const result = await env.fs.read(path);

      // Assert
      expect(result).toEqual(newData);
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

    it('Given a directory at the destination, When rename, Then it refuses and neither side moves', async () => {
      // Arrange
      const src = `${env.rootDir}/rename-kind-src.bin`;
      const dst = `${env.rootDir}/rename-kind-dst-dir`;
      const data = new Uint8Array([1, 2, 3]);
      await env.fs.write(src, data);
      await env.fs.mkdir(dst);

      // Act
      let caught: unknown;
      try {
        await env.fs.rename(src, dst);
        expect.fail('expected a refusal');
      } catch (err) {
        caught = err;
      }

      // Assert
      assertPermissionDenied(caught);
      expect(await env.fs.read(src)).toEqual(data);
      expect(await env.fs.readdir(dst)).toEqual([]);
    });

    it('Given a directory source and a file destination, When rename, Then it refuses and neither side moves', async () => {
      // Arrange
      const src = `${env.rootDir}/rename-kind-src-dir`;
      const dst = `${env.rootDir}/rename-kind-dst.bin`;
      const childData = new Uint8Array([4]);
      await env.fs.write(`${src}/child.bin`, childData);
      const dstData = new Uint8Array([9, 9]);
      await env.fs.write(dst, dstData);

      // Act
      let caught: unknown;
      try {
        await env.fs.rename(src, dst);
        expect.fail('expected a refusal');
      } catch (err) {
        caught = err;
      }

      // Assert
      assertNotADirectory(caught);
      expect(await env.fs.read(dst)).toEqual(dstData);
      expect(await env.fs.read(`${src}/child.bin`)).toEqual(childData);
    });

    it('Given a directory source and a non-empty directory destination, When rename, Then it refuses and neither tree merges', async () => {
      // Arrange
      const src = `${env.rootDir}/rename-kind-src-dir2`;
      const dst = `${env.rootDir}/rename-kind-dst-dir2`;
      await env.fs.write(`${src}/a.bin`, new Uint8Array([1]));
      await env.fs.write(`${dst}/b.bin`, new Uint8Array([2]));

      // Act
      let caught: unknown;
      try {
        await env.fs.rename(src, dst);
        expect.fail('expected a refusal');
      } catch (err) {
        caught = err;
      }

      // Assert
      assertDirectoryNotEmpty(caught);
      const srcEntries = await env.fs.readdir(src);
      const dstEntries = await env.fs.readdir(dst);
      expect(srcEntries.map((entry) => entry.name)).toEqual(['a.bin']);
      expect(dstEntries.map((entry) => entry.name)).toEqual(['b.bin']);
    });

    it('Given a directory source and an empty directory destination, When rename, Then the subtree lands at the destination', async () => {
      // Arrange
      const src = `${env.rootDir}/rename-kind-src-dir3`;
      const dst = `${env.rootDir}/rename-kind-dst-dir3`;
      const data = new Uint8Array([5, 6]);
      await env.fs.write(`${src}/child.bin`, data);
      await env.fs.mkdir(dst);

      // Act
      await env.fs.rename(src, dst);

      // Assert
      expect(await env.fs.read(`${dst}/child.bin`)).toEqual(data);
      expect(await env.fs.exists(src)).toBe(false);
    });

    it('Given src === dst for a file, When rename, Then it resolves and the entry is unchanged', async () => {
      // Arrange
      const path = `${env.rootDir}/rename-kind-same.bin`;
      const data = new Uint8Array([7, 8]);
      await env.fs.write(path, data);

      // Act
      await env.fs.rename(path, path);

      // Assert
      expect(await env.fs.read(path)).toEqual(data);
    });

    it('Given src === dst for a non-empty directory, When rename, Then it resolves and every child is still reachable', async () => {
      // Arrange
      const dir = `${env.rootDir}/rename-kind-same-dir`;
      const data = new Uint8Array([9]);
      await env.fs.write(`${dir}/child.bin`, data);

      // Act
      await env.fs.rename(dir, dir);

      // Assert
      expect(await env.fs.read(`${dir}/child.bin`)).toEqual(data);
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

    it('Given an existing directory, When writeExclusive, Then throws FILE_EXISTS', async () => {
      // Arrange
      const path = `${env.rootDir}/existing-dir`;
      await env.fs.mkdir(path);

      // Act
      try {
        await env.fs.writeExclusive(path, new Uint8Array([1]));
        expect.fail('expected FILE_EXISTS');
      } catch (err) {
        // Assert
        assertFileExists(err);
      }
    });

    // Depth-1 (a file at the immediate parent) is deliberately not a row here:
    // it is adapter-dependent — Node reports FILE_EXISTS, memory reports
    // NOT_A_DIRECTORY carrying the ancestor. Depth >= 2 agrees on the code
    // across both drivers.
    it('Given a file at a grandparent path segment, When writeExclusive, Then throws NOT_A_DIRECTORY and records no intermediate directory', async () => {
      // Arrange
      const grandparent = `${env.rootDir}/grandparent.bin`;
      await env.fs.write(grandparent, new Uint8Array([1]));
      const path = `${grandparent}/mid/leaf.bin`;

      // Act
      let caught: unknown;
      try {
        await env.fs.writeExclusive(path, new Uint8Array([2]));
        expect.fail('expected a refusal');
      } catch (err) {
        caught = err;
      }

      // Assert — refused, and neither driver recorded the intermediate directory on the
      // way (Node's mkdir -p stops at the file; memory validates the whole chain before
      // adding), so probing it fails on both: NOT_A_DIRECTORY on Node, FILE_NOT_FOUND on memory.
      assertNotADirectory(caught);
      let probe: unknown;
      try {
        await env.fs.lstat(`${grandparent}/mid`);
      } catch (err) {
        probe = err;
      }
      expect(probe).toBeInstanceOf(TsgitError);
      expect(['NOT_A_DIRECTORY', 'FILE_NOT_FOUND']).toContain((probe as TsgitError).data.code);
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

    it('Given a relative symlink to a file in the same directory, When reading through it, Then every read surface returns the target bytes', async () => {
      // Arrange
      const target = `${env.rootDir}/sub/target.txt`;
      const link = `${env.rootDir}/sub/link.txt`;
      const data = new Uint8Array([10, 20, 30, 40]);
      await env.fs.write(target, data);
      await env.fs.symlink('target.txt', link);

      // Act
      const bytes = await env.fs.read(link);
      const text = await env.fs.readUtf8(link);
      const slice = await env.fs.readSlice(link, 1, 2);
      const stat = await env.fs.stat(link);
      const exists = await env.fs.exists(link);
      const lstat = await env.fs.lstat(link);

      // Assert
      expect(bytes).toEqual(data);
      expect(text).toBe(new TextDecoder().decode(data));
      expect(slice).toEqual(new Uint8Array([20, 30]));
      expect(stat.size).toBe(data.length);
      expect(exists).toBe(true);
      expect(lstat.isSymbolicLink).toBe(true);
    });

    it("Given a relative symlink pointing one directory up, When reading through it, Then it resolves against the link's own directory", async () => {
      // Arrange
      const top = `${env.rootDir}/top.txt`;
      const up = `${env.rootDir}/sub/up.txt`;
      const data = new Uint8Array([1, 2, 3]);
      await env.fs.write(top, data);
      await env.fs.symlink('../top.txt', up);

      // Act
      const result = await env.fs.read(up);

      // Assert
      expect(result).toEqual(data);
    });

    it('Given a two-hop chain of relative symlinks, When reading through it, Then it reaches the final target', async () => {
      // Arrange
      const target = `${env.rootDir}/sub/final.txt`;
      const firstHop = `${env.rootDir}/sub/first-hop`;
      const secondHop = `${env.rootDir}/sub/second-hop`;
      const data = new Uint8Array([9, 9]);
      await env.fs.write(target, data);
      await env.fs.symlink('final.txt', firstHop);
      await env.fs.symlink('first-hop', secondHop);

      // Act
      const result = await env.fs.read(secondHop);

      // Assert
      expect(result).toEqual(data);
    });

    it('Given a dangling relative symlink, When checking existence or reading, Then it reports absent', async () => {
      // Arrange
      const link = `${env.rootDir}/sub/dangling.txt`;
      await env.fs.symlink('missing.txt', link);

      // Act
      const exists = await env.fs.exists(link);
      let caught: unknown;
      try {
        await env.fs.read(link);
        expect.fail('expected FILE_NOT_FOUND');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(exists).toBe(false);
      assertFileNotFound(caught);
    });

    it('Given a relative symlink to a directory, When listing it or reading its stat, Then it behaves as the target directory', async () => {
      // Arrange
      const dir = `${env.rootDir}/sub/dir`;
      const link = `${env.rootDir}/sub/dir-link`;
      await env.fs.mkdir(dir);
      await env.fs.write(`${dir}/inner.txt`, new Uint8Array([1]));
      await env.fs.symlink('dir', link);

      // Act
      const entries = await env.fs.readdir(link);
      const stat = await env.fs.stat(link);

      // Assert
      expect(entries.map((entry) => entry.name)).toEqual(['inner.txt']);
      expect(stat.isDirectory).toBe(true);
    });

    it('Given a symlinked intermediate directory, When reading through a path beneath it, Then every read surface reaches the real file', async () => {
      // Arrange
      const real = `${env.rootDir}/real`;
      const linkDir = `${env.rootDir}/sub/link-dir`;
      const data = new Uint8Array([5, 6, 7]);
      await env.fs.write(`${real}/f.txt`, data);
      await env.fs.symlink('../real', linkDir);
      const through = `${linkDir}/f.txt`;

      // Act
      const bytes = await env.fs.read(through);
      const text = await env.fs.readUtf8(through);
      const slice = await env.fs.readSlice(through, 0, 2);
      const stat = await env.fs.stat(through);
      const exists = await env.fs.exists(through);
      const lstat = await env.fs.lstat(through);
      const entries = await env.fs.readdir(linkDir);
      const handle = await env.fs.openWithNoFollow(through, 'read');

      // Assert
      try {
        expect(bytes).toEqual(data);
        expect(text).toBe(new TextDecoder().decode(data));
        expect(slice).toEqual(new Uint8Array([5, 6]));
        expect(stat.size).toBe(data.length);
        expect(exists).toBe(true);
        expect(lstat.isFile).toBe(true);
        expect(entries.map((entry) => entry.name)).toEqual(['f.txt']);
      } finally {
        await handle.close();
      }
    });

    it('Given a symlinked intermediate directory, When writing through a path beneath it, Then the bytes land at the real path', async () => {
      // Arrange
      const real = `${env.rootDir}/write-real`;
      const linkDir = `${env.rootDir}/sub/write-link-dir`;
      await env.fs.mkdir(real);
      await env.fs.symlink('../write-real', linkDir);
      const writeData = new Uint8Array([1]);
      const exclusiveData = new Uint8Array([2]);
      const streamData = new Uint8Array([3]);
      async function* source() {
        yield streamData;
      }

      // Act
      await env.fs.write(`${linkDir}/w.bin`, writeData);
      await env.fs.writeExclusive(`${linkDir}/we.bin`, exclusiveData);
      await env.fs.writeUtf8(`${linkDir}/wu.txt`, 'utf8');
      await env.fs.appendUtf8(`${linkDir}/au.txt`, 'appended');
      await env.fs.writeStream(`${linkDir}/ws.bin`, source());

      // Assert
      expect(await env.fs.read(`${real}/w.bin`)).toEqual(writeData);
      expect(await env.fs.read(`${real}/we.bin`)).toEqual(exclusiveData);
      expect(await env.fs.readUtf8(`${real}/wu.txt`)).toBe('utf8');
      expect(await env.fs.readUtf8(`${real}/au.txt`)).toBe('appended');
      expect(await env.fs.read(`${real}/ws.bin`)).toEqual(streamData);
    });

    it('Given a symlinked intermediate directory, When creating a nested symlink or directory beneath it, Then they land under the real path, missing parents included', async () => {
      // Arrange
      const real = `${env.rootDir}/create-real`;
      const linkDir = `${env.rootDir}/sub/create-link-dir`;
      await env.fs.mkdir(real);
      await env.fs.write(`${real}/target.txt`, new Uint8Array([1]));
      await env.fs.symlink('../create-real', linkDir);

      // Act
      await env.fs.symlink('target.txt', `${linkDir}/shortcut`);
      await env.fs.mkdir(`${linkDir}/deep/new`);

      // Assert
      expect(await env.fs.readlink(`${real}/shortcut`)).toBe('target.txt');
      expect((await env.fs.stat(`${real}/deep/new`)).isDirectory).toBe(true);
    });

    it('Given a symlinked intermediate directory, When renaming an entry within it, Then the entry moves under the real path', async () => {
      // Arrange
      const real = `${env.rootDir}/rename-real`;
      const linkDir = `${env.rootDir}/sub/rename-link-dir`;
      const data = new Uint8Array([8]);
      await env.fs.write(`${real}/a.bin`, data);
      await env.fs.symlink('../rename-real', linkDir);

      // Act
      await env.fs.rename(`${linkDir}/a.bin`, `${linkDir}/b.bin`);

      // Assert
      expect(await env.fs.exists(`${real}/a.bin`)).toBe(false);
      expect(await env.fs.read(`${real}/b.bin`)).toEqual(data);
    });

    it('Given a symlinked intermediate directory, When atomicRename moves an entry within it, Then the entry moves under the real path', async () => {
      // Arrange
      const real = `${env.rootDir}/atomic-real`;
      const linkDir = `${env.rootDir}/sub/atomic-link-dir`;
      const data = new Uint8Array([9]);
      await env.fs.write(`${real}/a.bin`, data);
      await env.fs.symlink('../atomic-real', linkDir);

      // Act
      await env.fs.atomicRename?.(`${linkDir}/a.bin`, `${linkDir}/b.bin`);

      // Assert
      expect(await env.fs.exists(`${real}/a.bin`)).toBe(false);
      expect(await env.fs.read(`${real}/b.bin`)).toEqual(data);
    });

    it('Given a symlinked intermediate directory, When removing an entry beneath it, Then the real entry is removed', async () => {
      // Arrange
      const real = `${env.rootDir}/rm-real`;
      const linkDir = `${env.rootDir}/sub/rm-link-dir`;
      await env.fs.write(`${real}/gone.bin`, new Uint8Array([1]));
      await env.fs.symlink('../rm-real', linkDir);

      // Act
      await env.fs.rm(`${linkDir}/gone.bin`);

      // Assert
      expect(await env.fs.exists(`${real}/gone.bin`)).toBe(false);
    });

    it('Given a symlinked intermediate directory holding a nested tree, When rmRecursive removes a path beneath it, Then the real subtree is removed', async () => {
      // Arrange
      const real = `${env.rootDir}/rm-recursive-real`;
      const linkDir = `${env.rootDir}/sub/rm-recursive-link-dir`;
      await env.fs.write(`${real}/deep/inner.bin`, new Uint8Array([1]));
      await env.fs.symlink('../rm-recursive-real', linkDir);

      // Act
      await env.fs.rmRecursive(`${linkDir}/deep`);

      // Assert
      expect(await env.fs.exists(`${real}/deep`)).toBe(false);
      expect(await env.fs.exists(real)).toBe(true);
    });

    it('Given a symlinked intermediate directory, When opening a path beneath it with openWithNoFollow in write mode, Then the real file is updated', async () => {
      // Arrange
      const real = `${env.rootDir}/open-write-real`;
      const linkDir = `${env.rootDir}/sub/open-write-link-dir`;
      await env.fs.write(`${real}/f.bin`, new Uint8Array([0, 0]));
      await env.fs.symlink('../open-write-real', linkDir);

      // Act
      const handle = await env.fs.openWithNoFollow(`${linkDir}/f.bin`, 'write');
      try {
        await handle.write(new Uint8Array([7, 7]));
      } finally {
        await handle.close();
      }

      // Assert
      expect(await env.fs.read(`${real}/f.bin`)).toEqual(new Uint8Array([7, 7]));
    });

    it('Given a two-hop chain of symlinked intermediate directories, When reading through it, Then it reaches the real file', async () => {
      // Arrange
      const real = `${env.rootDir}/chain-real`;
      const linkDir = `${env.rootDir}/sub/chain-link-dir`;
      const chainLink = `${env.rootDir}/sub/chain-link2`;
      const data = new Uint8Array([3, 1, 4]);
      await env.fs.write(`${real}/f.txt`, data);
      await env.fs.symlink('../chain-real', linkDir);
      await env.fs.symlink('chain-link-dir', chainLink);

      // Act
      const result = await env.fs.read(`${chainLink}/f.txt`);

      // Assert
      expect(result).toEqual(data);
    });

    it('Given a symlink to a directory occupies the write target, When write is called, Then it still refuses PERMISSION_DENIED', async () => {
      // Arrange
      const real = `${env.rootDir}/leaf-real`;
      const linkDir = `${env.rootDir}/sub/leaf-link-dir`;
      await env.fs.mkdir(real);
      await env.fs.symlink('../leaf-real', linkDir);

      // Act
      let caught: unknown;
      try {
        await env.fs.write(linkDir, new Uint8Array([1]));
        expect.fail('expected a refusal');
      } catch (err) {
        caught = err;
      }

      // Assert
      assertPermissionDenied(caught);
    });

    it('Given a symlink to a directory, When rmRecursive removes it, Then the link is removed and the real directory is kept', async () => {
      // Arrange
      const real = `${env.rootDir}/leaf-rm-real`;
      const link = `${env.rootDir}/sub/leaf-rm-link`;
      await env.fs.mkdir(real);
      await env.fs.symlink('../leaf-rm-real', link);

      // Act
      await env.fs.rmRecursive(link);

      // Assert
      expect(await env.fs.exists(link)).toBe(false);
      expect(await env.fs.exists(real)).toBe(true);
    });

    it('Given a symlink to an existing directory occupies the mkdir target, When mkdir is called, Then it resolves without creating anything and the link is kept', async () => {
      // Arrange
      const real = `${env.rootDir}/mkdir-real`;
      const link = `${env.rootDir}/sub/mkdir-link`;
      await env.fs.mkdir(real);
      await env.fs.symlink('../mkdir-real', link);

      // Act
      await env.fs.mkdir(link);

      // Assert
      expect((await env.fs.lstat(link)).isSymbolicLink).toBe(true);
      expect(await env.fs.readdir(real)).toEqual([]);
    });

    it('Given a dangling symlink occupies the mkdir target, When mkdir is called, Then it refuses FILE_NOT_FOUND and creates nothing', async () => {
      // Arrange
      const link = `${env.rootDir}/sub/mkdir-dangling`;
      await env.fs.symlink('missing-dir', link);

      // Act
      let caught: unknown;
      try {
        await env.fs.mkdir(link);
        expect.fail('expected FILE_NOT_FOUND');
      } catch (err) {
        caught = err;
      }

      // Assert
      assertFileNotFound(caught);
      expect(await env.fs.exists(`${env.rootDir}/sub/missing-dir`)).toBe(false);
    });

    it('Given a mutual symlink loop occupies the mkdir target, When mkdir is called, Then it refuses PERMISSION_DENIED', async () => {
      // Arrange
      const linkA = `${env.rootDir}/sub/mkdir-loop-a`;
      const linkB = `${env.rootDir}/sub/mkdir-loop-b`;
      await env.fs.symlink('mkdir-loop-b', linkA);
      await env.fs.symlink('mkdir-loop-a', linkB);

      // Act
      let caught: unknown;
      try {
        await env.fs.mkdir(linkA);
        expect.fail('expected PERMISSION_DENIED');
      } catch (err) {
        caught = err;
      }

      // Assert
      assertPermissionDenied(caught);
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

    it('Given empty directory, When rm, Then the directory is removed', async () => {
      // Arrange
      const dir = `${env.rootDir}/rm-empty-dir`;
      await env.fs.mkdir(dir);

      // Act
      await env.fs.rm(dir);

      // Assert
      expect(await env.fs.exists(dir)).toBe(false);
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

      // Assert — exact code is platform-dependent (Node returns ENOTEMPTY, mapped to
      // DIRECTORY_NOT_EMPTY; other adapters may surface NOT_A_DIRECTORY or similar).
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

    describe('symlink and directory refusal parity', () => {
      describe('Given a mutual symlink loop', () => {
        for (const { name, invoke } of mutualLoopCalls) {
          it(`Then ${name} refuses PERMISSION_DENIED`, async () => {
            // Arrange
            const linkA = `${env.rootDir}/refusal-loop-a`;
            const linkB = `${env.rootDir}/refusal-loop-b`;
            await env.fs.symlink('refusal-loop-b', linkA);
            await env.fs.symlink('refusal-loop-a', linkB);

            // Act
            let caught: unknown;
            try {
              await invoke(env);
              expect.fail('expected PERMISSION_DENIED');
            } catch (err) {
              caught = err;
            }

            // Assert
            assertPermissionDenied(caught);
          });
        }
      });

      describe('Given a directory', () => {
        for (const { name, invoke } of directoryReadCalls) {
          it(`Then ${name} refuses PERMISSION_DENIED`, async () => {
            // Arrange
            await env.fs.mkdir(`${env.rootDir}/refusal-dir`);

            // Act
            let caught: unknown;
            try {
              await invoke(env);
              expect.fail('expected PERMISSION_DENIED');
            } catch (err) {
              caught = err;
            }

            // Assert
            assertPermissionDenied(caught);
          });
        }
      });

      describe('Given a missing path', () => {
        it('Then readdir refuses FILE_NOT_FOUND', async () => {
          // Act
          let caught: unknown;
          try {
            await env.fs.readdir(`${env.rootDir}/refusal-never-existed`);
            expect.fail('expected FILE_NOT_FOUND');
          } catch (err) {
            caught = err;
          }

          // Assert
          assertFileNotFound(caught);
        });
      });

      describe('Given a dangling symlink', () => {
        it('Then readdir refuses FILE_NOT_FOUND', async () => {
          // Arrange
          await env.fs.symlink('refusal-nope', `${env.rootDir}/refusal-readdir-dangling`);

          // Act
          let caught: unknown;
          try {
            await env.fs.readdir(`${env.rootDir}/refusal-readdir-dangling`);
            expect.fail('expected FILE_NOT_FOUND');
          } catch (err) {
            caught = err;
          }

          // Assert
          assertFileNotFound(caught);
        });
      });

      describe('Given a regular file occupying an intermediate path segment', () => {
        for (const { name, invoke } of beneathFileCalls) {
          it(`Then ${name} refuses NOT_A_DIRECTORY`, async () => {
            // Arrange
            await env.fs.write(`${env.rootDir}/refusal-file.bin`, new Uint8Array([1]));

            // Act
            let caught: unknown;
            try {
              await invoke(env);
              expect.fail('expected NOT_A_DIRECTORY');
            } catch (err) {
              caught = err;
            }

            // Assert
            assertNotADirectory(caught);
          });
        }

        it('Then exists rejects NOT_A_DIRECTORY', async () => {
          // Arrange
          await env.fs.write(`${env.rootDir}/refusal-file.bin`, new Uint8Array([1]));

          // Act
          let caught: unknown;
          try {
            await env.fs.exists(`${env.rootDir}/refusal-file.bin/x`);
            expect.fail('expected NOT_A_DIRECTORY');
          } catch (err) {
            caught = err;
          }

          // Assert
          assertNotADirectory(caught);
        });
      });
    });

    describe('Given an in-root symlink whose target escapes every root', () => {
      describe('When reading through it', () => {
        it('Then it is followed when the adapter declares escape reads allowed (git parity)', async (ctx) => {
          const { symlinkReadEscape } = env;
          if (symlinkReadEscape === undefined || symlinkReadEscape.expected !== 'allowed') {
            ctx.skip();
            return;
          }

          // Arrange
          const link = await symlinkReadEscape.create();

          // Act
          const stat = await env.fs.stat(link);

          // Assert
          expect(stat.isFile).toBe(true);
        });

        it('Then it is refused when the adapter confines reads to its own addressing model', async (ctx) => {
          const { symlinkReadEscape } = env;
          if (symlinkReadEscape === undefined || symlinkReadEscape.expected !== 'refused') {
            ctx.skip();
            return;
          }

          // Arrange
          const link = await symlinkReadEscape.create();

          // Act
          let caught: unknown;
          try {
            await env.fs.stat(link);
          } catch (err) {
            caught = err;
          }

          // Assert
          assertPermissionDenied(caught);
        });
      });
    });
  });
}
