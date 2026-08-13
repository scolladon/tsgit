/**
 * POSIX-only integration tests covering real symlink behaviour through
 * `NodeFileSystem`. On Windows, `fs.symlink` requires developer-mode or
 * admin and `O_NOFOLLOW` is silently ignored — both make these
 * assertions impossible to verify on the Windows runner. The adapter's
 * Windows symlink discriminator is covered by mocked DI tests in
 * `test/unit/adapters/node/node-file-system-injected.test.ts`.
 *
 * @proves
 *   surface: nodeFs.symlinks
 *   bucket:  platform-only
 *   unique:  POSIX symlink creation and O_NOFOLLOW semantics through NodeFileSystem
 */
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeFileSystem } from '../../../src/adapters/node/node-file-system.js';
import { TsgitError } from '../../../src/domain/index.js';

const makeFs = async (): Promise<{
  fs: NodeFileSystem;
  rootDir: string;
  cleanup: () => Promise<void>;
}> => {
  const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-symlink-'));
  const rootDir = await fsPromises.realpath(tempRoot);
  const fs = new NodeFileSystem(rootDir);
  return {
    fs,
    rootDir,
    cleanup: async () => fsPromises.rm(rootDir, { recursive: true, force: true }),
  };
};

describe('NodeFileSystem — real symlink behaviour (POSIX)', () => {
  let env: Awaited<ReturnType<typeof makeFs>>;

  beforeEach(async () => {
    env = await makeFs();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  describe('Given broken in-root symlink leaf, When write', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange — broken symlink: realpath returns ENOENT for the leaf, parent
      // resolves, then lstat sees the link itself and isSymbolicLink() is true.
      const sut = env.fs;
      const brokenLink = nodePath.join(env.rootDir, 'broken-link');
      await fsPromises.symlink(nodePath.join(env.rootDir, 'missing-target'), brokenLink);

      // Act
      let caught: unknown;
      try {
        await sut.write(brokenLink, new Uint8Array([9]));
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
    });
  });

  describe('Given valid symlink, When readlink', () => {
    it('Then returns the target path', async () => {
      // Arrange
      const sut = env.fs;
      const target = nodePath.join(env.rootDir, 'target.txt');
      const link = nodePath.join(env.rootDir, 'link.txt');
      await fsPromises.writeFile(target, Buffer.from([1]));
      await fsPromises.symlink(target, link);

      // Act
      const result = await sut.readlink(link);

      // Assert
      expect(result).toBe(target);
    });
  });

  describe('Given symlink leaf, When openWithNoFollow(read)', () => {
    it('Then throws PERMISSION_DENIED (O_NOFOLLOW)', async () => {
      // Arrange — POSIX open with O_NOFOLLOW errors with ELOOP on a symlink leaf;
      // the adapter rewraps that as PERMISSION_DENIED for cross-adapter parity.
      const sut = env.fs;
      const target = nodePath.join(env.rootDir, 'target.txt');
      const link = nodePath.join(env.rootDir, 'follow-link.txt');
      await fsPromises.writeFile(target, Buffer.from([1]));
      await fsPromises.symlink(target, link);

      // Act
      let caught: unknown;
      try {
        await sut.openWithNoFollow(link, 'read');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
    });
  });

  describe('Given directory containing a symlink, When rmRecursive', () => {
    it('Then symlink is removed but its target is untouched', async () => {
      // Arrange — without lstat-based descent, fs.rm({recursive,force}) would
      // walk the link. Plant a target file outside the doomed tree and assert
      // it survives.
      const sut = env.fs;
      const doomed = nodePath.join(env.rootDir, 'doomed');
      const survivor = nodePath.join(env.rootDir, 'survivor.txt');
      await fsPromises.mkdir(doomed);
      await fsPromises.writeFile(survivor, Buffer.from([42]));
      const link = nodePath.join(doomed, 'link-to-survivor');
      await fsPromises.symlink(survivor, link);

      // Act
      await sut.rmRecursive(doomed);

      // Assert
      expect(await sut.exists(doomed)).toBe(false);
      expect(await sut.exists(survivor)).toBe(true);
      const survivorBytes = await sut.read(survivor);
      expect(survivorBytes).toEqual(new Uint8Array([42]));
    });
  });

  describe('Given an absolute target outside the working tree, When symlink creates the link', () => {
    it('Then the target is written verbatim: readlink is byte-identical and the target file is untouched', async () => {
      // Arrange — a symlink's target is opaque bytes, never validated
      // against the root set (git parity): create a link pointing at a real
      // file OUTSIDE `rootDir` entirely.
      const sut = env.fs;
      const outsideDir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-outside-'));
      const target = nodePath.join(outsideDir, 'secret.txt');
      await fsPromises.writeFile(target, 'untouched content');
      const link = nodePath.join(env.rootDir, 'to-outside');

      try {
        // Act
        await sut.symlink(target, link);

        // Assert — byte-identical readlink, and the target file's content
        // was never read or written by the create.
        expect(await fsPromises.readlink(link)).toBe(target);
        expect(await fsPromises.readFile(target, 'utf-8')).toBe('untouched content');
      } finally {
        await fsPromises.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('Given a dangling (non-existent) target, When symlink creates the link', () => {
    it('Then the link is created without error and stays broken', async () => {
      // Arrange — a target need not exist; git writes such links verbatim.
      const sut = env.fs;
      const target = nodePath.join(env.rootDir, 'never-created.txt');
      const link = nodePath.join(env.rootDir, 'dangling-link');

      // Act
      await sut.symlink(target, link);

      // Assert
      expect(await fsPromises.readlink(link)).toBe(target);
      await expect(fsPromises.stat(link)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('Given a symlink, When rename', () => {
    it('Then the link itself moves and its target is left in place', async () => {
      // Arrange — a live bug: `rename`'s src arm used to realpath its leaf
      // and relocate the TARGET, leaving the link dangling. The write guard
      // never realpaths a leaf, so `rename` now acts on the link itself,
      // matching POSIX and git semantics.
      const sut = env.fs;
      const target = nodePath.join(env.rootDir, 'real-target.txt');
      const link = nodePath.join(env.rootDir, 'the-link');
      const dst = nodePath.join(env.rootDir, 'moved-link');
      await fsPromises.writeFile(target, 'original content');
      await fsPromises.symlink(target, link);

      // Act
      await sut.rename(link, dst);

      // Assert — the destination is a symlink pointing at the SAME target,
      // the original link path is gone, and the target file is untouched.
      const dstStat = await fsPromises.lstat(dst);
      expect(dstStat.isSymbolicLink()).toBe(true);
      expect(await fsPromises.readlink(dst)).toBe(target);
      await expect(fsPromises.lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fsPromises.readFile(target, 'utf-8')).toBe('original content');
    });
  });

  describe('Given a symlink leaf, When writeStream attempts to write through it', () => {
    it('Then throws PERMISSION_DENIED (O_NOFOLLOW composed into the numeric createWriteStream flags)', async () => {
      // Arrange — `writeStream` cannot be exercised through the `FsOperations`
      // DI seam (it calls the static `node:fs` `createWriteStream` directly),
      // so its `O_NOFOLLOW` composition can only be proven against the real
      // filesystem.
      const sut = env.fs;
      const target = nodePath.join(env.rootDir, 'stream-target.txt');
      const link = nodePath.join(env.rootDir, 'stream-link');
      await fsPromises.writeFile(target, Buffer.from([1]));
      await fsPromises.symlink(target, link);

      async function* source(): AsyncGenerator<Uint8Array> {
        yield new Uint8Array([9]);
      }

      // Act
      let caught: unknown;
      try {
        await sut.writeStream(link, source());
      } catch (err) {
        caught = err;
      }

      // Assert — refused before any byte reaches the link's target.
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      expect(await fsPromises.readFile(target)).toEqual(Buffer.from([1]));
    });
  });
});
