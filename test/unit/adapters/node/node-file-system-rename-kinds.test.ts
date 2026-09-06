/**
 * Dependency-injection tests for `NodeFileSystem.rename`'s Windows
 * rename-kind emulation.
 *
 * All tests here inject a fake `FsOperations` directly into the
 * `NodeFileSystem` constructor (third parameter). NO `vi.mock` — the
 * dependencies are explicit, the tests are cross-platform by construction,
 * and there's no module-system magic.
 *
 * Compare with `node-file-system.test.ts` which runs the cross-adapter
 * `FileSystemContract` suite against the REAL filesystem.
 */
import { describe, expect, it, vi } from 'vitest';
import { NodeFileSystem } from '../../../../src/adapters/node/node-file-system.js';
import { posixPolicy, windowsPolicy } from '../../../../src/adapters/node/path-policy.js';
import { dataFor } from '../../../fixtures/tsgit-error-data.js';
import { eacces, einval, enoent, enotdir, enotempty, entry, fakeFsOps } from './node-fs-fakes.js';

describe('NodeFileSystem.rename — Windows rename-kind emulation (DI)', () => {
  // `windowsPolicy.honoursRenameKinds` is false, so these rows exercise
  // `planRename`'s explicit pre-rename kind check — the arm that keeps a
  // platform whose own `rename` does not enforce POSIX's kind rules from
  // replacing a file with a directory or silently refusing an empty one.

  describe('Given posixPolicy with a directory source over a regular-file destination', () => {
    describe('When rename fires', () => {
      it('Then it delegates untouched: rename is called once, and lstat/rmdir are never called', async () => {
        // Arrange
        const rootDir = '/root';
        const src = '/root/srcdir';
        const dst = '/root/dstfile';
        const lstatSpy = vi
          .fn()
          .mockResolvedValueOnce(entry('directory', 11))
          .mockResolvedValueOnce(entry('file', 12));
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: lstatSpy,
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(renameSpy).toHaveBeenCalledTimes(1);
        expect(renameSpy).toHaveBeenCalledWith(src, dst);
        expect(lstatSpy).not.toHaveBeenCalled();
        expect(rmdirSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given posixPolicy with a directory source over a directory destination', () => {
    describe('When rename fires and the destination rmdir would resolve if called', () => {
      it('Then it delegates untouched: rmdir is never called and rename is called once', async () => {
        // Arrange
        const rootDir = '/root';
        const src = '/root/srcdir';
        const dst = '/root/newdir';
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 11))
            .mockResolvedValueOnce(entry('directory', 12)),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a directory source and a destination that are one entry under two spellings', () => {
    describe('When rename fires and both lstats report the same device and inode', () => {
      it('Then it delegates: rename is called once, and rmdir is never called', async () => {
        // Arrange — a case-only spelling difference; the same holds for a
        // trailing dot or an 8.3 short name, which the string compare cannot see.
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\A.BIN';
        const dst = 'C:\\Root\\a.bin';
        const lstatSpy = vi
          .fn()
          .mockResolvedValueOnce(entry('directory', 42))
          .mockResolvedValueOnce(entry('directory', 42));
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: lstatSpy,
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(lstatSpy).toHaveBeenCalledTimes(2);
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).toHaveBeenCalledTimes(1);
        expect(renameSpy).toHaveBeenCalledWith(src, dst);
      });
    });
  });

  describe('Given a directory source and a file destination whose spellings fold equal but are distinct entries', () => {
    describe('When rename fires on a case-sensitive directory', () => {
      it('Then it refuses NOT_A_DIRECTORY carrying src, and rename is never called', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\A';
        const dst = 'C:\\Root\\a';
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 1))
            .mockResolvedValueOnce(entry('file', 2)),
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(dataFor(caught, 'NOT_A_DIRECTORY').path).toBe(src);
        expect(renameSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a filesystem that reports no inode for two distinct directories', () => {
    describe('When rename fires', () => {
      it('Then identity falls back to the canonical paths, which differ, and the replace arm runs', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\emptydir';
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 0))
            .mockResolvedValueOnce(entry('directory', 0)),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(rmdirSpy).toHaveBeenCalledWith(dst);
        expect(renameSpy).toHaveBeenCalledWith(src, dst);
      });
    });
  });

  describe('Given a directory source whose canonical path contains the destination', () => {
    describe('When rename fires with the source leaf spelled by an alias', () => {
      it('Then it delegates: rmdir is never called and rename is called once', async () => {
        // Arrange — the destination's parent chain is canonical, the source
        // leaf is not; only the source's realpath can show the nesting.
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\LONG-N~1';
        const dst = 'C:\\Root\\long-name\\inner';
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi
            .fn()
            .mockImplementation(async (input: string) =>
              input === src ? 'C:\\Root\\long-name' : input,
            ),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 5))
            .mockResolvedValueOnce(entry('directory', 6)),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).toHaveBeenCalledTimes(1);
        expect(renameSpy).toHaveBeenCalledWith(src, dst);
      });
    });
  });

  describe('Given a destination inside the source', () => {
    describe('When rename fires and the underlying rename rejects the invalid-argument errno', () => {
      it('Then it surfaces UNSUPPORTED_OPERATION with that errno as reason, and lstat/rmdir are never called', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\srcdir\\sub';
        const lstatSpy = vi.fn();
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: lstatSpy,
          rmdir: rmdirSpy,
          rename: vi.fn().mockRejectedValue(einval()),
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = dataFor(caught, 'UNSUPPORTED_OPERATION');
        expect(data.operation).toBe('filesystem');
        expect(data.reason).toBe('EINVAL');
        expect(lstatSpy).not.toHaveBeenCalled();
        expect(rmdirSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a regular-file source', () => {
    describe('When rename fires over any destination', () => {
      it('Then it delegates after exactly one lstat, and rmdir is never called', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcfile';
        const dst = 'C:\\Root\\dst';
        const lstatSpy = vi.fn().mockResolvedValueOnce(entry('file', 101));
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: lstatSpy,
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(lstatSpy).toHaveBeenCalledTimes(1);
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a symlink source', () => {
    describe('When rename fires over a directory destination', () => {
      it('Then it delegates after exactly one lstat, and the destination is never probed', async () => {
        // Arrange — lstat never reports a link as a directory, so the kind
        // test alone lets the platform decide (a symlink is a non-directory).
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\link';
        const dst = 'C:\\Root\\newdir';
        const lstatSpy = vi.fn().mockResolvedValueOnce(entry('symlink', 3));
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: lstatSpy,
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(lstatSpy).toHaveBeenCalledTimes(1);
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given the source lstat rejects ENOENT', () => {
    describe('When rename fires', () => {
      it('Then it delegates to the platform rename', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\dst';
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockRejectedValue(enoent()),
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(renameSpy).toHaveBeenCalledTimes(1);
        expect(renameSpy).toHaveBeenCalledWith(src, dst);
      });
    });
  });

  describe('Given a directory source and a destination lstat rejecting ENOENT', () => {
    describe('When rename fires', () => {
      it('Then it delegates, and rmdir is never called', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\dst';
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 102))
            .mockRejectedValueOnce(enoent()),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a directory source and a destination lstat rejecting ENOTDIR', () => {
    describe('When rename fires', () => {
      it('Then it delegates — the ancestor-blocked case keeps today`s behaviour', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\blocked\\dst';
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 103))
            .mockRejectedValueOnce(enotdir()),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a directory source and a destination lstat rejecting a non-errno throwable', () => {
    describe('When rename fires', () => {
      it('Then the exact throwable propagates, and rmdir/rename are never called', async () => {
        // Arrange
        const original = new RangeError('weird');
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\newdir';
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 104))
            .mockRejectedValueOnce(original),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(original);
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a directory source and a destination lstat rejecting EACCES', () => {
    describe('When rename fires', () => {
      it('Then it refuses PERMISSION_DENIED carrying src, and rename is never issued', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\newdir';
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 105))
            .mockRejectedValueOnce(eacces()),
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = dataFor(caught, 'PERMISSION_DENIED');
        expect(data.path).toBe(src);
        expect(renameSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a directory source over a regular-file destination', () => {
    describe('When rename fires', () => {
      it('Then it refuses NOT_A_DIRECTORY carrying src, and rmdir/rename are never issued', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\dstfile';
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 106))
            .mockResolvedValueOnce(entry('file', 107)),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = dataFor(caught, 'NOT_A_DIRECTORY');
        expect(data.path).toBe(src);
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a directory source over a symlink destination', () => {
    describe('When rename fires', () => {
      it('Then it refuses NOT_A_DIRECTORY carrying src, and rmdir/rename are never issued', async () => {
        // Arrange — a link to a directory is still a non-directory to lstat.
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\link';
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 8))
            .mockResolvedValueOnce(entry('symlink', 9)),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = dataFor(caught, 'NOT_A_DIRECTORY');
        expect(data.path).toBe(src);
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a directory source over a non-empty directory destination', () => {
    describe('When rename fires and the destination rmdir rejects ENOTEMPTY', () => {
      it('Then it refuses DIRECTORY_NOT_EMPTY carrying src, and rename is never issued', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\newdir';
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 108))
            .mockResolvedValueOnce(entry('directory', 109)),
          rmdir: vi.fn().mockRejectedValue(enotempty()),
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = dataFor(caught, 'DIRECTORY_NOT_EMPTY');
        expect(data.path).toBe(src);
        expect(renameSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a directory source over a directory destination whose rmdir rejects EACCES', () => {
    describe('When rename fires', () => {
      it('Then it refuses PERMISSION_DENIED carrying src, and rename is never issued', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\newdir';
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 110))
            .mockResolvedValueOnce(entry('directory', 111)),
          rmdir: vi.fn().mockRejectedValue(eacces()),
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = dataFor(caught, 'PERMISSION_DENIED');
        expect(data.path).toBe(src);
        expect(renameSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a directory source over an empty directory destination', () => {
    describe('When rename fires and the destination rmdir resolves', () => {
      it('Then rmdir(dst) runs before rename(src, dst), readdir is never called, and nothing is recreated', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\newdir';
        const mkdirSpy = vi.fn().mockResolvedValue(undefined);
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const readdirSpy = vi.fn().mockRejectedValue(enoent());
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          mkdir: mkdirSpy,
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 112))
            .mockResolvedValueOnce(entry('directory', 113)),
          rmdir: rmdirSpy,
          rename: renameSpy,
          readdir: readdirSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert — `Math.min` over each single-call spy's own order list
        // avoids indexing into a `number[]` under `noUncheckedIndexedAccess`
        // (the repo's own idiom, e.g. `maintenance.test.ts`).
        expect(rmdirSpy).toHaveBeenCalledWith(dst);
        expect(renameSpy).toHaveBeenCalledWith(src, dst);
        expect(Math.min(...rmdirSpy.mock.invocationCallOrder)).toBeLessThan(
          Math.min(...renameSpy.mock.invocationCallOrder),
        );
        expect(mkdirSpy).toHaveBeenCalledTimes(1);
        expect(readdirSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a directory source over an empty directory destination whose rmdir resolves', () => {
    describe('When the underlying rename then rejects', () => {
      it('Then the error surfaces and the parent-realpath cache is still cleared', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\newdir';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 114))
            .mockResolvedValueOnce(entry('directory', 115)),
          rmdir: vi.fn().mockResolvedValue(undefined),
          rename: vi.fn().mockRejectedValue(eacces()),
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }
        await sut.rm('C:\\Root\\another');

        // Assert — one root-set canonicalisation call plus one parent-cache
        // fill from the rename itself (both endpoints share `rootDir` as
        // their parent, so the second resolveWrite is a cache hit), then a
        // third only if the follow-up `rm` was forced to re-realpath —
        // which happens only when the cache was cleared despite the
        // rejected rename.
        expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(src);
        const rootCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === rootDir,
        );
        expect(rootCalls.length).toBe(3);
      });
    });
  });

  describe('Given a directory source over a regular-file destination, called through atomicRename', () => {
    describe('When atomicRename fires', () => {
      it('Then it refuses the same NOT_A_DIRECTORY carrying src — delegation, not a second guard', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\dstfile';
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 116))
            .mockResolvedValueOnce(entry('file', 117)),
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.atomicRename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = dataFor(caught, 'NOT_A_DIRECTORY');
        expect(data.path).toBe(src);
        expect(renameSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a directory source over an empty directory destination whose rmdir resolves', () => {
    describe('When the underlying rename then rejects EACCES', () => {
      it('Then the empty destination is recreated and PERMISSION_DENIED carrying src surfaces', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\newdir';
        const mkdirSpy = vi.fn().mockResolvedValue(undefined);
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 21))
            .mockResolvedValueOnce(entry('directory', 22)),
          mkdir: mkdirSpy,
          rmdir: rmdirSpy,
          rename: vi.fn().mockRejectedValue(eacces()),
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert — the restoring mkdir names the removed destination and runs
        // after the removal; the parent `mkdir -p` before it is the other call.
        expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(src);
        expect(mkdirSpy).toHaveBeenLastCalledWith(dst);
        expect(Math.min(...rmdirSpy.mock.invocationCallOrder)).toBeLessThan(
          Math.max(...mkdirSpy.mock.invocationCallOrder),
        );
      });
    });
  });

  describe('Given a directory source over an empty directory destination whose rmdir resolves', () => {
    describe('When the rename rejects and the restoring mkdir rejects too', () => {
      it('Then the rename failure is the one reported', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\newdir';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 21))
            .mockResolvedValueOnce(entry('directory', 22)),
          mkdir: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(eacces()),
          rmdir: vi.fn().mockResolvedValue(undefined),
          rename: vi.fn().mockRejectedValue(enotdir()),
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(dataFor(caught, 'NOT_A_DIRECTORY').path).toBe(src);
      });
    });
  });

  describe('Given a directory source over a directory destination that vanishes before the removal', () => {
    describe('When rename fires and the rmdir rejects ENOENT', () => {
      it('Then the rename still runs: the destination reached the state the removal wanted', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\gone';
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 31))
            .mockResolvedValueOnce(entry('directory', 32)),
          rmdir: vi.fn().mockRejectedValue(enoent()),
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(renameSpy).toHaveBeenCalledTimes(1);
        expect(renameSpy).toHaveBeenCalledWith(src, dst);
      });
    });
  });

  describe('Given a directory renamed onto itself on a filesystem that reports no inode', () => {
    describe('When rename fires with the two spellings byte-identical', () => {
      it('Then it delegates: rmdir is never called and rename(src, src) is called once', async () => {
        // Arrange — identity is undecidable by inode here; the spelling decides.
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\self-dir';
        const lstatSpy = vi
          .fn()
          .mockResolvedValueOnce(entry('directory', 0))
          .mockResolvedValueOnce(entry('directory', 0));
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: lstatSpy,
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, src);

        // Assert — decided by the spelling alone: the entry is never probed
        expect(lstatSpy).not.toHaveBeenCalled();
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).toHaveBeenCalledTimes(1);
        expect(renameSpy).toHaveBeenCalledWith(src, src);
      });
    });
  });

  describe('Given two spellings of one directory on a filesystem that reports no inode', () => {
    describe('When rename fires and both canonical paths agree', () => {
      it('Then it delegates: rmdir is never called and rename is called once', async () => {
        // Arrange — the canonical path is the identity when the inode cannot be.
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\aliased';
        const dst = 'C:\\Root\\ALIASED.';
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi
            .fn()
            .mockImplementation(async (input: string) => (input === dst ? src : input)),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 0))
            .mockResolvedValueOnce(entry('directory', 0)),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given two distinct directories sharing an inode on different devices', () => {
    describe('When rename fires', () => {
      it('Then they are not one entry: the replace arm runs and rmdir names the destination', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\other-device';
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 7, 1))
            .mockResolvedValueOnce(entry('directory', 7, 2)),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(rmdirSpy).toHaveBeenCalledWith(dst);
        expect(renameSpy).toHaveBeenCalledWith(src, dst);
      });
    });
  });

  describe('Given a directory source over a directory destination whose rmdir rejects a non-errno throwable', () => {
    describe('When rename fires', () => {
      it('Then the exact throwable propagates and rename is never called', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\dst-dir';
        const thrown = new RangeError('not an errno');
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 61))
            .mockResolvedValueOnce(entry('directory', 62)),
          rmdir: vi.fn().mockRejectedValue(thrown),
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(thrown);
        expect(renameSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a directory source over a destination that vanishes before the removal', () => {
    describe('When the rename then rejects too', () => {
      it('Then nothing is recreated: mkdir ran only for the parent chain', async () => {
        // Arrange — the arm removed nothing, so it has nothing to restore.
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\gone';
        const mkdirSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 71))
            .mockResolvedValueOnce(entry('directory', 72)),
          mkdir: mkdirSpy,
          rmdir: vi.fn().mockRejectedValue(enoent()),
          rename: vi.fn().mockRejectedValue(eacces()),
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(src);
        expect(mkdirSpy).toHaveBeenCalledTimes(1);
        expect(mkdirSpy).not.toHaveBeenCalledWith(dst);
      });
    });
  });

  describe('Given two distinct directories whose spellings differ only in case, both reporting inodes', () => {
    describe('When rename fires on a case-sensitive directory', () => {
      it('Then the inodes decide they are two entries and the replace arm runs', async () => {
        // Arrange — the canonical paths fold equal; only the inodes tell them apart.
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\Alpha';
        const dst = 'C:\\Root\\alpha';
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 81))
            .mockResolvedValueOnce(entry('directory', 82)),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(rmdirSpy).toHaveBeenCalledWith(dst);
        expect(renameSpy).toHaveBeenCalledWith(src, dst);
      });
    });
  });

  describe('Given one directory reported with an inode on one side and none on the other', () => {
    describe('When rename fires and the canonical paths agree', () => {
      it('Then identity falls back to the canonical paths and the arm delegates', async () => {
        // Arrange — a mixed report cannot be decided by inode; the path can.
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\mixed';
        const dst = 'C:\\Root\\MIXED.';
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi
            .fn()
            .mockImplementation(async (input: string) => (input === dst ? src : input)),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 0))
            .mockResolvedValueOnce(entry('directory', 5)),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a directory source over an empty directory destination whose rmdir resolves', () => {
    describe('When the rename rejects and the restoring mkdir rejects a non-errno throwable', () => {
      it('Then that throwable surfaces in place of the rename failure', async () => {
        // Arrange — a programming error in the restoration must not be hidden.
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\srcdir';
        const dst = 'C:\\Root\\newdir';
        const thrown = new RangeError('not an errno');
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 91))
            .mockResolvedValueOnce(entry('directory', 92)),
          mkdir: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(thrown),
          rmdir: vi.fn().mockResolvedValue(undefined),
          rename: vi.fn().mockRejectedValue(eacces()),
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(thrown);
      });
    });
  });

  describe('Given two spellings on a filesystem that reports no inode, the destination vanishing before its realpath', () => {
    describe('When rename fires', () => {
      it('Then the fallback reads it as another entry, the removal finds nothing, and the rename runs', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\vanish';
        const dst = 'C:\\Root\\VANISH.';
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === dst) throw enoent();
            return input;
          }),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 0))
            .mockResolvedValueOnce(entry('directory', 0)),
          rmdir: vi.fn().mockRejectedValue(enoent()),
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(renameSpy).toHaveBeenCalledTimes(1);
        expect(renameSpy).toHaveBeenCalledWith(src, dst);
      });
    });
  });

  describe('Given two spellings on a filesystem that reports no inode, the destination realpath rejecting a non-errno throwable', () => {
    describe('When rename fires', () => {
      it('Then the exact throwable propagates and nothing is removed or renamed', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\strange';
        const dst = 'C:\\Root\\STRANGE.';
        const thrown = new RangeError('not an errno');
        const rmdirSpy = vi.fn().mockResolvedValue(undefined);
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === dst) throw thrown;
            return input;
          }),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 0))
            .mockResolvedValueOnce(entry('directory', 0)),
          rmdir: rmdirSpy,
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rename(src, dst);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(thrown);
        expect(rmdirSpy).not.toHaveBeenCalled();
        expect(renameSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given two spellings on a filesystem that reports no inode, a file replacing the destination before its realpath', () => {
    describe('When rename fires and the destination realpath rejects ENOTDIR', () => {
      it('Then the fallback reads it as another entry and the platform rename decides', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const src = 'C:\\Root\\swapped';
        const dst = 'C:\\Root\\SWAPPED.';
        const renameSpy = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === dst) throw enotdir();
            return input;
          }),
          lstat: vi
            .fn()
            .mockResolvedValueOnce(entry('directory', 0))
            .mockResolvedValueOnce(entry('directory', 0)),
          rmdir: vi.fn().mockRejectedValue(enoent()),
          rename: renameSpy,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.rename(src, dst);

        // Assert
        expect(renameSpy).toHaveBeenCalledTimes(1);
        expect(renameSpy).toHaveBeenCalledWith(src, dst);
      });
    });
  });
});
