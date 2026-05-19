/**
 * Dependency-injection tests for `NodeFileSystem`. Phase 14.4.
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
    // safe to absorb (TOCTOU race), per ADR-043 review.
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
  it('Given realpath flips between short and long forms across calls, When write goes through creation containment, Then it does NOT throw PERMISSION_DENIED', async () => {
    // Arrange — simulates the GHA Windows runner: realpath of the rootDir
    // returns the long-name form, but the walk-up inside
    // realpathNearestExisting may receive a different form. Containment
    // must canonicalise both sides.
    const shortRoot = 'C:\\Users\\RUNNER~1\\Temp\\tsgit-AbCd';
    const longRoot = 'C:\\Users\\runneradmin\\Temp\\tsgit-AbCd';
    const childShort = 'C:\\Users\\RUNNER~1\\Temp\\tsgit-AbCd\\a.bin';

    const fsOps = fakeFsOps({
      realpath: vi.fn().mockImplementation(async (input: string) => {
        if (input === shortRoot) return longRoot;
        if (input === 'C:\\Users\\RUNNER~1\\Temp\\tsgit-AbCd') return shortRoot;
        throw enoent();
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

    // Assert — must NOT be PERMISSION_DENIED.
    if (caught instanceof TsgitError) {
      expect(caught.data.code).not.toBe('PERMISSION_DENIED');
    }
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
