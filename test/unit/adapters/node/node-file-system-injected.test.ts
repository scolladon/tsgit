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

  it('Given two writes into the same parent, When the second fires, Then realpath(parent) is invoked exactly once', async () => {
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

  it('Given a write path with `..` segments that escape rootDir, When write fires, Then containment refuses with PERMISSION_DENIED', async () => {
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

  it('Given an exists path with `..` segments that escape rootDir, When exists fires, Then containment refuses with PERMISSION_DENIED', async () => {
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

  it('Given a write whose parent realpath throws a non-ENOENT errno, When the call fires, Then the error propagates and nothing is cached', async () => {
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

  it('Given a write whose parent does not exist, When the call fires, Then the slow walk-up is used and nothing is cached', async () => {
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

  it('Given a cached parent, When rmRecursive runs, Then the cache is cleared and a follow-up write re-realpaths', async () => {
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
    //   1 from rmRecursive's lstat-mode containment (realpath(dirname))
    //   1 from the second write (cache was cleared by rmRecursive → miss)
    // Total: 3. Pinning the count kills mutants that would skip
    // invalidation (afterCount stays at 2) or invalidate too eagerly
    // (afterCount jumps to 4).
    const afterCount = realpathSpy.mock.calls.filter(
      ([arg]: readonly unknown[]) => arg === '/root/sub',
    ).length;
    expect(beforeRmCount).toBe(1);
    expect(afterCount).toBe(3);
  });
});

describe('NodeFileSystem — normalised-root cache (DI)', () => {
  it('Given many containment-checking calls, When fired in sequence, Then policy.normalizeForCompare runs at most once per constant parent', async () => {
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

describe('NodeFileSystem — canonical-root cache (DI)', () => {
  it('Given two sequential `exists` calls, When the second runs, Then realpath(rootDir) is invoked at most once for the root', async () => {
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
    const rootCalls = realpath.mock.calls.filter(([arg]: readonly unknown[]) => arg === rootDir);
    expect(rootCalls.length).toBe(1);
  });

  it('Given concurrent `exists` calls, When they fire, Then realpath(rootDir) is invoked at most once (promise dedupe)', async () => {
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
    const rootCalls = realpath.mock.calls.filter(([arg]: readonly unknown[]) => arg === rootDir);
    expect(rootCalls.length).toBe(1);
  });

  it('Given the first realpath(rootDir) rejects, When `exists` is called again, Then realpath is retried (cache reset on rejection)', async () => {
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
    const rootCalls = realpath.mock.calls.filter(([arg]: readonly unknown[]) => arg === rootDir);
    expect(rootCalls.length).toBe(2);
  });
});

describe('NodeFileSystem — openWithNoFollow Windows symlink refusal (DI)', () => {
  it('Given Windows host, symlink leaf, When openWithNoFollow(write) is called, Then PERMISSION_DENIED is thrown without invoking the underlying open', async () => {
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

  it('Given Windows host, symlink leaf, When open rejects with EACCES, Then openWithNoFollow throws PERMISSION_DENIED', async () => {
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

  it('Given Windows host, regular file (no symlink), When open rejects with EACCES, Then PERMISSION_DENIED is still thrown (via mapErrno)', async () => {
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

  it('Given Windows host, When lstat itself throws (TOCTOU race), Then isSymlinkLeaf returns false and the open error surfaces unchanged', async () => {
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

  it('Given Windows host, When lstat throws ENOENT (TOCTOU) and open succeeds, Then openWithNoFollow returns the handle (isSymlinkLeaf ENOENT must return false, NOT true)', async () => {
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

  it('Given Windows host, regular file, When open rejects with EISDIR (mapErrno → UNSUPPORTED_OPERATION), Then the catch-block discriminator rewraps to PERMISSION_DENIED', async () => {
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

  it('Given POSIX host, symlink leaf, When open rejects with ELOOP, Then openWithNoFollow throws PERMISSION_DENIED (via mapErrno)', async () => {
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

describe('NodeFileSystem — non-errno fault propagation (DI)', () => {
  it('Given `exists` and a realpath that rejects with a non-errno value, When called, Then the original value rethrows unchanged', async () => {
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

  it('Given `read` and a realpath that rejects with a non-errno value, When called, Then the original value rethrows unchanged', async () => {
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

  it('Given `openWithNoFollow` on a Windows symlink leaf, When lstat rejects with a non-ENOENT errno (EACCES), Then the error rethrows (not silently swallowed)', async () => {
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

describe('NodeFileSystem — 8.3 short-name parent reconciliation (DI)', () => {
  it('Given realpath flips between short and long forms across calls, When write goes through creation containment, Then it succeeds (canonical-root containment passes)', async () => {
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

  it('Given a read on a path that resolves outside rootDir, When the canonical roots both reject it, Then PERMISSION_DENIED is thrown (containment is load-bearing)', async () => {
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

describe('NodeFileSystem — Windows-mocked containment (DI)', () => {
  it('Given canonical-root realpath returns a long-name form, When `exists` runs against a short-name child, Then `exists` returns true', async () => {
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

  it('Given Windows host, When `exists` is called with a sibling outside the canonical root, Then PERMISSION_DENIED is thrown', async () => {
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

  it('Given Windows host, When the child path differs only in case, Then `exists` returns true', async () => {
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

  it('Given Windows host and a non-existent long-form child inside the canonical root, When `exists` is called, Then returns false (canonicalRoot operand of the OR)', async () => {
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

  it('Given Windows host and a non-existent short-form child inside the raw root, When `exists` is called, Then returns false (raw-rootDir operand of the OR)', async () => {
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

  it('Given POSIX host, When the child path differs only in case, Then PERMISSION_DENIED is thrown (case-sensitive)', async () => {
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

describe('realpathNearestExisting — non-ENOENT rethrow (DI)', () => {
  it('Given the deepest realpath rejects with ENOTDIR, When resolving, Then the original errno propagates (not swallowed as ENOENT)', async () => {
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

describe('NodeFileSystem.exists — non-ENOENT errno from realpath (DI)', () => {
  it('Given realpath rejects with ENOTDIR, When exists is called, Then throws NOT_A_DIRECTORY', async () => {
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

  it('Given in-root path whose realpath resolves outside the canonical root, When exists is called, Then throws PERMISSION_DENIED (escape branch)', async () => {
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

describe('NodeFileSystem.checkContainment — non-ENOENT errno from realpath (DI)', () => {
  it('Given `read` with realpath rejecting ENOTDIR, When called, Then throws NOT_A_DIRECTORY (mapErrno branch in checkContainment catch)', async () => {
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

describe('resolveForMode — lstat mode pre-realpath check (DI)', () => {
  it('Given lstat called against an absolute out-of-tree path, When checkContainment runs, Then PERMISSION_DENIED fires BEFORE realpath(dirname)', async () => {
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

describe('resolveForCreation — non-ENOENT errno on leaf lstat (DI)', () => {
  it('Given the leaf parent lstat throws ENOTDIR (file used as directory), When write is called, Then throws NOT_A_DIRECTORY', async () => {
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

describe('NodeFileSystem.readlink + chmod + symlink (DI)', () => {
  it('Given a contained symlink, When readlink is called, Then returns the target path from fsOps.readlink', async () => {
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

  it('Given a contained file, When chmod is called, Then fsOps.chmod is invoked with the right args', async () => {
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

  it('Given a contained creation path, When symlink is called, Then fsOps.mkdir(dirname) + fsOps.symlink(target, path) are invoked', async () => {
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

  it('Given an absolute symlink target outside rootDir, When symlink is called, Then PERMISSION_DENIED is thrown and fsOps.symlink is NOT invoked', async () => {
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

  it('Given an absolute target with `..` that resolves OUTSIDE rootDir, When symlink runs, Then PERMISSION_DENIED is thrown', async () => {
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

  it('Given a relative symlink target (even one containing ..), When symlink is called, Then fsOps.symlink is invoked unchanged', async () => {
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

  it('Given a wrapped FileHandle, When close is called twice, Then the underlying close runs exactly once (closed-flag idempotency)', async () => {
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

  it('Given a wrapped FileHandle, When stat is called, Then the underlying call uses { bigint: true } and the ns fields survive', async () => {
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

describe('NodeFileSystem — TsgitError rethrow defence (DI)', () => {
  it('Given realpath synthesises a TsgitError, When exists is called, Then exists rethrows it unchanged (no re-wrap via mapErrno)', async () => {
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

  it('Given realpath synthesises a TsgitError, When read is called, Then checkContainment rethrows it unchanged', async () => {
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

  it('Given rmRecursive on a single regular file, When the leaf is removed, Then `fs.rm` is called with `{ force: true }` (TOCTOU mid-walk tolerance)', async () => {
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

  it('Given rmRecursive existence probe, When the leaf is verified, Then the inner lstat does NOT re-enter checkContainment (no third realpath(rootDir) call)', async () => {
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
    const rootCalls = realpathSpy.mock.calls.filter(([arg]: readonly unknown[]) => arg === rootDir);
    expect(rootCalls.length).toBe(2);
  });
});

describe('mapConcurrent — empty-input short-circuit (DI)', () => {
  it('Given an empty input and a negative limit, When mapped, Then it resolves without throwing (short-circuit fires before Math.min/Array.from)', async () => {
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

describe('realpathNearestExisting — root extraction and walk (DI)', () => {
  it('Given a leaf that does not exist, When resolving, Then it walks up to the nearest existing ancestor (rootOf must yield the prefix, not the whole path)', async () => {
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

  it('Given a path with a doubled separator, When resolving, Then empty segments are filtered out (no spurious double-separator candidate)', async () => {
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

  it('Given every segment and the root all ENOENT, When resolving, Then realpath(root) is invoked exactly once (loop bound must stop at i > 0)', async () => {
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

  it('Given a deep realpath rejecting with a non-ENOENT errno while an ancestor resolves, When resolving, Then the errno propagates (catch must not swallow it)', async () => {
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

  it('Given a deep realpath rejecting with a non-errno value while an ancestor resolves, When resolving, Then the value propagates (guard must require ENOENT, not just any errno)', async () => {
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

describe('NodeFileSystem.openWithNoFollow — handle.read position (DI)', () => {
  it('Given a wrapped FileHandle, When read is called with an explicit non-zero position, Then the underlying read receives that position (not coerced to null)', async () => {
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

  it('Given a wrapped FileHandle, When read is called without a position, Then the underlying read receives null (?? default)', async () => {
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

describe('NodeFileSystem.readSlice — handle close on success (DI)', () => {
  it('Given a successful readSlice, When it returns, Then the underlying FileHandle is closed (finally block is load-bearing)', async () => {
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

describe('NodeFileSystem.symlink — absolute-target containment OR (DI)', () => {
  it('Given an absolute target inside the canonical root but outside the raw root, When symlink runs, Then it succeeds (raw operand alone must not refuse)', async () => {
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

  it('Given an absolute target inside the raw root but outside the canonical root, When symlink runs, Then it succeeds (canonical operand alone must not refuse)', async () => {
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

describe('NodeFileSystem.openWithNoFollow — UNSUPPORTED_OPERATION rewrap (DI)', () => {
  it('Given a Windows regular file whose open rejects with an unknown errno, When openWithNoFollow runs, Then the discriminator rewraps UNSUPPORTED_OPERATION to PERMISSION_DENIED', async () => {
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

describe('NodeFileSystem.realpathForCreation — non-ENOENT parent error (DI)', () => {
  it('Given the direct parent realpath rejects ENOTDIR while the leaf realpath resolves, When write runs, Then NOT_A_DIRECTORY is thrown (non-ENOENT must not trigger the walk-up)', async () => {
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
