/**
 * POSIX-only integration test for `NodeFileSystem.chmod` mode-bit semantics.
 *
 * Asserts that `chmod(0o600)` actually changes the file's mode-bit
 * representation reported by `stat`. NTFS doesn't have POSIX mode bits
 * (Windows `fs.chmod` only honours the read-only bit) so this is
 * fundamentally platform-bound — it lives in `posix-only/` rather than
 * being a `skipIf` in the unit suite.
 *
 * @proves
 *   surface: nodeFs.chmod
 *   bucket:  platform-only
 *   unique:  chmod(0o600) actually changes POSIX mode bits as reported by stat
 */
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';

import { createNodeContext } from '../../../src/adapters/node/node-adapter.js';
import { NodeFileSystem } from '../../../src/adapters/node/node-file-system.js';
import { dataFor } from '../../fixtures/tsgit-error-data.js';

describe('NodeFileSystem.chmod (POSIX mode bits)', () => {
  describe('Given chmod on a valid contained file, When called', () => {
    it('Then the file mode is updated', async () => {
      // Arrange
      const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-chmod-'));
      const rootDir = await fsPromises.realpath(tempRoot);
      const sut = new NodeFileSystem(rootDir);
      const path = nodePath.join(rootDir, 'perm.bin');
      await fsPromises.writeFile(path, Buffer.from([1]));

      try {
        // Act
        await sut.chmod(path, 0o600);

        // Assert
        const stat = await fsPromises.stat(path);
        expect(stat.mode & 0o777).toBe(0o600);
      } finally {
        await fsPromises.rm(rootDir, { recursive: true, force: true });
      }
    });
  });
});

describe('NodeFileSystem.write (creation mode under umask)', () => {
  const UMASK = 0o027;

  const inTempRoot = async (body: (rootDir: string) => Promise<void>): Promise<void> => {
    const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-write-mode-'));
    const rootDir = await fsPromises.realpath(tempRoot);
    const previousMask = process.umask(UMASK);
    try {
      await body(rootDir);
    } finally {
      process.umask(previousMask);
      await fsPromises.rm(rootDir, { recursive: true, force: true });
    }
  };

  describe('Given a new file written with the plain creation mode', () => {
    describe('When the umask is 027', () => {
      it('Then the file mode is 0666 narrowed by the umask', async () => {
        await inTempRoot(async (rootDir) => {
          // Arrange
          const sut = new NodeFileSystem(rootDir);
          const path = nodePath.join(rootDir, 'plain.bin');

          // Act
          await sut.write(path, new Uint8Array([1]), { mode: 0o666 });

          // Assert
          expect((await fsPromises.stat(path)).mode & 0o777).toBe(0o640);
        });
      });
    });
  });

  describe('Given a new file written with the executable creation mode', () => {
    describe('When the umask is 027', () => {
      it('Then the file mode is 0777 narrowed by the umask', async () => {
        await inTempRoot(async (rootDir) => {
          // Arrange
          const sut = new NodeFileSystem(rootDir);
          const path = nodePath.join(rootDir, 'exec.bin');

          // Act
          await sut.write(path, new Uint8Array([1]), { mode: 0o777 });

          // Assert
          expect((await fsPromises.stat(path)).mode & 0o777).toBe(0o750);
        });
      });
    });
  });

  describe('Given an existing file with mode 0640', () => {
    describe('When it is rewritten with the executable creation mode', () => {
      it('Then the existing mode is kept', async () => {
        await inTempRoot(async (rootDir) => {
          // Arrange
          const sut = new NodeFileSystem(rootDir);
          const path = nodePath.join(rootDir, 'kept.bin');
          await sut.write(path, new Uint8Array([1]), { mode: 0o666 });

          // Act
          await sut.write(path, new Uint8Array([2]), { mode: 0o777 });

          // Assert
          expect((await fsPromises.stat(path)).mode & 0o777).toBe(0o640);
        });
      });
    });
  });

  describe('Given a symlink leaf', () => {
    describe('When write is called with a creation mode', () => {
      it('Then it refuses with PERMISSION_DENIED and leaves the target untouched', async () => {
        await inTempRoot(async (rootDir) => {
          // Arrange
          const sut = new NodeFileSystem(rootDir);
          const target = nodePath.join(rootDir, 'target.bin');
          const link = nodePath.join(rootDir, 'link.bin');
          await fsPromises.writeFile(target, Buffer.from([9]));
          await fsPromises.symlink(target, link);

          // Act
          let caught: unknown;
          try {
            await sut.write(link, new Uint8Array([1]), { mode: 0o777 });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(link);
          expect(await fsPromises.readFile(target)).toEqual(Buffer.from([9]));
        });
      });
    });
  });
});

describe('Context file system write (creation mode under umask, public surface)', () => {
  const UMASK = 0o027;

  const modeAfterWrite = async (creationMode: number): Promise<number> => {
    const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-ctx-mode-'));
    const workDir = await fsPromises.realpath(tempRoot);
    const previousMask = process.umask(UMASK);
    try {
      const sut = createNodeContext({ workDir }).fs;
      const path = nodePath.join(workDir, 'f.bin');
      await sut.write(path, new Uint8Array([1]), { mode: creationMode });
      return (await fsPromises.stat(path)).mode & 0o777;
    } finally {
      process.umask(previousMask);
      await fsPromises.rm(workDir, { recursive: true, force: true });
    }
  };

  describe('Given umask 027', () => {
    describe('When ctx.fs.write creates a file with mode 0666', () => {
      it('Then the file mode is 0640', async () => {
        // Arrange
        const creationMode = 0o666;

        // Act
        const result = await modeAfterWrite(creationMode);

        // Assert
        expect(result).toBe(0o640);
      });
    });

    describe('When ctx.fs.write creates a file with mode 0777', () => {
      it('Then the file mode is 0750', async () => {
        // Arrange
        const creationMode = 0o777;

        // Act
        const result = await modeAfterWrite(creationMode);

        // Assert
        expect(result).toBe(0o750);
      });
    });
  });
});
