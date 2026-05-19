import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  containsRelativeSegment,
  interpretCreationLstat,
  isErrnoException,
  isWindowsSymlinkRefusal,
  mapConcurrent,
  mapErrno,
  mapStat,
  NodeFileSystem,
  pathContains,
  realpathNearestExisting,
  runFs,
  toAbsolute,
} from '../../../../src/adapters/node/node-file-system.js';
import { posixPolicy, windowsPolicy } from '../../../../src/adapters/node/path-policy.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { fileSystemContractTests } from '../../ports/file-system.contract.js';

describe('NodeFileSystem', () => {
  fileSystemContractTests(async () => {
    const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-'));
    // macOS os.tmpdir() returns /var/... which is a symlink to /private/var/...
    // Resolve once so the stored rootDir matches realpath output on all platforms.
    const rootDir = await fsPromises.realpath(tempRoot);
    const siblingDir = `${rootDir}-evil`;
    await fsPromises.mkdir(siblingDir, { recursive: true });
    await fsPromises.writeFile(nodePath.join(siblingDir, 'file.txt'), '');
    const existingFile = nodePath.join(rootDir, 'existing.txt');
    await fsPromises.writeFile(existingFile, Buffer.from([1, 2, 3]));

    const fs = new NodeFileSystem(rootDir);

    return {
      fs,
      rootDir,
      getRootDirSibling: async () => nodePath.join(siblingDir, 'file.txt'),
      getExistingInRoot: async () => existingFile,
      cleanup: async () => {
        await fsPromises.rm(rootDir, { recursive: true, force: true });
        await fsPromises.rm(siblingDir, { recursive: true, force: true });
      },
    };
  });

  describe('node-specific behaviors', () => {
    const makeFs = async (): Promise<{
      readonly fs: NodeFileSystem;
      readonly rootDir: string;
      readonly siblingDir: string;
      readonly cleanup: () => Promise<void>;
    }> => {
      const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-node-'));
      const rootDir = await fsPromises.realpath(tempRoot);
      const siblingDir = `${rootDir}-sibling`;
      await fsPromises.mkdir(siblingDir, { recursive: true });
      const fs = new NodeFileSystem(rootDir);
      return {
        fs,
        rootDir,
        siblingDir,
        cleanup: async () => {
          await fsPromises.rm(rootDir, { recursive: true, force: true });
          await fsPromises.rm(siblingDir, { recursive: true, force: true });
        },
      };
    };

    it('Given symlink in root pointing outside root, When reading through it, Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const { fs, rootDir, siblingDir, cleanup } = await makeFs();
      const escapeTarget = nodePath.join(siblingDir, 'secret.txt');
      await fsPromises.writeFile(escapeTarget, Buffer.from('outside'));
      const link = nodePath.join(rootDir, 'escape-link');
      await fsPromises.symlink(escapeTarget, link);

      // Act
      let caught: unknown;
      try {
        await fs.read(link);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      await cleanup();
    });

    it('Given pre-existing symlink at target leaf, When write, Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const { fs, rootDir, siblingDir, cleanup } = await makeFs();
      const escapeTarget = nodePath.join(siblingDir, 'victim.txt');
      await fsPromises.writeFile(escapeTarget, Buffer.from('before'));
      const link = nodePath.join(rootDir, 'evil-link');
      await fsPromises.symlink(escapeTarget, link);

      // Act
      let caught: unknown;
      try {
        await fs.write(link, new Uint8Array([9, 9, 9]));
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      await cleanup();
    });

    it('Given in-root directory symlink pointing outside root, When lstat of child path, Then throws PERMISSION_DENIED', async () => {
      // Arrange — plant a directory symlink inside root that resolves outside root.
      // lstat mode realpaths the PARENT only; the check must catch the escaped parent.
      const { fs, rootDir, siblingDir, cleanup } = await makeFs();
      const dirLink = nodePath.join(rootDir, 'outside-dir');
      await fsPromises.symlink(siblingDir, dirLink);

      // Act
      let caught: unknown;
      try {
        await fs.lstat(nodePath.join('outside-dir', 'child.txt'));
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      await cleanup();
    });

    it('Given relative path, When reading, Then resolves against rootDir (not CWD)', async () => {
      // Arrange
      const { fs, rootDir, cleanup } = await makeFs();
      const content = new Uint8Array([5, 6, 7]);
      await fsPromises.writeFile(nodePath.join(rootDir, 'relative.bin'), content);

      // Act
      const result = await fs.read('relative.bin');

      // Assert
      expect(result).toEqual(content);
      await cleanup();
    });

    it('Given file with ns-precision stat, When stat, Then ctimeNs and mtimeNs are populated', async () => {
      // Arrange
      const { fs, rootDir, cleanup } = await makeFs();
      const path = nodePath.join(rootDir, 'ns.bin');
      await fsPromises.writeFile(path, Buffer.from([1]));

      // Act
      const stat = await fs.stat(path);

      // Assert — bigint option is required to populate ns fields; without it both would be undefined.
      expect(typeof stat.ctimeNs).toBe('bigint');
      expect(typeof stat.mtimeNs).toBe('bigint');
      expect((stat.ctimeNs as bigint) > 0n).toBe(true);
      expect((stat.mtimeNs as bigint) > 0n).toBe(true);
      await cleanup();
    });

    it('Given file with ns-precision lstat, When lstat, Then ctimeNs and mtimeNs are populated', async () => {
      // Arrange — lstat also passes { bigint: true }; kills ObjectLiteral/BooleanLiteral mutants on lstat's option.
      const { fs, rootDir, cleanup } = await makeFs();
      const path = nodePath.join(rootDir, 'ns-lstat.bin');
      await fsPromises.writeFile(path, Buffer.from([1]));

      // Act
      const stat = await fs.lstat(path);

      // Assert
      expect(typeof stat.ctimeNs).toBe('bigint');
      expect(typeof stat.mtimeNs).toBe('bigint');
      expect((stat.ctimeNs as bigint) > 0n).toBe(true);
      expect((stat.mtimeNs as bigint) > 0n).toBe(true);
      await cleanup();
    });

    it('Given deeply nested path, When mkdir, Then creates every intermediate directory (recursive:true)', async () => {
      // Arrange — without { recursive: true } the nested mkdir would fail with ENOENT on the first missing parent.
      const { fs, rootDir, cleanup } = await makeFs();
      const deep = nodePath.join(rootDir, 'a', 'b', 'c', 'd');

      // Act
      await fs.mkdir(deep);

      // Assert
      const stat = await fsPromises.stat(deep);
      expect(stat.isDirectory()).toBe(true);
      await cleanup();
    });

    it('Given in-root symlink leaf whose target exists in root, When read, Then follows the symlink (read mode must not reject symlink leaves)', async () => {
      // Arrange — distinguishes read mode from creation mode; in creation the leaf symlink is
      // rejected for security, but read mode must transparently follow it.
      const { fs, rootDir, cleanup } = await makeFs();
      const target = nodePath.join(rootDir, 'target.txt');
      const link = nodePath.join(rootDir, 'follow-link.txt');
      await fsPromises.writeFile(target, Buffer.from([7, 8, 9]));
      await fsPromises.symlink(target, link);

      // Act
      const result = await fs.read(link);

      // Assert
      expect(result).toEqual(new Uint8Array([7, 8, 9]));
      await cleanup();
    });

    it('Given broken in-root symlink, When read, Then throws FILE_NOT_FOUND (not PERMISSION_DENIED)', async () => {
      // Arrange — a broken symlink: read must surface the missing target as FILE_NOT_FOUND,
      // whereas creation-mode resolution would have flagged the leaf symlink as PERMISSION_DENIED.
      const { fs, rootDir, cleanup } = await makeFs();
      const broken = nodePath.join(rootDir, 'broken-read.txt');
      await fsPromises.symlink(nodePath.join(rootDir, 'missing-target'), broken);

      // Act
      let caught: unknown;
      try {
        await fs.read(broken);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
      await cleanup();
    });

    it('Given exactly rootDir path, When exists, Then returns true (rootDir===resolved equality branch)', async () => {
      // Arrange — proves the `resolved !== rootDir` short-circuit in exists() is live:
      // without it the equality case would fall through to !startsWith(rootDir + sep) and throw.
      const { fs, rootDir, cleanup } = await makeFs();

      // Act
      const result = await fs.exists(rootDir);

      // Assert
      expect(result).toBe(true);
      await cleanup();
    });

    it('Given exactly rootDir path, When stat, Then returns directory stat (checkContainment rootDir===resolved branch)', async () => {
      // Arrange — exercises the `abs !== rootDir` short-circuit inside checkContainment's
      // check() closure (kills ConditionalExpression → true on the `!==` clause).
      const { fs, rootDir, cleanup } = await makeFs();

      // Act
      const stat = await fs.stat(rootDir);

      // Assert
      expect(stat.isDirectory).toBe(true);
      await cleanup();
    });

    it('Given rootDir path which is a symlinked directory outside its own resolved name, When exists, Then realpath equality branch still accepts it', async () => {
      // Arrange — plant rootDir as /tmpA and a symlink /tmpA/loop -> /tmpA. Resolved=/tmpA/loop,
      // real=/tmpA, so the post-realpath `real !== rootDir` branch's short-circuit is exercised.
      const { fs, rootDir, cleanup } = await makeFs();
      const selfLink = nodePath.join(rootDir, 'self');
      await fsPromises.symlink(rootDir, selfLink);

      // Act — exists on the self-symlink resolves to rootDir
      const result = await fs.exists(selfLink);

      // Assert
      expect(result).toBe(true);
      await cleanup();
    });

    it('Given deeply nested non-existent creation path through a symlinked directory, When write, Then resolves via realpath of existing prefix (not via fallback root)', async () => {
      // Arrange — build a symlink to a real directory and write into a non-existent subfile.
      // Original realpathNearestExisting realpaths the existing prefix (resolving the symlink);
      // the MethodExpression mutant `segments.slice(0, i).join(sep) → segments` would never
      // produce a realpath-able candidate and would fall through to the root-based fallback,
      // landing the new file at `/<rootDir-link>/leaf` instead of the symlink target.
      const { fs, rootDir, cleanup } = await makeFs();
      const actualDir = nodePath.join(rootDir, 'actual');
      await fsPromises.mkdir(actualDir);
      const linkDir = nodePath.join(rootDir, 'link-to-actual');
      await fsPromises.symlink(actualDir, linkDir);
      const viaLink = nodePath.join(linkDir, 'leaf.bin');

      // Act
      await fs.write(viaLink, new Uint8Array([1, 2, 3]));

      // Assert — the file must materialize under the realpath'd target, not the symlink path.
      const realPath = nodePath.join(actualDir, 'leaf.bin');
      const stat = await fsPromises.lstat(realPath);
      expect(stat.isFile()).toBe(true);
      await cleanup();
    });

    it('Given rename escape via absolute path, When rename, Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const { fs, rootDir, siblingDir, cleanup } = await makeFs();
      await fsPromises.writeFile(nodePath.join(rootDir, 'src.bin'), Buffer.from([1]));

      // Act
      let caught: unknown;
      try {
        await fs.rename(nodePath.join(rootDir, 'src.bin'), nodePath.join(siblingDir, 'dst.bin'));
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      await cleanup();
    });

    // POSIX-only real-fs tests (chmod mode bits, real symlinks, locked
    // directories, open(dir)) live in `test/integration/posix-only/`:
    // they assert POSIX-specific OS semantics (mode bits, ELOOP/EISDIR
    // errnos, dev-mode-gated fs.symlink) that don't apply on Windows.
    // The adapter's response to those errnos is verified cross-platform
    // via DI in `node-file-system-injected.test.ts`.

    it('Given an opened FileHandle, When read is called without position, Then position defaults to null and reads from the current cursor', async () => {
      // Arrange — exercises the `position ?? null` default branch (no contract test omits position).
      const { fs, rootDir, cleanup } = await makeFs();
      const path = nodePath.join(rootDir, 'cursor.bin');
      await fsPromises.writeFile(path, Buffer.from([1, 2, 3, 4]));
      const handle = await fs.openWithNoFollow(path, 'read');

      // Act
      const buffer = new Uint8Array(4);
      let bytes = 0;
      try {
        bytes = await handle.read(buffer, 0, 4);
      } finally {
        await handle.close();
      }

      // Assert — first read at undefined position uses the file cursor (start = offset 0).
      expect(bytes).toBe(4);
      expect(buffer).toEqual(new Uint8Array([1, 2, 3, 4]));
      await cleanup();
    });

    // chmod 0o000 lockdown + open(dir)-EISDIR tests live in
    // `test/integration/posix-only/node-fs-locked-directory.test.ts`.
  });

  describe('internal helpers', () => {
    const makeErrnoError = (code: string | undefined): NodeJS.ErrnoException => {
      const err = new Error(code ?? 'no code') as NodeJS.ErrnoException;
      if (code !== undefined) err.code = code;
      return err;
    };

    describe('toAbsolute', () => {
      it('Given relative path, When resolving, Then joins with rootDir', () => {
        // Arrange & Act
        const sut = toAbsolute('relative.txt', '/root');

        // Assert
        expect(sut).toBe(nodePath.join('/root', 'relative.txt'));
      });

      it('Given absolute path, When resolving, Then returns path unchanged', () => {
        // Arrange & Act
        const sut = toAbsolute('/already/absolute.txt', '/root');

        // Assert
        expect(sut).toBe('/already/absolute.txt');
      });
    });

    describe('mapConcurrent', () => {
      it('Given an empty input, When mapped, Then fn is never called', async () => {
        const fn = vi.fn(async () => undefined);

        await mapConcurrent([], 8, fn);

        expect(fn).not.toHaveBeenCalled();
      });

      it('Given N items with limit P, When mapped, Then no more than P calls are in flight at any time', async () => {
        // Arrange — hold each fn call until released. Track max
        // concurrent in-flight.
        const items = Array.from({ length: 12 }, (_, i) => i);
        const releases: Array<() => void> = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const fn = vi.fn(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => releases.push(resolve));
          inFlight -= 1;
        });

        // Act
        const run = mapConcurrent(items, 4, fn);
        // Release in order; the bounded-concurrency cap means only 4
        // calls are blocked at any time.
        await new Promise((r) => setTimeout(r, 0));
        while (releases.length > 0) {
          const release = releases.shift();
          release?.();
          await new Promise((r) => setTimeout(r, 0));
        }
        await run;

        // Assert
        expect(fn).toHaveBeenCalledTimes(12);
        expect(maxInFlight).toBe(4);
      });

      it('Given a worker that throws, When mapped, Then the rejection propagates and pending items still resolve', async () => {
        // Arrange
        const fn = vi.fn(async (item: number) => {
          if (item === 2) throw new Error('boom');
        });

        // Act + Assert
        let caught: unknown;
        try {
          await mapConcurrent([0, 1, 2, 3], 2, fn);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe('boom');
      });
    });

    describe('containsRelativeSegment', () => {
      it('Given a clean POSIX absolute path, When probed, Then returns false', () => {
        const sut = containsRelativeSegment('/root/sub/file.bin');

        expect(sut).toBe(false);
      });

      it('Given a clean Windows absolute path, When probed, Then returns false', () => {
        const sut = containsRelativeSegment('C:\\Users\\runneradmin\\file.bin');

        expect(sut).toBe(false);
      });

      it('Given a dotfile in the path, When probed, Then returns false (the dot is part of a filename, not a segment)', () => {
        const sut = containsRelativeSegment('/root/.git/HEAD');

        expect(sut).toBe(false);
      });

      it('Given a `..` segment, When probed, Then returns true', () => {
        const sut = containsRelativeSegment('/root/sub/../escape');

        expect(sut).toBe(true);
      });

      it('Given a `.` segment, When probed, Then returns true', () => {
        const sut = containsRelativeSegment('/root/./redundant');

        expect(sut).toBe(true);
      });

      it('Given a trailing `..`, When probed, Then returns true', () => {
        const sut = containsRelativeSegment('/root/sub/..');

        expect(sut).toBe(true);
      });

      it('Given a Windows path with `..` segments, When probed, Then returns true', () => {
        const sut = containsRelativeSegment('C:\\Users\\sub\\..\\escape');

        expect(sut).toBe(true);
      });
    });

    describe('isErrnoException', () => {
      it('Given a generic Error without code, When checking, Then returns false', () => {
        // Act
        const sut = isErrnoException(new Error('plain'));

        // Assert
        expect(sut).toBe(false);
      });

      it('Given an errno-like error, When checking, Then returns true', () => {
        // Act
        const sut = isErrnoException(makeErrnoError('ENOENT'));

        // Assert
        expect(sut).toBe(true);
      });

      it('Given a non-Error value, When checking, Then returns false', () => {
        // Act
        const sut = isErrnoException('not an error');

        // Assert
        expect(sut).toBe(false);
      });
    });

    describe('mapErrno', () => {
      it('Given ENOENT, When mapping, Then returns FILE_NOT_FOUND', () => {
        // Act
        const sut = mapErrno(makeErrnoError('ENOENT'), '/missing');

        // Assert
        expect(sut.data.code).toBe('FILE_NOT_FOUND');
      });

      it('Given EEXIST, When mapping, Then returns FILE_EXISTS', () => {
        // Act
        const sut = mapErrno(makeErrnoError('EEXIST'), '/existing');

        // Assert
        expect(sut.data.code).toBe('FILE_EXISTS');
      });

      it('Given ENOTDIR, When mapping, Then returns NOT_A_DIRECTORY', () => {
        // Act
        const sut = mapErrno(makeErrnoError('ENOTDIR'), '/not-dir');

        // Assert
        expect(sut.data.code).toBe('NOT_A_DIRECTORY');
      });

      it('Given EACCES, When mapping, Then returns PERMISSION_DENIED', () => {
        // Act
        const sut = mapErrno(makeErrnoError('EACCES'), '/locked');

        // Assert
        expect(sut.data.code).toBe('PERMISSION_DENIED');
      });

      it('Given EPERM, When mapping, Then returns PERMISSION_DENIED', () => {
        // Act
        const sut = mapErrno(makeErrnoError('EPERM'), '/locked');

        // Assert
        expect(sut.data.code).toBe('PERMISSION_DENIED');
      });

      it('Given ELOOP, When mapping, Then returns PERMISSION_DENIED (symlink-refusal contract)', () => {
        // Act
        const sut = mapErrno(makeErrnoError('ELOOP'), '/looping');

        // Assert
        expect(sut.data.code).toBe('PERMISSION_DENIED');
      });

      it('Given EISDIR, When mapping, Then returns PERMISSION_DENIED (open-directory refusal, cross-platform)', () => {
        // Act
        const sut = mapErrno(makeErrnoError('EISDIR'), '/some-dir');

        // Assert
        expect(sut.data.code).toBe('PERMISSION_DENIED');
        if (sut.data.code === 'PERMISSION_DENIED') {
          expect(sut.data.path).toBe('/some-dir');
        }
      });

      it('Given an unknown errno code, When mapping, Then returns UNSUPPORTED_OPERATION with operation="filesystem" and the code as reason', () => {
        // Act
        const sut = mapErrno(makeErrnoError('EOTHER'), '/weird');

        // Assert
        expect(sut.data.code).toBe('UNSUPPORTED_OPERATION');
        if (sut.data.code === 'UNSUPPORTED_OPERATION') {
          expect(sut.data.operation).toBe('filesystem');
          expect(sut.data.reason).toBe('EOTHER');
        }
      });

      it('Given errno error with undefined code, When mapping, Then operation="filesystem" and reason falls back to "UNKNOWN"', () => {
        // Arrange
        const err = new Error('no code') as NodeJS.ErrnoException;

        // Act
        const sut = mapErrno(err, '/weird');

        // Assert
        expect(sut.data.code).toBe('UNSUPPORTED_OPERATION');
        if (sut.data.code === 'UNSUPPORTED_OPERATION') {
          expect(sut.data.operation).toBe('filesystem');
          expect(sut.data.reason).toBe('UNKNOWN');
        }
      });

      it('Given ENOTEMPTY, When mapping, Then returns DIRECTORY_NOT_EMPTY (non-empty rmdir is distinct from a wrong-shape path)', () => {
        // Act
        const sut = mapErrno(makeErrnoError('ENOTEMPTY'), '/non-empty-dir');

        // Assert
        expect(sut.data.code).toBe('DIRECTORY_NOT_EMPTY');
        if (sut.data.code === 'DIRECTORY_NOT_EMPTY') {
          expect(sut.data.path).toBe('/non-empty-dir');
        }
      });
    });

    describe('interpretCreationLstat', () => {
      it('Given ok=true with isSymlink=false, When interpreting, Then returns without throwing', () => {
        // Act — try/catch + `toBeUndefined` is mutation-tighter than
        // `not.toThrow()`: a mutant that throws a different-coded error
        // would slip past `not.toThrow()` only if it doesn't throw at all.
        let caught: unknown;
        try {
          interpretCreationLstat({ ok: true, isSymlink: false }, '/x');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeUndefined();
      });

      it('Given ok=true with isSymlink=true, When interpreting, Then throws PERMISSION_DENIED', () => {
        // Act
        let caught: unknown;
        try {
          interpretCreationLstat({ ok: true, isSymlink: true }, '/symlinked-leaf');
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });

      it('Given ok=false with ENOENT error, When interpreting, Then returns without throwing (leaf absent is expected)', () => {
        // Act
        let caught: unknown;
        try {
          interpretCreationLstat({ ok: false, err: makeErrnoError('ENOENT') }, '/to-create');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeUndefined();
      });

      it('Given ok=false with EACCES (non-ENOENT errno), When interpreting, Then throws PERMISSION_DENIED (NOT silently swallowed)', () => {
        // Act
        let caught: unknown;
        try {
          interpretCreationLstat({ ok: false, err: makeErrnoError('EACCES') }, '/guarded');
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });

      it('Given ok=false with non-errno throwable, When interpreting, Then re-bubbles the original error', () => {
        // Act
        const original = new RangeError('weird');
        let caught: unknown;
        try {
          interpretCreationLstat({ ok: false, err: original }, '/weird');
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBe(original);
      });
    });

    describe('runFs', () => {
      it('Given op throwing an errno exception, When running, Then throws mapped TsgitError', async () => {
        // Act
        let caught: unknown;
        try {
          await runFs(async () => {
            throw makeErrnoError('ENOENT');
          }, '/missing.txt');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
      });

      it('Given op throwing a non-errno error, When running, Then rethrows the original error untouched', async () => {
        // Arrange
        const original = new TypeError('not an errno');

        // Act
        let caught: unknown;
        try {
          await runFs(async () => {
            throw original;
          }, '/x');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(original);
      });

      it('Given successful op, When running, Then returns the op result', async () => {
        // Act
        const sut = await runFs(async () => 42, '/ok');

        // Assert
        expect(sut).toBe(42);
      });
    });

    describe('realpathNearestExisting', () => {
      it('Given path with a non-existent leaf, When resolving, Then returns canonical prefix + tail', async () => {
        // Arrange — create a real directory, append a non-existent file
        const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-rne-'));
        const real = await fsPromises.realpath(tempRoot);
        const nonExistent = nodePath.join(real, 'deep', 'missing.txt');

        // Act
        const sut = await realpathNearestExisting(nonExistent);

        // Assert
        expect(sut).toBe(nonExistent);

        // Cleanup
        await fsPromises.rm(tempRoot, { recursive: true, force: true });
      });

      it('Given fully non-existent path, When resolving, Then returns root joined with every non-existent segment (loop-exhausted branch)', async () => {
        // Act — a non-existent absolute path that shares no existing prefix except '/'
        const sut = await realpathNearestExisting('/totally/made/up/path/doesnotexist');

        // Assert — original joins realpath('/')='/' with every segment; a mutant that returns
        // root only (ConditionalExpression → false) would drop the tail entirely.
        const root = await fsPromises.realpath('/');
        const expected = nodePath.join(root, 'totally', 'made', 'up', 'path', 'doesnotexist');
        expect(sut).toBe(expected);
      });

      it('Given the root path itself, When resolving, Then returns the realpath of root (empty-segments branch)', async () => {
        // Act — '/' split yields no segments, exercising the `segments.length > 0 ?... : root` false branch
        const sut = await realpathNearestExisting('/');

        // Assert
        const root = await fsPromises.realpath('/');
        expect(sut).toBe(root);
      });

      it('Given path whose existing prefix is a symlinked directory, When resolving, Then prefix realpath is attached (not the original symlink path)', async () => {
        // Arrange — original code realpaths the longest existing prefix so symlinks are resolved.
        // The MethodExpression mutant `segments.slice(0, i).join(sep) → segments` builds a bogus
        // candidate string from the array and never succeeds, silently falling through to the
        // fallback which leaves the symlink component unresolved.
        const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-rne-sym-'));
        const resolvedRoot = await fsPromises.realpath(tempRoot);
        const actualDir = nodePath.join(resolvedRoot, 'actual');
        const linkDir = nodePath.join(resolvedRoot, 'link-to-actual');
        await fsPromises.mkdir(actualDir);
        await fsPromises.symlink(actualDir, linkDir);
        const nonExistentLeaf = nodePath.join(linkDir, 'missing.txt');

        // Act
        const sut = await realpathNearestExisting(nonExistentLeaf);

        // Assert — prefix realpath substitutes link-to-actual → actual
        expect(sut).toBe(nodePath.join(actualDir, 'missing.txt'));

        // Cleanup
        await fsPromises.rm(tempRoot, { recursive: true, force: true });
      });

      // The non-ENOENT-rethrow tests for realpathNearestExisting / exists /
      // resolveForCreation live in `node-file-system-injected.test.ts`:
      // they pass a per-instance `FsOperations` fake to control
      // the realpath/lstat errno surface, which makes them cross-platform
      // (POSIX hosts produce ENOTDIR for "file used as directory"; Windows
      // produces ENOENT or EINVAL — the test is about how
      // `realpathNearestExisting` rethrows arbitrary errno-bearing
      // rejections, not about which errno).
    });

    describe('mapStat', () => {
      const makeBigIntStat = (overrides: Partial<Parameters<typeof mapStat>[0]> = {}) => ({
        ctimeMs: BigInt(1_000_000),
        mtimeMs: BigInt(2_000_000),
        dev: BigInt(1),
        ino: BigInt(2),
        mode: BigInt(0o100644),
        uid: BigInt(1000),
        gid: BigInt(1000),
        size: BigInt(42),
        ctimeNs: BigInt(1_000_000_000),
        mtimeNs: BigInt(2_000_000_000),
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        ...overrides,
      });

      it('Given stat with ctimeNs and mtimeNs, When mapping, Then result includes the ns fields', () => {
        // Act
        const sut = mapStat(makeBigIntStat());

        // Assert
        expect(sut.ctimeNs).toBe(BigInt(1_000_000_000));
        expect(sut.mtimeNs).toBe(BigInt(2_000_000_000));
      });

      it('Given stat missing ctimeNs/mtimeNs, When mapping, Then result omits the ns fields', () => {
        // Arrange — build a stat-shaped object without ns fields (must omit rather than assign undefined under exactOptionalPropertyTypes)
        const base = makeBigIntStat();
        const { ctimeNs: _omitCtime, mtimeNs: _omitMtime, ...rest } = base;
        const sut = mapStat(rest);

        // Assert
        expect(sut.ctimeNs).toBeUndefined();
        expect(sut.mtimeNs).toBeUndefined();
        expect(sut.size).toBe(42);
      });
    });

    // `NodeFileSystem.exists` non-ENOENT and escape-branch tests +
    // `resolveForCreation` non-ENOENT-on-leaf-lstat tests both moved to
    // `node-file-system-injected.test.ts` where per-instance `FsOperations`
    // fakes control the errno surface — see comment above.
  });

  describe('isWindowsSymlinkRefusal', () => {
    const posix = posixPolicy;
    const windows = windowsPolicy;

    it('Given POSIX host, When isWindowsSymlinkRefusal is called with a PERMISSION_DENIED error, Then returns false (POSIX never uses the discriminator)', () => {
      // Arrange
      const sut = isWindowsSymlinkRefusal;
      const err = new TsgitError({ code: 'PERMISSION_DENIED', path: 'p' as never });

      // Act
      const result = sut(err, posix);

      // Assert
      expect(result).toBe(false);
    });

    it('Given Windows host and a PERMISSION_DENIED error, When isWindowsSymlinkRefusal is called, Then returns true', () => {
      // Arrange
      const sut = isWindowsSymlinkRefusal;
      const err = new TsgitError({ code: 'PERMISSION_DENIED', path: 'p' as never });

      // Act
      const result = sut(err, windows);

      // Assert
      expect(result).toBe(true);
    });

    it('Given Windows host and an UNSUPPORTED_OPERATION error, When isWindowsSymlinkRefusal is called, Then returns true', () => {
      // Arrange
      const sut = isWindowsSymlinkRefusal;
      const err = new TsgitError({
        code: 'UNSUPPORTED_OPERATION',
        operation: 'filesystem',
        reason: 'EISDIR',
      });

      // Act
      const result = sut(err, windows);

      // Assert
      expect(result).toBe(true);
    });

    it('Given Windows host and a non-TsgitError, When isWindowsSymlinkRefusal is called, Then returns false', () => {
      // Arrange
      const sut = isWindowsSymlinkRefusal;

      // Act
      const result = sut(new Error('raw'), windows);

      // Assert
      expect(result).toBe(false);
    });

    it('Given Windows host and a TsgitError of unrelated kind, When isWindowsSymlinkRefusal is called, Then returns false', () => {
      // Arrange
      const sut = isWindowsSymlinkRefusal;
      const err = new TsgitError({ code: 'FILE_NOT_FOUND', path: 'p' as never });

      // Act
      const result = sut(err, windows);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('pathContains', () => {
    const posix = posixPolicy;
    const windows = windowsPolicy;

    it('Given parent === child, When pathContains, Then returns true', () => {
      // Arrange
      const sut = pathContains;

      // Act
      const result = sut('/tmp/foo', '/tmp/foo', posix);

      // Assert
      expect(result).toBe(true);
    });

    it('Given child strictly inside parent (POSIX), When pathContains, Then returns true', () => {
      // Arrange
      const sut = pathContains;

      // Act
      const result = sut('/tmp/foo', '/tmp/foo/bar/baz.bin', posix);

      // Assert
      expect(result).toBe(true);
    });

    it('Given child outside parent, When pathContains, Then returns false', () => {
      // Arrange
      const sut = pathContains;

      // Act
      const result = sut('/tmp/foo', '/etc/passwd', posix);

      // Assert
      expect(result).toBe(false);
    });

    it("Given prefix-only match (parent='/tmp/foo', child='/tmp/foobar'), When pathContains is called, Then returns false (kills missing-separator mutant)", () => {
      // Arrange
      const sut = pathContains;

      // Act
      const result = sut('/tmp/foo', '/tmp/foobar', posix);

      // Assert
      expect(result).toBe(false);
    });

    it('Given Windows host and case-different prefix paths, Then returns true (case-insensitive prefix)', () => {
      // Arrange — Windows-shaped paths to match the platform separator.
      const sut = pathContains;
      const parent = 'C:\\Users\\Foo';
      const child = 'c:\\users\\foo\\bar.bin';

      // Act
      const result = sut(parent, child, windows);

      // Assert
      expect(result).toBe(true);
    });

    it('Given Windows host and child equal to parent in different case, Then returns true (identity arm)', () => {
      // Arrange
      const sut = pathContains;

      // Act
      const result = sut('C:\\Users\\Foo', 'c:\\users\\FOO', windows);

      // Assert
      expect(result).toBe(true);
    });

    it('Given POSIX host and same path with different case, Then returns false (case-sensitive)', () => {
      // Arrange
      const sut = pathContains;

      // Act
      const result = sut('/Users/Foo', '/users/foo/bar', posix);

      // Assert
      expect(result).toBe(false);
    });

    it('Given no policy argument, When parent === child on the host platform, Then returns true', () => {
      // Arrange — exercises the `policy = nativePolicy` default binding.
      const sut = pathContains;
      const path = nodePath.resolve('/some/dir');

      // Act
      const result = sut(path, path);

      // Assert
      expect(result).toBe(true);
    });
  });
});
