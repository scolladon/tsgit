/**
 * Dependency-injection tests for `NodeFileSystem`.
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
import type { FsOperations } from '../../../../src/adapters/node/fs-operations.js';
import {
  mapConcurrent,
  NodeFileSystem,
  realpathNearestExisting,
} from '../../../../src/adapters/node/node-file-system.js';
import { posixPolicy, windowsPolicy } from '../../../../src/adapters/node/path-policy.js';
import { TsgitError } from '../../../../src/domain/index.js';

const enoent = (msg = 'not found'): NodeJS.ErrnoException =>
  Object.assign(new Error(msg), { code: 'ENOENT' });

const eacces = (): NodeJS.ErrnoException => Object.assign(new Error('access'), { code: 'EACCES' });

const enotdir = (): NodeJS.ErrnoException =>
  Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });

const eloop = (): NodeJS.ErrnoException =>
  Object.assign(new Error('symlink loop'), { code: 'ELOOP' });

/**
 * Builds a fake `FsOperations` whose every method rejects with ENOENT by
 * default. Tests override only the methods they exercise — keeps each
 * test arrange-block tight and the unused surface unambiguously "not
 * called".
 */
const fakeFsOps = (overrides: Partial<FsOperations> = {}): FsOperations =>
  ({
    realpath: vi.fn().mockRejectedValue(enoent()),
    open: vi.fn().mockRejectedValue(enoent()),
    lstat: vi.fn().mockRejectedValue(enoent()),
    stat: vi.fn().mockRejectedValue(enoent()),
    readdir: vi.fn().mockRejectedValue(enoent()),
    readFile: vi.fn().mockRejectedValue(enoent()),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    rmdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    readlink: vi.fn().mockRejectedValue(enoent()),
    symlink: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as FsOperations;

describe('NodeFileSystem — resolveForCreation parent-realpath LRU (DI)', () => {
  const fileStat = {
    ctimeMs: BigInt(0),
    mtimeMs: BigInt(0),
    dev: BigInt(0),
    ino: BigInt(0),
    mode: BigInt(0o100644),
    uid: BigInt(0),
    gid: BigInt(0),
    size: BigInt(0),
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };

  describe('Given two writes into the same parent', () => {
    describe('When the second fires', () => {
      it('Then realpath(parent) is invoked exactly once', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi.fn().mockRejectedValue(enoent()),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act — two writes into /root/sub
        await sut.write('/root/sub/a.bin', new Uint8Array([1]));
        await sut.write('/root/sub/b.bin', new Uint8Array([2]));

        // Assert
        const parentCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/sub',
        );
        expect(parentCalls.length).toBe(1);
      });
    });
  });

  describe('Given a write path with `..` segments that escape rootDir', () => {
    describe('When write fires', () => {
      it('Then containment refuses with PERMISSION_DENIED', async () => {
        // Arrange — policy.resolve collapses the `..` segments; the resolved
        // form lands outside rootDir, so containment refuses.
        const rootDir = '/root';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.write('/root/sub/../../escape/leaf.bin', new Uint8Array([1]));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given an exists path with `..` segments that escape rootDir', () => {
    describe('When exists fires', () => {
      it('Then containment refuses with PERMISSION_DENIED', async () => {
        // Arrange — same shape as the write test but exercising the `exists`
        // code path's own containment check.
        const rootDir = '/root';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.exists('/root/sub/../../escape/probe.bin');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given a write whose parent realpath throws a non-ENOENT errno', () => {
    describe('When the call fires', () => {
      it('Then the error propagates and nothing is cached', async () => {
        // Arrange — fsOps.realpath rejects with EACCES on the parent (e.g.,
        // the user does not have search permission). Neither cache hit nor
        // ENOENT fallback applies; the catch in realpathForCreation must
        // re-throw and let runFs map it to PERMISSION_DENIED.
        const rootDir = '/root';
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return rootDir;
          throw eacces();
        });
        const fsOps = fakeFsOps({ realpath });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.write('/root/sealed/leaf.bin', new Uint8Array([1]));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        expect(fsOps.writeFile).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a write whose parent does not exist', () => {
    describe('When the call fires', () => {
      it('Then the slow walk-up is used and nothing is cached', async () => {
        // Arrange
        const rootDir = '/root';
        let realpathHits = 0;
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => {
          realpathHits += 1;
          if (input === rootDir) return rootDir;
          if (input === '/root/new-dir' || input === '/root/new-dir/leaf.bin') throw enoent();
          return input;
        });
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi.fn().mockRejectedValue(enoent()),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.write('/root/new-dir/leaf.bin', new Uint8Array([1]));

        // Assert — the LRU never recorded the missing parent. The second
        // write must perform the same call sequence:
        //   1× realpathForCreation try (parent → ENOENT)
        //   3× realpathNearestExisting walk (leaf → ENOENT, parent → ENOENT, root → ok)
        // Total: 4 calls. A mutant that quietly cached the ENOENT result
        // (or that reused the prior call's resolution) would surface as a
        // lower count here.
        realpathHits = 0;
        await sut.write('/root/new-dir/leaf.bin', new Uint8Array([2]));
        expect(realpathHits).toBe(4);
      });
    });
  });

  describe('Given a cached parent', () => {
    describe('When rmRecursive runs', () => {
      it('Then the cache is cleared and a follow-up write re-realpaths', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi.fn().mockResolvedValue(fileStat),
          rm: vi.fn().mockResolvedValue(undefined),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.write('/root/sub/a.bin', new Uint8Array([1]));
        const beforeRmCount = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/sub',
        ).length;
        await sut.rmRecursive('/root/sub/a.bin');
        await sut.write('/root/sub/b.bin', new Uint8Array([2]));

        // Assert — `/root/sub` realpath count after the full sequence:
        //   1 from the first write (cache miss → set)
        //   0 from rmRecursive's lstat-mode containment — the parent
        //     realpath cache is now SHARED across creation and lstat modes
        //     (DC-5), so this lookup HITS the entry the first write set
        //   1 from the second write (cache was cleared by rmRecursive → miss)
        // Total: 2. Pinning the count still kills mutants that would skip
        // invalidation (afterCount would stay at 1 — the second write would
        // also hit the still-populated cache) or invalidate too eagerly
        // (afterCount would jump to 3+).
        const afterCount = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/sub',
        ).length;
        expect(beforeRmCount).toBe(1);
        expect(afterCount).toBe(2);
      });
    });
  });
});

describe('NodeFileSystem — normalised-root cache (DI)', () => {
  describe('Given many containment-checking calls', () => {
    describe('When fired in sequence', () => {
      it('Then policy.normalizeForCompare runs at most once per constant parent', async () => {
        // Arrange — wrap the policy's normalizeForCompare in a spy. The cache
        // memoises the rootDir + canonical-root forms across all calls, so
        // across N exists() invocations the parents normalise exactly twice
        // (rootDir + canonicalRoot), regardless of N.
        const rootDir = 'C:\\Canonical\\Root';
        const normalizeSpy = vi.fn((p: string) => p.toLowerCase());
        const spyPolicy = { ...windowsPolicy, normalizeForCompare: normalizeSpy };
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
        });
        const sut = new NodeFileSystem(rootDir, spyPolicy, fsOps);

        // Act — 10 exists() calls; each one normalises only the child.
        for (let i = 0; i < 10; i++) {
          await sut.exists(`${rootDir}\\file-${i}.bin`);
        }

        // Assert — calls split into two groups:
        //   - Constant parents (rootDir + canonicalRoot) normalised exactly 2 times.
        //   - Each child path normalised by both the post-realpath check and
        //     (for the ENOENT-free happy path) once more. Tolerate ≤ 3 calls per
        //     child but pin the parent count strictly.
        const parentCalls = normalizeSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === rootDir,
        );
        expect(parentCalls.length).toBe(2);
      });
    });
  });
});

describe('NodeFileSystem — canonical-root cache (DI)', () => {
  describe('Given two sequential `exists` calls', () => {
    describe('When the second runs', () => {
      it('Then realpath(rootDir) is invoked at most once for the root', async () => {
        // Arrange
        const rootDir = 'C:\\canonical\\root';
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return rootDir;
          throw enoent();
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fakeFsOps({ realpath }));

        // Act
        await sut.exists('C:\\canonical\\root\\a');
        await sut.exists('C:\\canonical\\root\\b');

        // Assert
        const rootCalls = realpath.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === rootDir,
        );
        expect(rootCalls.length).toBe(1);
      });
    });
  });

  describe('Given concurrent `exists` calls', () => {
    describe('When they fire', () => {
      it('Then realpath(rootDir) is invoked at most once (promise dedupe)', async () => {
        // Arrange
        const rootDir = 'C:\\canonical\\concurrent';
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return rootDir;
          throw enoent();
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fakeFsOps({ realpath }));

        // Act
        await Promise.all([
          sut.exists('C:\\canonical\\concurrent\\a'),
          sut.exists('C:\\canonical\\concurrent\\b'),
          sut.exists('C:\\canonical\\concurrent\\c'),
        ]);

        // Assert
        const rootCalls = realpath.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === rootDir,
        );
        expect(rootCalls.length).toBe(1);
      });
    });
  });

  describe('Given the first realpath(rootDir) rejects', () => {
    describe('When `exists` is called again', () => {
      it('Then realpath is retried (cache reset on rejection)', async () => {
        // Arrange
        const rootDir = 'C:\\canonical\\missing';
        let callCount = 0;
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) {
            callCount += 1;
            if (callCount === 1) throw enoent();
            return rootDir;
          }
          throw enoent();
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fakeFsOps({ realpath }));

        // Act
        await sut.exists('C:\\canonical\\missing\\a').catch(() => undefined);
        await sut.exists('C:\\canonical\\missing\\b').catch(() => undefined);

        // Assert
        const rootCalls = realpath.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === rootDir,
        );
        expect(rootCalls.length).toBe(2);
      });
    });
  });
});

