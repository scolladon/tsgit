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

    // Assert — the LRU never recorded the missing parent. A subsequent
    // write into the same (now created) tree would still call realpath
    // because the cache was not populated.
    realpathHits = 0;
    await sut.write('/root/new-dir/leaf.bin', new Uint8Array([2]));
    expect(realpathHits).toBeGreaterThan(0);
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

    // Assert — after rmRecursive cleared the cache, the second write re-realpaths the parent.
    const afterCount = realpathSpy.mock.calls.filter(
      ([arg]: readonly unknown[]) => arg === '/root/sub',
    ).length;
    expect(beforeRmCount).toBe(1);
    expect(afterCount).toBeGreaterThan(beforeRmCount);
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
    // call sites fired (canonical-root + walk-up); writeFile + mkdir
    // observed so the path actually reached the fs.
    expect(caught).toBeUndefined();
    expect(realpathHits).toBeGreaterThanOrEqual(2);
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
