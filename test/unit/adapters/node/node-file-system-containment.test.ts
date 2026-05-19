/**
 * Windows-mocked containment + canonical-root cache tests for
 * `NodeFileSystem`. Isolated in its own file because `vi.mock` intercepts
 * `node:fs/promises` for every test in this module — the main
 * `node-file-system.test.ts` needs the real module for the cross-adapter
 * contract suite. Phase 14.4.
 *
 * Tests use POSIX-shaped paths even when simulating Windows behaviour:
 * Node's `path.resolve` is host-dependent, and POSIX hosts mangle backslash
 * inputs. The semantics we prove (case-folded containment, canonical-root
 * substitution, prefix-only guard) are platform-independent — only the
 * `isWindowsFn` injection differs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  realpath: vi.fn<(path: string) => Promise<string>>(),
  open: vi.fn<(path: string, flags: number) => Promise<unknown>>(),
  lstat: vi.fn<(path: string) => Promise<{ isSymbolicLink: () => boolean }>>(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, realpath: mocks.realpath, open: mocks.open, lstat: mocks.lstat };
});

const { NodeFileSystem } = await import('../../../../src/adapters/node/node-file-system.js');
const { TsgitError } = await import('../../../../src/domain/index.js');

const enoent = (msg = 'not found'): NodeJS.ErrnoException =>
  Object.assign(new Error(msg), { code: 'ENOENT' });

beforeEach(() => {
  // Reset call counts AND implementations so per-test mock setup is fully
  // isolated — `mock.calls` accumulates otherwise, producing false positives
  // in the cache-call-count assertions.
  mocks.realpath.mockReset();
  mocks.open.mockReset();
  mocks.lstat.mockReset();
});

describe('NodeFileSystem — canonical-root cache', () => {
  it('Given two sequential `exists` calls, When the second runs, Then realpath(rootDir) is invoked at most once for the root', async () => {
    // Arrange
    const rootDir = '/canonical/root';
    mocks.realpath.mockImplementation(async (input: string) => {
      if (input === rootDir) return rootDir;
      throw enoent();
    });
    const sut = new NodeFileSystem(rootDir);

    // Act
    await sut.exists('/canonical/root/a');
    await sut.exists('/canonical/root/b');

    // Assert — rootDir canonicalisation runs exactly once.
    const rootCalls = mocks.realpath.mock.calls.filter(
      ([arg]: readonly unknown[]) => arg === rootDir,
    );
    expect(rootCalls.length).toBe(1);
  });

  it('Given concurrent `exists` calls, When they fire, Then realpath(rootDir) is invoked at most once (promise dedupe)', async () => {
    // Arrange
    const rootDir = '/canonical/concurrent';
    mocks.realpath.mockImplementation(async (input: string) => {
      if (input === rootDir) return rootDir;
      throw enoent();
    });
    const sut = new NodeFileSystem(rootDir);

    // Act
    await Promise.all([
      sut.exists('/canonical/concurrent/a'),
      sut.exists('/canonical/concurrent/b'),
      sut.exists('/canonical/concurrent/c'),
    ]);

    // Assert
    const rootCalls = mocks.realpath.mock.calls.filter(
      ([arg]: readonly unknown[]) => arg === rootDir,
    );
    expect(rootCalls.length).toBe(1);
  });

  it('Given the first realpath(rootDir) rejects, When `exists` is called again, Then realpath is retried (cache reset on rejection)', async () => {
    // Arrange — first call to realpath(rootDir) rejects, second resolves.
    const rootDir = '/canonical/missing';
    let callCount = 0;
    mocks.realpath.mockImplementation(async (input: string) => {
      if (input === rootDir) {
        callCount += 1;
        if (callCount === 1) throw enoent();
        return rootDir;
      }
      throw enoent();
    });
    const sut = new NodeFileSystem(rootDir);

    // Act
    await sut.exists('/canonical/missing/a').catch(() => undefined);
    await sut.exists('/canonical/missing/b').catch(() => undefined);

    // Assert — rootDir canonicalisation retried after the first rejection.
    const rootCalls = mocks.realpath.mock.calls.filter(
      ([arg]: readonly unknown[]) => arg === rootDir,
    );
    expect(rootCalls.length).toBe(2);
  });
});

describe('NodeFileSystem — openWithNoFollow windows symlink refusal', () => {
  const eacces = (): NodeJS.ErrnoException =>
    Object.assign(new Error('access'), { code: 'EACCES' });

  it('Given Windows host, symlink leaf, When open rejects with EACCES, Then openWithNoFollow throws PERMISSION_DENIED', async () => {
    // Arrange
    const root = '/canonical/win-symlink';
    const link = '/canonical/win-symlink/link';
    mocks.realpath.mockImplementation(async (input: string) => input);
    mocks.lstat.mockImplementation(async () => ({ isSymbolicLink: () => true }));
    mocks.open.mockImplementation(async () => {
      throw eacces();
    });
    const sut = new NodeFileSystem(root, () => true);

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

  it('Given Windows host, regular file (no symlink), When open rejects with EACCES, Then PERMISSION_DENIED is still thrown but from mapErrno (not the rewrap)', async () => {
    // Arrange — a real EACCES on a regular file should still surface as
    // PERMISSION_DENIED via mapErrno's EACCES arm. The discriminator must NOT
    // absorb this case (it's tested here just to confirm the contract).
    const root = '/canonical/win-regular';
    const file = '/canonical/win-regular/locked';
    mocks.realpath.mockImplementation(async (input: string) => input);
    mocks.lstat.mockImplementation(async () => ({ isSymbolicLink: () => false }));
    mocks.open.mockImplementation(async () => {
      throw eacces();
    });
    const sut = new NodeFileSystem(root, () => true);

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
    // false; the post-open error then surfaces as a regular permissionDenied
    // from mapErrno's EACCES arm (NOT absorbed by the windows discriminator).
    const root = '/canonical/win-lstat-race';
    const file = '/canonical/win-lstat-race/race';
    mocks.realpath.mockImplementation(async (input: string) => input);
    mocks.lstat.mockImplementation(async () => {
      throw enoent();
    });
    mocks.open.mockImplementation(async () => {
      throw eacces();
    });
    const sut = new NodeFileSystem(root, () => true);

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
    mocks.realpath.mockImplementation(async (input: string) => input);
    mocks.lstat.mockImplementation(async () => ({ isSymbolicLink: () => true }));
    mocks.open.mockImplementation(async () => {
      throw Object.assign(new Error('symlink loop'), { code: 'ELOOP' });
    });
    const sut = new NodeFileSystem(root, () => false);

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

describe('NodeFileSystem — non-errno fault propagation', () => {
  it('Given `exists` and a realpath that rejects with a non-errno value, When called, Then the original value rethrows unchanged', async () => {
    // Arrange — realpath rejects with a non-Error (e.g., a string) so
    // isErrnoException returns false. The defensive rethrow keeps the
    // semantic that only errno faults flow through mapErrno.
    const rootDir = '/canonical/non-errno-exists';
    mocks.realpath.mockImplementation(async (input: string) => {
      if (input === rootDir) return rootDir;
      throw 'not-an-error'; // eslint-disable-line @typescript-eslint/no-throw-literal
    });
    const sut = new NodeFileSystem(rootDir);

    // Act + Assert
    let caught: unknown;
    try {
      await sut.exists('/canonical/non-errno-exists/a');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe('not-an-error');
  });

  it('Given `read` and a realpath that rejects with a non-errno value, When called, Then the original value rethrows unchanged', async () => {
    // Arrange — same as above but via checkContainment.
    const rootDir = '/canonical/non-errno-read';
    mocks.realpath.mockImplementation(async (input: string) => {
      if (input === rootDir) return rootDir;
      throw 'not-an-error'; // eslint-disable-line @typescript-eslint/no-throw-literal
    });
    const sut = new NodeFileSystem(rootDir);

    // Act + Assert
    let caught: unknown;
    try {
      await sut.read('/canonical/non-errno-read/a');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe('not-an-error');
  });

  it('Given `openWithNoFollow` on a Windows symlink leaf, When lstat rejects with a non-ENOENT errno (EACCES), Then the error rethrows (not silently swallowed)', async () => {
    // Arrange — lstat rejection with EACCES surfaces; only ENOENT is
    // safe to absorb (TOCTOU race), per ADR-043 review.
    const root = '/canonical/win-lstat-eaccess';
    const file = '/canonical/win-lstat-eaccess/leaf';
    mocks.realpath.mockImplementation(async (input: string) => input);
    mocks.lstat.mockImplementation(async () => {
      throw Object.assign(new Error('access'), { code: 'EACCES' });
    });
    mocks.open.mockImplementation(async () => ({ close: async () => undefined }));
    const sut = new NodeFileSystem(root, () => true);

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

describe('NodeFileSystem — windows-mocked containment', () => {
  it('Given canonical-root realpath returns a long-name form, When `exists` runs against a short-name child, Then `exists` returns true (8.3 reconciliation)', async () => {
    // Arrange — POSIX-shaped paths to keep the host's `path.resolve` sane;
    // the case-fold/canonical-substitution semantic is what we're proving.
    const shortRoot = '/Users/RUNNER~1/Temp/tsgit';
    const longRoot = '/Users/runneradmin/Temp/tsgit';
    const child = '/Users/RUNNER~1/Temp/tsgit/file.bin';
    const childCanonical = '/Users/runneradmin/Temp/tsgit/file.bin';

    mocks.realpath.mockImplementation(async (input: string) => {
      if (input === shortRoot) return longRoot;
      if (input === child) return childCanonical;
      throw enoent();
    });

    const sut = new NodeFileSystem(shortRoot, () => true);

    // Act
    const result = await sut.exists(child);

    // Assert
    expect(result).toBe(true);
  });

  it('Given Windows host, When `exists` is called with a sibling outside the canonical root, Then PERMISSION_DENIED is thrown', async () => {
    // Arrange
    const shortRoot = '/Users/RUNNER~1/Temp/tsgit';
    const longRoot = '/Users/runneradmin/Temp/tsgit';
    const sibling = '/Users/RUNNER~1/Temp/tsgit-evil/loot';
    const siblingCanonical = '/Users/runneradmin/Temp/tsgit-evil/loot';

    mocks.realpath.mockImplementation(async (input: string) => {
      if (input === shortRoot) return longRoot;
      if (input === sibling) return siblingCanonical;
      throw enoent();
    });

    const sut = new NodeFileSystem(shortRoot, () => true);

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
    const root = '/Users/Foo/tsgit';
    const child = '/users/foo/tsgit/sub/file.bin';

    mocks.realpath.mockImplementation(async (input: string) => input);

    const sut = new NodeFileSystem(root, () => true);

    // Act
    const result = await sut.exists(child);

    // Assert
    expect(result).toBe(true);
  });

  it('Given POSIX host (isWindowsFn=false), When the child path differs only in case, Then PERMISSION_DENIED is thrown (case-sensitive)', async () => {
    // Arrange
    const root = '/Users/Foo/tsgit';
    const child = '/users/foo/tsgit/sub/file.bin';

    mocks.realpath.mockImplementation(async (input: string) => input);

    const sut = new NodeFileSystem(root, () => false);

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