describe('NodeFileSystem — guarded canonical-root await, first-call resolution (DI)', () => {
  describe('Given a fresh adapter', () => {
    describe('When the first FS op is a read (checkContainment)', () => {
      it('Then it resolves the canonical root before checking containment', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          readFile: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const result = await sut.read('/root/leaf.bin');

        // Assert — the guarded `if (normalizedCanonicalRoot === undefined)`
        // still resolves the canonical root on the first call. A `→false`
        // (never-await) mutant would leave the field undefined, and the
        // non-null-asserting getter would read `undefined`, corrupting the
        // containment verdict.
        expect(result).toEqual(new Uint8Array([1, 2, 3]));
        expect(realpathSpy.mock.calls.some(([arg]: readonly unknown[]) => arg === rootDir)).toBe(
          true,
        );
      });
    });

    describe('When the first FS op is exists', () => {
      it('Then it resolves the canonical root before checking containment', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({ realpath: realpathSpy });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const result = await sut.exists('/root/leaf.bin');

        // Assert
        expect(result).toBe(true);
        expect(realpathSpy.mock.calls.some(([arg]: readonly unknown[]) => arg === rootDir)).toBe(
          true,
        );
      });
    });

    describe('When the first FS op is symlink with an absolute canonical-root-only target', () => {
      it('Then it resolves the canonical root before validating the target', async () => {
        // Arrange — the absolute-target branch is the only path in `symlink`
        // that reaches `getCanonicalRoot`. The target is contained by the
        // CANONICAL root only (realpath(rootDir) differs from the raw rootDir),
        // so it is load-bearing on the canonical disjunct: a never-await mutant
        // that leaves `normalizedCanonicalRoot` undefined makes the dual-root OR
        // refuse this legitimate target, so `symlink` never runs — killed.
        const rootDir = '/root';
        const canonicalRoot = '/canon';
        const target = '/canon/target.txt';
        const link = '/root/sub/link.txt';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return canonicalRoot;
          if (input === '/root/sub') return '/root/sub';
          if (input === target) return target;
          throw enoent();
        });
        const symlinkOp = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          symlink: symlinkOp,
          lstat: vi.fn().mockRejectedValue(enoent()),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.symlink(target, link);

        // Assert — succeeds only when the canonical root was resolved: the
        // target is outside the raw root and inside the canonical root.
        expect(symlinkOp).toHaveBeenCalledWith(target, link);
      });
    });
  });
});

describe('NodeFileSystem — checkContainment dual-root OR disjuncts (DI)', () => {
  describe('Given a path contained by the RAW root only (canonical root differs)', () => {
    describe('When read is called', () => {
      it('Then it passes (no throw)', async () => {
        // Arrange — the canonical root (realpath(rootDir)) resolves to a
        // DIFFERENT directory than the raw rootDir string. The requested
        // leaf lives under the raw root only; its own realpath stays under
        // the raw root too (no short-name flip on the leaf itself). Dropping
        // the raw-root disjunct of the containment OR would make this throw.
        const rootDir = '/root-raw';
        const canonicalRoot = '/canon';
        const leaf = '/root-raw/leaf.bin';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return canonicalRoot;
          return input;
        });
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          readFile: vi.fn().mockResolvedValue(Buffer.from([9])),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const result = await sut.read(leaf);

        // Assert
        expect(result).toEqual(new Uint8Array([9]));
      });
    });
  });

  describe('Given a path contained by the CANONICAL root only (raw root differs)', () => {
    describe('When read is called', () => {
      it('Then it passes (no throw)', async () => {
        // Arrange — mirror image: the raw rootDir string does NOT textually
        // contain the requested absolute path, but that path lives under the
        // canonical root (realpath(rootDir)). Dropping the canonical-root
        // disjunct of the containment OR would make this throw.
        const rootDir = '/root-raw';
        const canonicalRoot = '/canon';
        const leaf = '/canon/leaf.bin';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return canonicalRoot;
          return input;
        });
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          readFile: vi.fn().mockResolvedValue(Buffer.from([7])),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const result = await sut.read(leaf);

        // Assert
        expect(result).toEqual(new Uint8Array([7]));
      });
    });
  });
});

describe('NodeFileSystem — openWithNoFollow Windows symlink refusal (DI)', () => {
  describe('Given Windows host, symlink leaf', () => {
    describe('When openWithNoFollow(write) is called', () => {
      it('Then PERMISSION_DENIED is thrown without invoking the underlying open', async () => {
        // Arrange — the write-mode flag-selection arm of openWithNoFollow
        // was only exercised by the POSIX-only locked-directory integration
        // test. Cross-platform coverage via DI: the upfront symlink check
        // (caseInsensitive + isSymlinkLeaf) fires regardless of mode and
        // refuses the open before any flag selection happens.
        const root = 'C:\\canonical\\win-symlink-write';
        const link = 'C:\\canonical\\win-symlink-write\\link';
        const openOp = vi.fn().mockResolvedValue({ close: async () => undefined });
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => true }),
          open: openOp,
        });
        const sut = new NodeFileSystem(root, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.openWithNoFollow(link, 'write');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('PERMISSION_DENIED');
        expect(openOp).not.toHaveBeenCalled();
      });
    });
    describe('When open rejects with EACCES', () => {
      it('Then openWithNoFollow throws PERMISSION_DENIED', async () => {
        // Arrange
        const root = 'C:\\canonical\\win-symlink';
        const link = 'C:\\canonical\\win-symlink\\link';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => true }),
          open: vi.fn().mockRejectedValue(eacces()),
        });
        const sut = new NodeFileSystem(root, windowsPolicy, fsOps);

        // Act + Assert
        let caught: unknown;
        try {
          await sut.openWithNoFollow(link, 'read');
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given Windows host, regular file (no symlink)', () => {
    describe('When open rejects with EACCES', () => {
      it('Then PERMISSION_DENIED is still thrown (via mapErrno)', async () => {
        // Arrange — a real EACCES on a regular file should surface as
        // PERMISSION_DENIED through mapErrno's EACCES arm, NOT via the
        // symlink-refusal discriminator.
        const root = 'C:\\canonical\\win-regular';
        const file = 'C:\\canonical\\win-regular\\locked';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false }),
          open: vi.fn().mockRejectedValue(eacces()),
        });
        const sut = new NodeFileSystem(root, windowsPolicy, fsOps);

        // Act + Assert
        let caught: unknown;
        try {
          await sut.openWithNoFollow(file, 'read');
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given Windows host', () => {
    describe('When lstat itself throws (TOCTOU race)', () => {
      it('Then isSymlinkLeaf returns false and the open error surfaces unchanged', async () => {
        // Arrange — lstat rejects (file was deleted between checkContainment's
        // resolveForMode and isSymlinkLeaf). isSymlinkLeaf catches and returns
        // false; the post-open error then surfaces as PERMISSION_DENIED via
        // mapErrno's EACCES arm.
        const root = 'C:\\canonical\\win-lstat-race';
        const file = 'C:\\canonical\\win-lstat-race\\race';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockRejectedValue(enoent()),
          open: vi.fn().mockRejectedValue(eacces()),
        });
        const sut = new NodeFileSystem(root, windowsPolicy, fsOps);

        // Act + Assert
        let caught: unknown;
        try {
          await sut.openWithNoFollow(file, 'read');
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('PERMISSION_DENIED');
      });
    });
    describe('When lstat throws ENOENT (TOCTOU) and open succeeds', () => {
      it('Then openWithNoFollow returns the handle (isSymlinkLeaf ENOENT must return false, NOT true)', async () => {
        // Arrange — distinguishes the `isSymlinkLeaf` ENOENT-return mutant.
        // Mutating `return false` to `return true` would cause the upfront
        // line 435 check to throw `permissionDenied` before open runs. With
        // open succeeding, only the unmutated path returns a usable handle.
        const root = 'C:\\canonical\\win-lstat-race-open-ok';
        const file = 'C:\\canonical\\win-lstat-race-open-ok\\survivor';
        const fakeHandle = { close: vi.fn().mockResolvedValue(undefined) };
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockRejectedValue(enoent()),
          open: vi.fn().mockResolvedValue(fakeHandle),
        });
        const sut = new NodeFileSystem(root, windowsPolicy, fsOps);

        // Act
        const handle = await sut.openWithNoFollow(file, 'read');
        await handle.close();

        // Assert — open was reached and a handle was returned. A mutant that
        // flipped `return false` to `return true` in isSymlinkLeaf's ENOENT
        // arm would have thrown `permissionDenied` upfront.
        expect(fsOps.open).toHaveBeenCalledTimes(1);
        expect(fakeHandle.close).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given Windows host, regular file', () => {
    describe('When open rejects with EISDIR (mapErrno → UNSUPPORTED_OPERATION)', () => {
      it('Then the catch-block discriminator rewraps to PERMISSION_DENIED', async () => {
        // Arrange — distinguishes the `isWindowsSymlinkRefusal` rewrap path.
        // With the unmutated discriminator, an UNSUPPORTED_OPERATION
        // mapped error gets rewrapped to PERMISSION_DENIED. A mutation that
        // skips the rewrap (`if (false)`, emptied block, hard-coded
        // `isSymlinkLeaf=false`) would surface UNSUPPORTED_OPERATION instead.
        const eisdir = (): NodeJS.ErrnoException =>
          Object.assign(new Error('is a directory'), { code: 'EISDIR' });
        const root = 'C:\\canonical\\win-rewrap';
        const file = 'C:\\canonical\\win-rewrap\\target';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false }),
          open: vi.fn().mockRejectedValue(eisdir()),
        });
        const sut = new NodeFileSystem(root, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.openWithNoFollow(file, 'read');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given POSIX host, symlink leaf', () => {
    describe('When open rejects with ELOOP', () => {
      it('Then openWithNoFollow throws PERMISSION_DENIED (via mapErrno)', async () => {
        // Arrange
        const root = '/canonical/posix-symlink';
        const link = '/canonical/posix-symlink/link';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => true }),
          open: vi.fn().mockRejectedValue(eloop()),
        });
        const sut = new NodeFileSystem(root, posixPolicy, fsOps);

        // Act + Assert
        let caught: unknown;
        try {
          await sut.openWithNoFollow(link, 'read');
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });
});

describe('NodeFileSystem — non-errno fault propagation (DI)', () => {
  describe('Given `exists` and a realpath that rejects with a non-errno value', () => {
    describe('When called', () => {
      it('Then the original value rethrows unchanged', async () => {
        // Arrange — realpath rejects with a non-Error (string) so
        // isErrnoException returns false. The defensive rethrow keeps the
        // semantic that only errno faults flow through mapErrno.
        const rootDir = 'C:\\canonical\\non-errno-exists';
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return rootDir;
          throw 'not-an-error';
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fakeFsOps({ realpath }));

        // Act + Assert
        let caught: unknown;
        try {
          await sut.exists('C:\\canonical\\non-errno-exists\\a');
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBe('not-an-error');
      });
    });
  });

  describe('Given `read` and a realpath that rejects with a non-errno value', () => {
    describe('When called', () => {
      it('Then the original value rethrows unchanged', async () => {
        // Arrange — same idea but through checkContainment's catch.
        const rootDir = 'C:\\canonical\\non-errno-read';
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return rootDir;
          throw 'not-an-error';
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fakeFsOps({ realpath }));

        // Act + Assert
        let caught: unknown;
        try {
          await sut.read('C:\\canonical\\non-errno-read\\a');
        } catch (err) {
          caught = err;
        }
        expect(caught).toBe('not-an-error');
      });
    });
  });

  describe('Given `openWithNoFollow` on a Windows symlink leaf', () => {
    describe('When lstat rejects with a non-ENOENT errno (EACCES)', () => {
      it('Then the error rethrows (not silently swallowed)', async () => {
        // Arrange — lstat rejection with EACCES surfaces; only ENOENT is
        // safe to absorb (TOCTOU race), review.
        const root = 'C:\\canonical\\win-lstat-eacces';
        const file = 'C:\\canonical\\win-lstat-eacces\\leaf';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockRejectedValue(eacces()),
          open: vi.fn().mockResolvedValue({ close: async () => undefined }),
        });
        const sut = new NodeFileSystem(root, windowsPolicy, fsOps);

        // Act + Assert
        let caught: unknown;
        try {
          await sut.openWithNoFollow(file, 'read');
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBeInstanceOf(Error);
        expect((caught as NodeJS.ErrnoException).code).toBe('EACCES');
      });
    });
  });
});

describe('NodeFileSystem — 8.3 short-name parent reconciliation (DI)', () => {
  describe('Given realpath flips between short and long forms across calls', () => {
    describe('When write goes through creation containment', () => {
      it('Then it succeeds (canonical-root containment passes)', async () => {
        // Arrange — simulates the GHA Windows runner: realpath of the rootDir
        // returns the long-name form, while realpath of the leaf parent (the
        // same short string but called from the realpathNearestExisting walk)
        // returns the short form back. Containment must canonicalise both
        // sides and accept either spelling.
        const shortRoot = 'C:\\Users\\RUNNER~1\\Temp\\tsgit-AbCd';
        const longRoot = 'C:\\Users\\runneradmin\\Temp\\tsgit-AbCd';
        const childShort = 'C:\\Users\\RUNNER~1\\Temp\\tsgit-AbCd\\a.bin';
        let realpathHits = 0;

        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input !== shortRoot) throw enoent();
            realpathHits += 1;
            // First call: getCanonicalRoot → long-name canonical form.
            // Second call: realpathNearestExisting walks up from the leaf and
            // calls realpath on the parent again. Windows is documented to
            // return either form depending on the API path; simulate the
            // "didn't expand this time" outcome by returning the short form.
            return realpathHits === 1 ? longRoot : shortRoot;
          }),
          lstat: vi.fn().mockRejectedValue(enoent()),
        });
        const sut = new NodeFileSystem(shortRoot, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.write(childShort, new Uint8Array([1, 2, 3]));
        } catch (err) {
          caught = err;
        }

        // Assert — write succeeds despite the short↔long flip; both realpath
        // call sites fire exactly once (canonical-root + walk-up). Pinning
        // the count to 2 kills mutants that would skip or duplicate one of
        // the two sites.
        expect(caught).toBeUndefined();
        expect(realpathHits).toBe(2);
        expect(fsOps.writeFile).toHaveBeenCalledTimes(1);
        expect(fsOps.mkdir).toHaveBeenCalled();
      });
    });
  });

  describe('Given a read on a path that resolves outside rootDir', () => {
    describe('When the canonical roots both reject it', () => {
      it('Then PERMISSION_DENIED is thrown (containment is load-bearing)', async () => {
        // Arrange — sibling negative case to the happy-path test above. Uses
        // `read` so the pre-realpath `check(resolved)` arm of resolveForMode
        // fires (creation mode would surface FILE_NOT_FOUND first because the
        // walk-up segments don't exist in the mock — equally valid security
        // behaviour, but it would muddy what this test is pinning).
        const shortRoot = 'C:\\Users\\RUNNER~1\\Temp\\tsgit-AbCd';
        const longRoot = 'C:\\Users\\runneradmin\\Temp\\tsgit-AbCd';
        const outsidePath = 'C:\\elsewhere\\evil.bin';

        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === shortRoot) return longRoot;
            return input;
          }),
        });
        const sut = new NodeFileSystem(shortRoot, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.read(outsidePath);
        } catch (err) {
          caught = err;
        }

        // Assert — containment refuses the out-of-tree absolute path BEFORE
        // any I/O reaches `readFile`. If a mutation silently disabled
        // checkContainment, this would surface a different error (or none).
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        expect(fsOps.readFile).not.toHaveBeenCalled();
      });
    });
  });
});

describe('NodeFileSystem — Windows-mocked containment (DI)', () => {
  describe('Given canonical-root realpath returns a long-name form', () => {
    describe('When `exists` runs against a short-name child', () => {
      it('Then `exists` returns true', async () => {
        // Arrange
        const shortRoot = 'C:\\Users\\RUNNER~1\\Temp\\tsgit';
        const longRoot = 'C:\\Users\\runneradmin\\Temp\\tsgit';
        const child = 'C:\\Users\\RUNNER~1\\Temp\\tsgit\\file.bin';
        const childCanonical = 'C:\\Users\\runneradmin\\Temp\\tsgit\\file.bin';

        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === shortRoot) return longRoot;
            if (input === child) return childCanonical;
            throw enoent();
          }),
        });
        const sut = new NodeFileSystem(shortRoot, windowsPolicy, fsOps);

        // Act
        const result = await sut.exists(child);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given Windows host', () => {
    describe('When `exists` is called with a sibling outside the canonical root', () => {
      it('Then PERMISSION_DENIED is thrown', async () => {
        // Arrange
        const shortRoot = 'C:\\Users\\RUNNER~1\\Temp\\tsgit';
        const longRoot = 'C:\\Users\\runneradmin\\Temp\\tsgit';
        const sibling = 'C:\\Users\\RUNNER~1\\Temp\\tsgit-evil\\loot';
        const siblingCanonical = 'C:\\Users\\runneradmin\\Temp\\tsgit-evil\\loot';

        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === shortRoot) return longRoot;
            if (input === sibling) return siblingCanonical;
            throw enoent();
          }),
        });
        const sut = new NodeFileSystem(shortRoot, windowsPolicy, fsOps);

        // Act + Assert
        let caught: unknown;
        try {
          await sut.exists(sibling);
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('PERMISSION_DENIED');
      });
    });
    describe('When the child path differs only in case', () => {
      it('Then `exists` returns true', async () => {
        // Arrange — both root and child case-fold to the same string.
        const root = 'C:\\Users\\Foo\\tsgit';
        const child = 'c:\\users\\foo\\tsgit\\sub\\file.bin';

        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
        });
        const sut = new NodeFileSystem(root, windowsPolicy, fsOps);

        // Act
        const result = await sut.exists(child);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given Windows host and a non-existent long-form child inside the canonical root', () => {
    describe('When `exists` is called', () => {
      it('Then returns false (canonicalRoot operand of the OR)', async () => {
        // Arrange
        const shortRoot = 'C:\\Users\\RUNNER~1\\Temp\\tsgit';
        const longRoot = 'C:\\Users\\runneradmin\\Temp\\tsgit';
        const longChild = 'C:\\Users\\runneradmin\\Temp\\tsgit\\missing.bin';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === shortRoot) return longRoot;
            throw enoent();
          }),
        });
        const sut = new NodeFileSystem(shortRoot, windowsPolicy, fsOps);

        // Act
        const result = await sut.exists(longChild);

        // Assert — accepted via canonicalRoot operand.
        expect(result).toBe(false);
      });
    });
  });

  describe('Given Windows host and a non-existent short-form child inside the raw root', () => {
    describe('When `exists` is called', () => {
      it('Then returns false (raw-rootDir operand of the OR)', async () => {
        // Arrange — symmetric to the test above.
        const shortRoot = 'C:\\Users\\RUNNER~1\\Temp\\tsgit';
        const longRoot = 'C:\\Users\\runneradmin\\Temp\\tsgit';
        const shortChild = 'C:\\Users\\RUNNER~1\\Temp\\tsgit\\missing.bin';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === shortRoot) return longRoot;
            throw enoent();
          }),
        });
        const sut = new NodeFileSystem(shortRoot, windowsPolicy, fsOps);

        // Act
        const result = await sut.exists(shortChild);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given POSIX host', () => {
    describe('When the child path differs only in case', () => {
      it('Then PERMISSION_DENIED is thrown (case-sensitive)', async () => {
        // Arrange
        const root = '/Users/Foo/tsgit';
        const child = '/users/foo/tsgit/sub/file.bin';

        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
        });
        const sut = new NodeFileSystem(root, posixPolicy, fsOps);

        // Act + Assert
        let caught: unknown;
        try {
          await sut.exists(child);
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });
});

describe('realpathNearestExisting — non-ENOENT rethrow (DI)', () => {
  describe('Given the deepest realpath rejects with ENOTDIR', () => {
    describe('When resolving', () => {
      it('Then the original errno propagates (not swallowed as ENOENT)', async () => {
        // Arrange
        const target = '/root/block/child/leaf.txt';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockRejectedValue(enotdir()),
        });

        // Act
        let caught: unknown;
        try {
          await realpathNearestExisting(target, posixPolicy, fsOps);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(Error);
        expect((caught as NodeJS.ErrnoException).code).toBe('ENOTDIR');
      });
    });
  });
});

describe('NodeFileSystem.exists — non-ENOENT errno from realpath (DI)', () => {
  describe('Given realpath rejects with ENOTDIR', () => {
    describe('When exists is called', () => {
      it('Then throws NOT_A_DIRECTORY', async () => {
        // Arrange
        const rootDir = '/root';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === rootDir) return rootDir;
            throw enotdir();
          }),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.exists('/root/block/child.txt');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('NOT_A_DIRECTORY');
      });
    });
  });

  describe('Given in-root path whose realpath resolves outside the canonical root', () => {
    describe('When exists is called', () => {
      it('Then throws PERMISSION_DENIED (escape branch)', async () => {
        // Arrange — simulates an in-root symlink whose target lies outside.
        const rootDir = '/root';
        const outside = '/elsewhere/secret.txt';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === rootDir) return rootDir;
            return outside;
          }),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.exists('/root/escape-link');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });
});

describe('NodeFileSystem.checkContainment — non-ENOENT errno from realpath (DI)', () => {
  describe('Given `read` with realpath rejecting ENOTDIR', () => {
    describe('When called', () => {
      it('Then throws NOT_A_DIRECTORY (mapErrno branch in checkContainment catch)', async () => {
        // Arrange
        const rootDir = '/root';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === rootDir) return rootDir;
            throw enotdir();
          }),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.read('/root/block/child.txt');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('NOT_A_DIRECTORY');
      });
    });
  });
});

describe('resolveForMode — lstat mode pre-realpath check (DI)', () => {
  describe('Given lstat called against an absolute out-of-tree path', () => {
    describe('When checkContainment runs', () => {
      it('Then PERMISSION_DENIED fires BEFORE realpath(dirname)', async () => {
        // Arrange — the lstat mode used to issue realpath(dirname) BEFORE
        // any containment check. After it mirrors read mode: the
        // pre-realpath `check(resolved)` arm fires and throws permissionDenied
        // before any I/O on the leaf's parent. We pin the absence of the
        // leaf-parent realpath call as the regression signal.
        const rootDir = '/root';
        const outside = '/elsewhere/leaf.bin';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.lstat(outside);
        } catch (err) {
          caught = err;
        }

        // Assert — PERMISSION_DENIED + only the canonical-root realpath
        // fired (no realpath for `/elsewhere`).
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('PERMISSION_DENIED');
        const dirnameCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/elsewhere',
        );
        expect(dirnameCalls.length).toBe(0);
      });
    });
  });
});

describe('NodeFileSystem — lstat-mode parent-realpath LRU (DI)', () => {
  const fileStat = {
    ctimeMs: BigInt(0),
    mtimeMs: BigInt(0),
    dev: BigInt(0),
    ino: BigInt(0),
    mode: BigInt(0o100644),
    uid: BigInt(0),
    gid: BigInt(0),
    size: BigInt(0),
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };

  describe('Given two lstats of same-directory siblings', () => {
    describe('When the second fires', () => {
      it('Then realpath(dirname) is invoked exactly once', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.lstat('/root/sub/a');
        await sut.lstat('/root/sub/b');

        // Assert
        const parentCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/sub',
        );
        expect(parentCalls.length).toBe(1);
      });
    });
  });

  describe('Given lstats in different directories', () => {
    describe('When both fire', () => {
      it('Then realpath is invoked once per distinct dirname', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.lstat('/root/x/a');
        await sut.lstat('/root/y/a');

        // Assert
        const xCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/x',
        );
        const yCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/y',
        );
        expect(xCalls.length).toBe(1);
        expect(yCalls.length).toBe(1);
      });
    });
  });

  describe('Given an lstat populates the cache', () => {
    describe('When rmRecursive then a same-dir lstat fires', () => {
      it('Then realpath(dirname) is invoked twice total', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi.fn().mockResolvedValue(fileStat),
          rm: vi.fn().mockResolvedValue(undefined),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.lstat('/root/sub/a');
        await sut.rmRecursive('/root/sub/a');
        await sut.lstat('/root/sub/b');

        // Assert
        const parentCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/sub',
        );
        expect(parentCalls.length).toBe(2);
      });
    });

    describe('When rename then a same-dir lstat fires', () => {
      it('Then realpath(dirname) is invoked twice total', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.lstat('/root/sub/a');
        await sut.rename('/root/sub/a', '/root/sub/renamed');
        await sut.lstat('/root/sub/b');

        // Assert
        const parentCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/sub',
        );
        expect(parentCalls.length).toBe(2);
      });
    });
  });

  describe('Given an lstat whose parent is ENOENT', () => {
    describe('When it fires', () => {
      it('Then nothing is cached and a later same-parent lstat re-attempts', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return rootDir;
          throw enoent();
        });
        const fsOps = fakeFsOps({ realpath: realpathSpy });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let firstCaught: unknown;
        try {
          await sut.lstat('/root/missing/a');
        } catch (err) {
          firstCaught = err;
        }
        let secondCaught: unknown;
        try {
          await sut.lstat('/root/missing/b');
        } catch (err) {
          secondCaught = err;
        }

        // Assert
        expect(firstCaught).toBeInstanceOf(TsgitError);
        expect((firstCaught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
        expect(secondCaught).toBeInstanceOf(TsgitError);
        expect((secondCaught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
        const parentCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/missing',
        );
        expect(parentCalls.length).toBe(2);
      });
    });
  });

  describe('Given N loose-object lstats sharing one fanout dir (object-resolver probe shape)', () => {
    describe('When each loose probe fires an lstat', () => {
      it('Then realpath(fanout dir) is invoked at most once per distinct fanout dir', async () => {
        // Arrange — 5 loose-object paths under the same fanout dir, mirroring
        // the object-resolver's `looseObjectPath` layout (objects/xx/<38 hex>).
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);
        const fanoutDir = '/root/objects/ab';

        // Act
        for (let i = 0; i < 5; i += 1) {
          await sut.lstat(`${fanoutDir}/leaf${i}`);
        }

        // Assert — the fanout dir is realpath'd exactly once, not once per object.
        const fanoutCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === fanoutDir,
        );
        expect(fanoutCalls.length).toBe(1);
      });
    });

    describe('When more than the OLD 64-entry cap but within the NEW 512-entry cap of distinct fanout dirs are touched', () => {
      it('Then an already-seen dir is NOT re-realpathed (DC-9 resize regression guard)', async () => {
        // Arrange — 300 distinct fanout dirs (> old cap 64, within new cap 512).
        // If the resize regressed to the old 64-entry cap, dir #1 would be
        // evicted long before we re-touch it, forcing a second realpath.
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);
        const fanoutDir = (n: number): string => `/root/objects/${n.toString(16).padStart(2, '0')}`;

        // Act — touch 300 distinct fanout dirs, then re-touch dir #1.
        for (let i = 0; i < 300; i += 1) {
          await sut.lstat(`${fanoutDir(i)}/leaf`);
        }
        await sut.lstat(`${fanoutDir(1)}/leaf-again`);

        // Assert — dir #1's realpath was invoked exactly once across the whole run.
        const dir1Calls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === fanoutDir(1),
        );
        expect(dir1Calls.length).toBe(1);
      });
    });
  });
});

describe('resolveForCreation — non-ENOENT errno on leaf lstat (DI)', () => {
  describe('Given the leaf parent lstat throws ENOTDIR (file used as directory)', () => {
    describe('When write is called', () => {
      it('Then throws NOT_A_DIRECTORY', async () => {
        // Arrange — creation target is `/root/block/leaf.txt`. The walk-up
        // hits `block` (a file), then the lstat on the leaf throws ENOTDIR.
        // interpretCreationLstat must funnel it through mapErrno.
        const rootDir = '/root';
        const blocker = '/root/block';
        const leaf = '/root/block/leaf.txt';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === rootDir) return rootDir;
            if (input === blocker) return blocker;
            throw enoent();
          }),
          lstat: vi.fn().mockRejectedValue(enotdir()),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.write(leaf, new Uint8Array([1]));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('NOT_A_DIRECTORY');
      });
    });
  });
});

describe('NodeFileSystem.readlink + chmod + symlink (DI)', () => {
  describe('Given a contained symlink', () => {
    describe('When readlink is called', () => {
      it('Then returns the target path from fsOps.readlink', async () => {
        // Arrange
        const rootDir = '/root';
        const link = '/root/link.txt';
        const target = '/root/target.txt';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          readlink: vi.fn().mockResolvedValue(target),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const result = await sut.readlink(link);

        // Assert
        expect(result).toBe(target);
      });
    });
  });

  describe('Given a contained file', () => {
    describe('When chmod is called', () => {
      it('Then fsOps.chmod is invoked with the right args', async () => {
        // Arrange
        const rootDir = '/root';
        const path = '/root/perm.bin';
        const realpath = vi.fn().mockImplementation(async (input: string) => input);
        const chmod = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({ realpath, chmod });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.chmod(path, 0o600);

        // Assert
        expect(chmod).toHaveBeenCalledWith(path, 0o600);
      });
    });
  });

  describe('Given a contained creation path', () => {
    describe('When symlink is called', () => {
      it('Then fsOps.mkdir(dirname) + fsOps.symlink(target, path) are invoked', async () => {
        // Arrange
        const rootDir = '/root';
        const target = '/root/target.txt';
        const link = '/root/sub/link.txt';
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return rootDir;
          throw enoent();
        });
        const mkdir = vi.fn().mockResolvedValue(undefined);
        const symlink = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath,
          mkdir,
          symlink,
          lstat: vi.fn().mockRejectedValue(enoent()),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.symlink(target, link);

        // Assert
        expect(mkdir).toHaveBeenCalledWith('/root/sub', { recursive: true });
        expect(symlink).toHaveBeenCalledWith(target, link);
      });
    });
  });

  describe('Given an absolute symlink target outside rootDir', () => {
    describe('When symlink is called', () => {
      it('Then PERMISSION_DENIED is thrown and fsOps.symlink is NOT invoked', async () => {
        // Arrange — closes the absolute-symlink-info-oracle path. A
        // malicious tree planting /etc/passwd as a symlink target would
        // succeed under the old code; here the absolute-target check
        // rejects it at creation.
        const rootDir = '/root';
        const link = '/root/exfil-link';
        const symlinkOp = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          symlink: symlinkOp,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.symlink('/etc/passwd', link);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        expect(symlinkOp).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given an absolute target with `..` that resolves OUTSIDE rootDir', () => {
    describe('When symlink runs', () => {
      it('Then PERMISSION_DENIED is thrown', async () => {
        // Arrange — the absolute-target check resolves embedded `..` before
        // comparing, so `/root/sub/../../escape` does not slip past.
        const rootDir = '/root';
        const link = '/root/escape-link';
        const symlinkOp = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          symlink: symlinkOp,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.symlink('/root/sub/../../escape', link);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        expect(symlinkOp).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a relative symlink target (even one containing ..)', () => {
    describe('When symlink is called', () => {
      it('Then fsOps.symlink is invoked unchanged', async () => {
        // Arrange — relatives are intentionally not validated at create time;
        // resolution happens at the OS level when the link is followed, and
        // subsequent read/stat re-checks containment.
        const rootDir = '/root';
        const link = '/root/relative-link';
        const symlinkOp = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          mkdir: vi.fn().mockResolvedValue(undefined),
          symlink: symlinkOp,
          lstat: vi.fn().mockRejectedValue(enoent()),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.symlink('../sibling.txt', link);

        // Assert
        expect(symlinkOp).toHaveBeenCalledWith('../sibling.txt', link);
      });
    });
  });
});

describe('NodeFileSystem.openWithNoFollow — handle wrapper semantics (DI)', () => {
  const makeHandleFake = () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValue({ bytesRead: 0, buffer: Buffer.alloc(0) });
    const statHandle = vi.fn().mockResolvedValue({
      ctimeMs: BigInt(1),
      mtimeMs: BigInt(2),
      dev: BigInt(3),
      ino: BigInt(4),
      mode: BigInt(0o100644),
      uid: BigInt(0),
      gid: BigInt(0),
      size: BigInt(0),
      ctimeNs: BigInt(11),
      mtimeNs: BigInt(22),
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    });
    return { handle: { close, read, stat: statHandle }, close, read, statHandle };
  };

  describe('Given a wrapped FileHandle', () => {
    describe('When close is called twice', () => {
      it('Then the underlying close runs exactly once (closed-flag idempotency)', async () => {
        // Arrange
        const rootDir = '/root';
        const { handle, close } = makeHandleFake();
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false }),
          open: vi.fn().mockResolvedValue(handle),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const wrapped = await sut.openWithNoFollow('/root/file.bin', 'read');
        await wrapped.close();
        await wrapped.close();

        // Assert — kills BooleanLiteral / ConditionalExpression / BlockStatement
        // mutants on the `closed` guard in wrapNodeHandle.close (lines 176, 187,
        // 188 of node-file-system.ts).
        expect(close).toHaveBeenCalledTimes(1);
      });
    });
    describe('When stat is called', () => {
      it('Then the underlying call uses { bigint: true } and the ns fields survive', async () => {
        // Arrange
        const rootDir = '/root';
        const { handle, statHandle } = makeHandleFake();
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false }),
          open: vi.fn().mockResolvedValue(handle),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);
        const wrapped = await sut.openWithNoFollow('/root/file.bin', 'read');

        // Act
        const stat = await wrapped.stat();
        await wrapped.close();

        // Assert — kills ObjectLiteral / BooleanLiteral mutants on
        // `{ bigint: true }` (line 185). If the flag is dropped, ctimeNs is
        // not populated; if it flips to false, the underlying fake is no
        // longer called with the expected shape.
        expect(statHandle).toHaveBeenCalledWith({ bigint: true });
        expect(stat.ctimeNs).toBe(BigInt(11));
        expect(stat.mtimeNs).toBe(BigInt(22));
      });
    });
  });
});

describe('NodeFileSystem — TsgitError rethrow defence (DI)', () => {
  describe('Given realpath synthesises a TsgitError', () => {
    describe('When exists is called', () => {
      it('Then exists rethrows it unchanged (no re-wrap via mapErrno)', async () => {
        // Arrange — exercises the defensive `if (err instanceof TsgitError)
        // throw err` branch in `exists`'s catch. The mutant `if (false) throw
        // err` would either funnel into mapErrno (errno path) or fall through
        // to the final `throw err`. Both paths re-emit a TsgitError so the
        // observable behaviour can drift. Pinning the *exact* same instance
        // identity kills the early-return mutant.
        const rootDir = '/root';
        const sentinel = new TsgitError({ code: 'OPERATION_ABORTED' });
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === rootDir) return rootDir;
            throw sentinel;
          }),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.exists('/root/probe.txt');
        } catch (err) {
          caught = err;
        }

        // Assert — same instance round-trips back (defensive branch fired).
        expect(caught).toBe(sentinel);
      });
    });
    describe('When read is called', () => {
      it('Then checkContainment rethrows it unchanged', async () => {
        // Arrange — same logic for `checkContainment`'s catch block (line 551).
        const rootDir = '/root';
        const sentinel = new TsgitError({ code: 'OPERATION_ABORTED' });
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === rootDir) return rootDir;
            throw sentinel;
          }),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.read('/root/probe.txt');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(sentinel);
      });
    });
  });
});

describe('NodeFileSystem.rmRecursive — option-shape pin (DI)', () => {
  const fileStat = {
    ctimeMs: BigInt(0),
    mtimeMs: BigInt(0),
    dev: BigInt(0),
    ino: BigInt(0),
    mode: BigInt(0o100644),
    uid: BigInt(0),
    gid: BigInt(0),
    size: BigInt(0),
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };

  describe('Given rmRecursive on a single regular file', () => {
    describe('When the leaf is removed', () => {
      it('Then `fs.rm` is called with `{ force: true }` (TOCTOU mid-walk tolerance)', async () => {
        // Arrange — pins the `{ force: true }` option on rmRecursive's leaf
        // removal (node-file-system.ts:482). The flag matters because Node's
        // `fs.rm` would otherwise throw ENOENT on a mid-walk TOCTOU delete;
        // the option-shape assertion catches BooleanLiteral/ObjectLiteral
        // mutants that strip or flip the flag.
        const rootDir = '/root';
        const target = '/root/file.txt';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue(fileStat),
          rm: vi.fn().mockResolvedValue(undefined),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.rmRecursive(target);

        // Assert — Node's fs.rm receives the exact option object the source
        // emits. A mutant that strips the `force` key, or flips it to false,
        // would fail this match.
        expect(fsOps.rm).toHaveBeenCalledWith(target, { force: true });
      });
    });
  });

  describe('Given rmRecursive existence probe', () => {
    describe('When the leaf is verified', () => {
      it('Then the inner lstat does NOT re-enter checkContainment (no third realpath(rootDir) call)', async () => {
        // Arrange — pins: the existence probe was calling
        // `this.lstat(real)` which re-entered checkContainment and produced
        // an extra `realpath(dirname)` (= rootDir for a top-level target)
        // round-trip. After the fix, the probe calls
        // `runFs(() => this.fsOps.lstat(real), path)` directly.
        //
        // Pre-fix call count for realpath(rootDir): 3
        //  - getCanonicalRoot
        //  - resolveForMode('lstat') dirname
        //  - this.lstat(real) → resolveForMode('lstat') dirname (re-entry)
        // Post-fix count: 2 (the re-entry is gone).
        const rootDir = '/root';
        const target = '/root/file.txt';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi.fn().mockResolvedValue(fileStat),
          rm: vi.fn().mockResolvedValue(undefined),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.rmRecursive(target);

        // Assert
        const rootCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === rootDir,
        );
        expect(rootCalls.length).toBe(2);
      });
    });
  });
});

describe('mapConcurrent — empty-input short-circuit (DI)', () => {
  describe('Given an empty input and a negative limit', () => {
    describe('When mapped', () => {
      it('Then it resolves without throwing (short-circuit fires before Math.min/Array.from)', async () => {
        // Arrange — a negative limit would make `Array.from({ length:
        // Math.min(limit, 0) })` throw RangeError. The empty-input guard
        // returns BEFORE that line, so the call must resolve cleanly. A
        // mutant that drops the guard (ConditionalExpression → false) reaches
        // `Array.from` and throws.
        const fn = vi.fn(async () => undefined);

        // Act
        let caught: unknown;
        try {
          await mapConcurrent([], -1, fn);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeUndefined();
        expect(fn).not.toHaveBeenCalled();
      });
    });
  });
});

describe('realpathNearestExisting — root extraction and walk (DI)', () => {
  describe('Given a leaf that does not exist', () => {
    describe('When resolving', () => {
      it('Then it walks up to the nearest existing ancestor (rootOf must yield the prefix, not the whole path)', async () => {
        // Arrange — `realpath` succeeds only for `/root/exists`; the leaf
        // ENOENTs. A mutant replacing `policy.rootOf(absolute)` with
        // `absolute` makes `root` the whole path, `tail` empty, and skips the
        // walk entirely — calling `realpath('/root/exists/missing')` (ENOENT)
        // then `realpath('/root/exists/missing')` again and throwing.
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === '/root/exists') return '/root/exists';
          throw enoent();
        });
        const fsOps = fakeFsOps({ realpath });

        // Act
        const result = await realpathNearestExisting('/root/exists/missing', posixPolicy, fsOps);

        // Assert — walk landed on `/root/exists` and re-joined the tail.
        expect(result).toBe('/root/exists/missing');
      });
    });
  });

  describe('Given a path with a doubled separator', () => {
    describe('When resolving', () => {
      it('Then empty segments are filtered out (no spurious double-separator candidate)', async () => {
        // Arrange — `realpath` is identity for any input. With `.filter(Boolean)`
        // the segments of `/root//a` are `['root','a']`, so the first candidate
        // is `/root/a` and the resolved result is `/root/a`. A mutant dropping
        // `.filter(Boolean)` keeps the empty segment, making the first candidate
        // `/root//a`, which `realpath` (identity) accepts → result `/root//a`.
        const realpath = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({ realpath });

        // Act
        const result = await realpathNearestExisting('/root//a', posixPolicy, fsOps);

        // Assert
        expect(result).toBe('/root/a');
      });
    });
  });

  describe('Given every segment and the root all ENOENT', () => {
    describe('When resolving', () => {
      it('Then realpath(root) is invoked exactly once (loop bound must stop at i > 0)', async () => {
        // Arrange — nothing resolves. With the `i > 0` bound the loop never
        // probes the root, so `realpath('/')` fires once at the post-loop
        // anchor. A mutant relaxing the bound to `i >= 0` adds an in-loop
        // `i === 0` iteration that calls `realpath('/')` too — two calls.
        const realpath = vi.fn().mockRejectedValue(enoent());
        const fsOps = fakeFsOps({ realpath });

        // Act
        let caught: unknown;
        try {
          await realpathNearestExisting('/missing', posixPolicy, fsOps);
        } catch (err) {
          caught = err;
        }

        // Assert — propagates ENOENT and probed the root exactly once.
        expect(caught).toBeInstanceOf(Error);
        expect((caught as NodeJS.ErrnoException).code).toBe('ENOENT');
        const rootCalls = realpath.mock.calls.filter(([arg]: readonly unknown[]) => arg === '/');
        expect(rootCalls.length).toBe(1);
      });
    });
  });

  describe('Given a deep realpath rejecting with a non-ENOENT errno while an ancestor resolves', () => {
    describe('When resolving', () => {
      it('Then the errno propagates (catch must not swallow it)', async () => {
        // Arrange — `realpath('/root/a/b')` rejects EACCES; `/root` resolves.
        // The catch only `continue`s on ENOENT, so EACCES must propagate.
        // Mutants that empty the catch block (BlockStatement → {}) or force
        // the guard true (ConditionalExpression → true) would swallow EACCES,
        // continue the walk to `/root`, and return successfully instead.
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === '/root') return '/root';
          if (input === '/root/a/b') throw eacces();
          throw enoent();
        });
        const fsOps = fakeFsOps({ realpath });

        // Act
        let caught: unknown;
        try {
          await realpathNearestExisting('/root/a/b', posixPolicy, fsOps);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(Error);
        expect((caught as NodeJS.ErrnoException).code).toBe('EACCES');
      });
    });
  });

  describe('Given a deep realpath rejecting with a non-errno value while an ancestor resolves', () => {
    describe('When resolving', () => {
      it('Then the value propagates (guard must require ENOENT, not just any errno)', async () => {
        // Arrange — `realpath('/root/a/b')` rejects with a plain string;
        // `/root` resolves. `isErrnoException` is false for a string, so the
        // catch must rethrow it. A mutant forcing the whole guard true
        // (ConditionalExpression → true at the `&&` root) would `continue`
        // and resolve against `/root` instead of propagating the string.
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === '/root') return '/root';
          if (input === '/root/a/b') throw 'not-an-error';
          throw enoent();
        });
        const fsOps = fakeFsOps({ realpath });

        // Act
        let caught: unknown;
        try {
          await realpathNearestExisting('/root/a/b', posixPolicy, fsOps);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe('not-an-error');
      });
    });
  });
});

describe('NodeFileSystem.openWithNoFollow — handle.read position (DI)', () => {
  describe('Given a wrapped FileHandle', () => {
    describe('When read is called with an explicit non-zero position', () => {
      it('Then the underlying read receives that position (not coerced to null)', async () => {
        // Arrange — `wrapNodeHandle.read` forwards `position ?? null`. A
        // mutant turning `??` into `&&` would compute `5 && null === null`,
        // dropping the caller's position. Pin the exact 4th argument.
        const rootDir = '/root';
        const readSpy = vi.fn().mockResolvedValue({ bytesRead: 0, buffer: Buffer.alloc(0) });
        const handle = { read: readSpy, close: vi.fn().mockResolvedValue(undefined) };
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false }),
          open: vi.fn().mockResolvedValue(handle),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);
        const wrapped = await sut.openWithNoFollow('/root/file.bin', 'read');
        const buffer = new Uint8Array(8);

        // Act
        await wrapped.read(buffer, 0, 8, 5);
        await wrapped.close();

        // Assert
        expect(readSpy).toHaveBeenCalledWith(buffer, 0, 8, 5);
      });
    });
    describe('When read is called without a position', () => {
      it('Then the underlying read receives null (?? default)', async () => {
        // Arrange — companion to the test above: the omitted-position arm.
        const rootDir = '/root';
        const readSpy = vi.fn().mockResolvedValue({ bytesRead: 0, buffer: Buffer.alloc(0) });
        const handle = { read: readSpy, close: vi.fn().mockResolvedValue(undefined) };
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false }),
          open: vi.fn().mockResolvedValue(handle),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);
        const wrapped = await sut.openWithNoFollow('/root/file.bin', 'read');
        const buffer = new Uint8Array(8);

        // Act
        await wrapped.read(buffer, 0, 8);
        await wrapped.close();

        // Assert
        expect(readSpy).toHaveBeenCalledWith(buffer, 0, 8, null);
      });
    });
  });
});

describe('NodeFileSystem.readSlice — handle close on success (DI)', () => {
  describe('Given a successful readSlice', () => {
    describe('When it returns', () => {
      it('Then the underlying FileHandle is closed (finally block is load-bearing)', async () => {
        // Arrange — `readSlice` opens a handle and must close it in its
        // `finally` block. A mutant emptying that block (BlockStatement → {})
        // leaks the descriptor. Inject a fake handle and assert `close` ran.
        const rootDir = '/root';
        const payload = Buffer.from([1, 2, 3, 4]);
        const closeSpy = vi.fn().mockResolvedValue(undefined);
        const handle = {
          read: vi.fn().mockImplementation(async (buf: Buffer) => {
            payload.copy(buf);
            return { bytesRead: payload.length, buffer: buf };
          }),
          close: closeSpy,
        };
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          open: vi.fn().mockResolvedValue(handle),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const slice = await sut.readSlice('/root/file.bin', 0, 4);

        // Assert
        expect(slice).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(closeSpy).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe('NodeFileSystem.symlink — absolute-target containment OR (DI)', () => {
  describe('Given an absolute target inside the canonical root but outside the raw root', () => {
    describe('When symlink runs', () => {
      it('Then it succeeds (raw operand alone must not refuse)', async () => {
        // Arrange — 8.3 short/long-name skew: the raw rootDir is the short
        // form, its realpath is the long form. A target spelled in the long
        // (canonical) form is contained by the canonical root but NOT the raw
        // root. With the `&&` guard the symlink is created. A mutant flipping
        // `&&` to `||` would refuse because the raw-root operand fails.
        const shortRoot = 'C:\\Users\\RUNNER~1\\tsgit';
        const longRoot = 'C:\\Users\\runneradmin\\tsgit';
        const longTarget = 'C:\\Users\\runneradmin\\tsgit\\target';
        const link = 'C:\\Users\\RUNNER~1\\tsgit\\link';
        const symlinkOp = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === shortRoot) return longRoot;
            if (input === longTarget) return longTarget;
            throw enoent();
          }),
          symlink: symlinkOp,
        });
        const sut = new NodeFileSystem(shortRoot, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.symlink(longTarget, link);
        } catch (err) {
          caught = err;
        }

        // Assert — the symlink op ran with the (unmodified) absolute target.
        expect(caught).toBeUndefined();
        expect(symlinkOp).toHaveBeenCalledTimes(1);
        expect(symlinkOp.mock.calls[0]?.[0]).toBe(longTarget);
      });
    });
  });

  describe('Given an absolute target inside the raw root but outside the canonical root', () => {
    describe('When symlink runs', () => {
      it('Then it succeeds (canonical operand alone must not refuse)', async () => {
        // Arrange — symmetric to the test above. The target is spelled in the
        // short (raw) form: contained by the raw root, NOT the canonical root.
        // A mutant flipping `&&` to `||` refuses because the canonical operand
        // fails.
        const shortRoot = 'C:\\Users\\RUNNER~1\\tsgit';
        const longRoot = 'C:\\Users\\runneradmin\\tsgit';
        const shortTarget = 'C:\\Users\\RUNNER~1\\tsgit\\target';
        const link = 'C:\\Users\\RUNNER~1\\tsgit\\link';
        const symlinkOp = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === shortRoot) return longRoot;
            if (input === shortTarget) return shortTarget;
            throw enoent();
          }),
          symlink: symlinkOp,
        });
        const sut = new NodeFileSystem(shortRoot, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.symlink(shortTarget, link);
        } catch (err) {
          caught = err;
        }

        // Assert — the symlink op ran with the (unmodified) absolute target.
        expect(caught).toBeUndefined();
        expect(symlinkOp).toHaveBeenCalledTimes(1);
        expect(symlinkOp.mock.calls[0]?.[0]).toBe(shortTarget);
      });
    });
  });
});

describe('NodeFileSystem.openWithNoFollow — UNSUPPORTED_OPERATION rewrap (DI)', () => {
  describe('Given a Windows regular file whose open rejects with an unknown errno', () => {
    describe('When openWithNoFollow runs', () => {
      it('Then the discriminator rewraps UNSUPPORTED_OPERATION to PERMISSION_DENIED', async () => {
        // Arrange — an unknown errno hits `mapErrno`'s default arm →
        // UNSUPPORTED_OPERATION. `isWindowsSymlinkRefusal` returns true for
        // that code, so the catch block rewraps it to PERMISSION_DENIED. A
        // mutant that skips the rewrap (ConditionalExpression → false) or
        // empties the block (BlockStatement → {}) surfaces UNSUPPORTED_OPERATION.
        const eunknown = (): NodeJS.ErrnoException =>
          Object.assign(new Error('unknown errno'), { code: 'EWHATEVER' });
        const root = 'C:\\canonical\\win-unknown';
        const file = 'C:\\canonical\\win-unknown\\leaf';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false }),
          open: vi.fn().mockRejectedValue(eunknown()),
        });
        const sut = new NodeFileSystem(root, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.openWithNoFollow(file, 'read');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });
});

describe('NodeFileSystem.realpathForCreation — non-ENOENT parent error (DI)', () => {
  describe('Given the direct parent realpath rejects ENOTDIR while the leaf realpath resolves', () => {
    describe('When write runs', () => {
      it('Then NOT_A_DIRECTORY is thrown (non-ENOENT must not trigger the walk-up)', async () => {
        // Arrange — `realpath` resolves the leaf and rootDir but rejects the
        // parent with ENOTDIR. The cache-miss path's catch must rethrow any
        // non-ENOENT error. A mutant forcing the guard true (whole condition
        // or just the `code === 'ENOENT'` operand) would instead run the
        // walk-up `realpathNearestExisting`, which resolves the leaf directly
        // and lets the write succeed.
        const rootDir = '/root';
        const parent = '/root/sub';
        const leaf = '/root/sub/leaf.bin';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === rootDir) return rootDir;
            if (input === leaf) return leaf;
            if (input === parent) throw enotdir();
            throw enoent();
          }),
          lstat: vi.fn().mockRejectedValue(enoent()),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.write(leaf, new Uint8Array([1]));
        } catch (err) {
          caught = err;
        }

        // Assert — the ENOTDIR propagated and mapped; the write never ran.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('NOT_A_DIRECTORY');
        expect(fsOps.writeFile).not.toHaveBeenCalled();
      });
    });
  });
});

describe('NodeFileSystem — containment prefix precompute (DI)', () => {
  const fileStat = {
    ctimeMs: BigInt(0),
    mtimeMs: BigInt(0),
    dev: BigInt(0),
    ino: BigInt(0),
    mode: BigInt(0o100644),
    uid: BigInt(0),
    gid: BigInt(0),
    size: BigInt(0),
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };

  describe('Given many containment checks', () => {
    describe('When fired in sequence (posix)', () => {
      it('Then normalizeForCompare runs at most once per constant parent AND the child normalises once per isContainedInEitherRoot', async () => {
        // Arrange
        const rootDir = '/root';
        const normalizeSpy = vi.fn((p: string) => p);
        const spyPolicy = { ...posixPolicy, normalizeForCompare: normalizeSpy };
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, spyPolicy, fsOps);

        // Act — N lstats under the same parent.
        for (let i = 0; i < 5; i++) {
          await sut.lstat(`/root/sub/file-${i}`);
        }

        // Assert — rootDir and canonicalRoot normalise to the SAME string
        // here (fake realpath echoes its input), so both memoised prefixes
        // are keyed off one normalise call each: 2 total for the constant
        // parent (rootDir's own prefix + the canonical-root prefix), never
        // growing with N.
        const parentCalls = normalizeSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === rootDir,
        );
        expect(parentCalls.length).toBe(2);

        // Each entry's PRE-check and POST-check normalise the child once each
        // (not twice per check) — one isContainedInEitherRoot call now costs
        // one normalise of `abs`, not one per root compared.
        const childCalls = normalizeSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/sub/file-0',
        );
        expect(childCalls.length).toBe(2);
      });
    });

    describe('When fired in sequence (windows)', () => {
      it('Then normalizeForCompare runs at most once per constant parent AND the child normalises once per isContainedInEitherRoot', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const normalizeSpy = vi.fn((p: string) => p.toLowerCase());
        const spyPolicy = { ...windowsPolicy, normalizeForCompare: normalizeSpy };
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, spyPolicy, fsOps);

        // Act — N lstats under the same parent.
        for (let i = 0; i < 5; i++) {
          await sut.lstat(`C:\\Root\\sub\\file-${i}`);
        }

        // Assert — same rationale as the posix case: 2 total normalise
        // calls for the constant parent (rootDir's own prefix + the
        // canonical-root prefix), never growing with N.
        const parentCalls = normalizeSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === rootDir,
        );
        expect(parentCalls.length).toBe(2);

        const childCalls = normalizeSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === 'C:\\Root\\sub\\file-0',
        );
        expect(childCalls.length).toBe(2);
      });
    });
  });

  describe('Given a child equal to the root (posix)', () => {
    describe('When lstat runs on the root itself', () => {
      it('Then it is contained (=== arm)', async () => {
        // Arrange
        const rootDir = '/root';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const result = await sut.lstat('/root');

        // Assert
        expect(result.isFile).toBe(true);
      });
    });
  });

  describe('Given a child strictly under the root (posix)', () => {
    describe('When lstat runs', () => {
      it('Then it is contained (startsWith arm)', async () => {
        // Arrange
        const rootDir = '/root';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const result = await sut.lstat('/root/sub/leaf');

        // Assert
        expect(result.isFile).toBe(true);
      });
    });
  });

  describe("Given a prefix-only sibling '/root-evil' vs root '/root'", () => {
    describe('When lstat runs', () => {
      it('Then PERMISSION_DENIED', async () => {
        // Arrange
        const rootDir = '/root';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.lstat('/root-evil/leaf');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given a child equal to the root (windows)', () => {
    describe('When lstat runs on the root itself', () => {
      it('Then it is contained (=== arm)', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        const result = await sut.lstat('C:\\Root');

        // Assert
        expect(result.isFile).toBe(true);
      });
    });
  });

  describe('Given a child strictly under the root (windows, case-folded)', () => {
    describe('When lstat runs', () => {
      it('Then it is contained (startsWith arm)', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        const result = await sut.lstat('c:\\root\\x');

        // Assert
        expect(result.isFile).toBe(true);
      });
    });
  });

  describe("Given a prefix-only sibling 'C:\\Root-evil' vs root 'C:\\Root' (windows)", () => {
    describe('When lstat runs', () => {
      it('Then PERMISSION_DENIED', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.lstat('C:\\Root-evil\\leaf');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given the first realpath(rootDir) rejects', () => {
    describe('When a second containment check runs', () => {
      it('Then the canonical +sep prefix is recomputed (not stale)', async () => {
        // Arrange — first realpath(rootDir) fails (transient ENOENT), second
        // succeeds with a DIFFERENT canonical root than rootDir itself. A
        // child contained only by the retried canonical root must be
        // admitted — proving the +sep prefix was recomputed, not served stale.
        const rootDir = '/root';
        const canonicalRoot = '/canonical-root';
        let callCount = 0;
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) {
            callCount += 1;
            if (callCount === 1) throw enoent();
            return canonicalRoot;
          }
          if (input === canonicalRoot) return canonicalRoot;
          throw enoent();
        });
        const fsOps = fakeFsOps({
          realpath,
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act — first call fails on the transient ENOENT.
        await sut.lstat('/root/leaf').catch(() => undefined);
        // Second call retries; the child is contained only via the
        // canonical root's fresh +sep prefix, not the raw rootDir.
        const result = await sut.lstat('/canonical-root/leaf');

        // Assert
        expect(result.isFile).toBe(true);
      });
    });
  });
});
