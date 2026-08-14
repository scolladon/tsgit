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
import * as fs from 'node:fs';
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

describe('NodeFileSystem — realpathForCreation parent-realpath LRU (DI)', () => {
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

  describe('Given an exists probe on a non-existent path that escapes rootDir', () => {
    describe('When exists fires and realpath rejects the escaping path with ENOENT', () => {
      it('Then the ENOENT arm refuses with PERMISSION_DENIED instead of returning false', async () => {
        // Arrange — realpath resolves the root but rejects the escaping probe
        // with ENOENT, so exists() enters its ENOENT arm with a `resolved`
        // that lands outside BOTH the raw and canonical roots. A mutant that
        // drops either containment arm (or empties the refusal block) would
        // let the probe fall through to `return false`.
        const rootDir = '/root';
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return rootDir;
          throw enoent();
        });
        const fsOps = fakeFsOps({ realpath });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        let returned: boolean | undefined;
        try {
          returned = await sut.exists('/root/sub/../../escape/ghost.bin');
        } catch (err) {
          caught = err;
        }

        // Assert — the escape is refused, never silently reported absent
        expect(returned).toBeUndefined();
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
        //   0 from rmRecursive's write guard — the parent realpath cache is
        //     SHARED across every write surface, so this lookup HITS the
        //     entry the first write set
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

  describe('Given a not-yet-existing root beneath a symlinked ancestor', () => {
    describe('When a file is created under that root', () => {
      it('Then the canonical prefix derives from the nearest existing ancestor and the write is admitted', async () => {
        // Arrange — the `worktree add` shape on macOS: the target root
        // `C:\canonical\missing` does not exist yet and its parent
        // `C:\canonical` is a symlink to `C:\real`. Dropping the missing
        // root's canonical prefix would deny the realpathed leaf
        // (`C:\real\missing\f`); deriving it via the nearest existing
        // ancestor admits it.
        const rootDir = 'C:\\canonical\\missing';
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === 'C:\\canonical') return 'C:\\real';
          throw enoent();
        });
        const fsOps = fakeFsOps({ realpath });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.writeUtf8('C:\\canonical\\missing\\f', 'x');

        // Assert
        expect(fsOps.writeFile).toHaveBeenCalledTimes(1);
        const [writtenPath] = (fsOps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0] as [
          string,
        ];
        expect(writtenPath).toBe('C:\\real\\missing\\f');
      });
    });
  });

  describe('Given two sequential `lstat`-driving calls', () => {
    describe('When the second runs', () => {
      it('Then realpath(rootDir) is invoked exactly once (synchronous cached fast-path)', async () => {
        // Arrange — the first lstat resolves the canonical root and populates
        // the synchronous `resolvedRootSet` field; the second lstat must be
        // served from that field without re-awaiting `loadRootSet()`.
        const rootDir = '/root';
        const realpath = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath,
          lstat: vi.fn().mockResolvedValue({
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
          }),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act — `lstat` never realpaths its own leaf or parent (lexical,
        // syscall-free `resolveRead`); the only `realpath` this can ever
        // trigger is the one-time canonical-root resolution.
        await sut.lstat('/root/sub/a');
        await sut.lstat('/root/sub/b');

        // Assert
        const rootCalls = realpath.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === rootDir,
        );
        expect(rootCalls.length).toBe(1);
      });
    });
  });

  describe('Given the first canonical-root resolution rejects with a non-ENOENT errno', () => {
    describe('When a later `lstat`-driving call runs', () => {
      it('Then the error surfaces and the canonical root is retried', async () => {
        // Arrange — pins the `.catch` arm of `loadRootSet`: an errno that is
        // NOT ENOENT (a missing root is legitimately tolerated) must never be
        // swallowed, and must leave `resolvedRootSet` `undefined` so the
        // guard's `if` branch re-awaits `loadRootSet()` on the next call
        // instead of trusting a stale/never-set field.
        const rootDir = '/root';
        let callCount = 0;
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) {
            callCount += 1;
            if (callCount === 1) throw eacces();
            return rootDir;
          }
          return input;
        });
        const fsOps = fakeFsOps({
          realpath,
          lstat: vi.fn().mockResolvedValue({
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
          }),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act — `loadRootSet()`'s rejection propagates raw (it is awaited
        // BEFORE `resolveRead`'s containment check), so the first call
        // rejects with the underlying EACCES; the second succeeds once the
        // canonical root resolves.
        let firstCaught: unknown;
        try {
          await sut.lstat('/root/sub/a');
        } catch (err) {
          firstCaught = err;
        }
        let secondCaught: unknown;
        try {
          await sut.lstat('/root/sub/b');
        } catch (err) {
          secondCaught = err;
        }

        // Assert
        expect(firstCaught).toBeInstanceOf(Error);
        expect((firstCaught as NodeJS.ErrnoException).code).toBe('EACCES');
        expect(secondCaught).toBeUndefined();
        const rootCalls = realpath.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === rootDir,
        );
        expect(rootCalls.length).toBe(2);
      });
    });
  });
});

describe('NodeFileSystem — pre-resolved roots (DI)', () => {
  describe('Given a NodeFileSystem constructed with pre-resolved roots', () => {
    describe('When the first path-taking call resolves the root set', () => {
      it('Then fsOps.realpath is never called', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({ realpath: realpathSpy });
        const sut = new NodeFileSystem([rootDir], posixPolicy, fsOps, [rootDir]);

        // Act
        await sut.exists(`${rootDir}/file.txt`);

        // Assert
        expect(realpathSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a NodeFileSystem constructed WITHOUT pre-resolved roots', () => {
    describe('When the first path-taking call resolves the root set', () => {
      it('Then fsOps.realpath is called exactly once per root', async () => {
        // Arrange
        const rootA = '/root-a';
        const rootB = '/root-b';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({ realpath: realpathSpy });
        const sut = new NodeFileSystem([rootA, rootB], posixPolicy, fsOps);

        // Act
        await sut.exists(`${rootA}/file.txt`);

        // Assert
        expect(realpathSpy).toHaveBeenCalledTimes(2);
        expect(realpathSpy).toHaveBeenCalledWith(rootA);
        expect(realpathSpy).toHaveBeenCalledWith(rootB);
      });
    });
  });

  describe('Given pre-resolved roots whose length does not match the raw roots', () => {
    describe('When the adapter is constructed', () => {
      it('Then it refuses with UNSUPPORTED_OPERATION', () => {
        // Arrange
        const build = (): NodeFileSystem =>
          new NodeFileSystem(['/root-a', '/root-b'], posixPolicy, fakeFsOps(), ['/root-a']);

        // Act
        let caught: unknown;
        try {
          build();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'UNSUPPORTED_OPERATION',
          operation: 'constructor',
          reason: 'resolvedRoots must have the same length as rootDir',
        });
      });
    });
  });
});

describe('NodeFileSystem.resolveWrite — settled root-set fast path (DI)', () => {
  // `resolveWrite` reads `this.resolvedRootSet ?? (await this.loadRootSet())`
  // directly — the same idiom every read surface already used — instead of
  // going through a `private async resolveRootSet()` wrapper that allocated
  // a promise on every call even once the root set had settled. A raw call
  // count on `realpath(rootDir)` can't distinguish the two implementations
  // (both memoise the canonicalising `realpath` itself); what's pinned here
  // is the observable contract: the very first write still lazily resolves
  // the root set, every later write reuses it, and the loader underneath
  // runs exactly once regardless of how many writes follow.
  describe('Given a fresh adapter', () => {
    describe('When the first write fires', () => {
      it('Then it still resolves the root set and succeeds (lazy-load path)', async () => {
        // Arrange
        const rootDir = '/root';
        const writeFile = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          writeFile,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.write('/root/first.bin', new Uint8Array([1]));

        // Assert
        expect(writeFile).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given N writes from a fresh adapter', () => {
    describe('When they fire in sequence', () => {
      it('Then every write succeeds and the root-set loader (realpath(rootDir)) runs exactly once', async () => {
        // Arrange
        const rootDir = '/root';
        const writeFile = vi.fn().mockResolvedValue(undefined);
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({ realpath: realpathSpy, writeFile });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);
        const writeCount = 5;

        // Act — first write hits the lazy-load arm, the rest hit the
        // settled fast arm. Targets sit under `/root/sub` (not `/root`
        // itself) so the root-set canonicalisation's `realpath(rootDir)`
        // stays distinct from the separate parent-realpath cache's own
        // `realpath('/root/sub')` lookups.
        for (let i = 0; i < writeCount; i += 1) {
          await sut.write(`/root/sub/leaf-${i}.bin`, new Uint8Array([i]));
        }

        // Assert
        expect(writeFile).toHaveBeenCalledTimes(writeCount);
        const rootCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === rootDir,
        );
        expect(rootCalls.length).toBe(1);
      });
    });
  });
});

describe('NodeFileSystem — guarded canonical-root await, first-call resolution (DI)', () => {
  describe('Given a fresh adapter', () => {
    describe('When the first FS op is a read (resolveRead)', () => {
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
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          stat: vi.fn().mockResolvedValue({}),
        });
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

describe('NodeFileSystem — resolveRead dual-root OR disjuncts (DI)', () => {
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

        // Act
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

  describe('Given Windows host', () => {
    describe('When lstat itself throws (TOCTOU race)', () => {
      it('Then isSymlinkLeaf returns false and the open error surfaces unchanged', async () => {
        // Arrange — lstat rejects (file was deleted between `resolveWrite`
        // and `isSymlinkLeaf`). `isSymlinkLeaf` catches and returns false;
        // the post-open error then surfaces as PERMISSION_DENIED via
        // mapErrno's EACCES arm.
        const root = 'C:\\canonical\\win-lstat-race';
        const file = 'C:\\canonical\\win-lstat-race\\race';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockRejectedValue(enoent()),
          open: vi.fn().mockRejectedValue(eacces()),
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

        // Act
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

  describe(
    'Given a hypothetical mixed policy (caseInsensitive=true, windowsSyntax=false, ' +
      'honoursNoFollow=true)',
    () => {
      describe('When openWithNoFollow(read) is called and open rejects with a generic errno', () => {
        it('Then no proactive lstat runs and the mapped error is NOT rewrapped — both re-keyed sites take the POSIX arm', async () => {
          // Arrange — before the re-key, `caseInsensitive=true` alone
          // triggered both the proactive isSymlinkLeaf lstat and the
          // isWindowsSymlinkRefusal rewrap, even though this policy's
          // `open(2)` DOES honour O_NOFOLLOW. Re-keyed to `honoursNoFollow`,
          // this mixed policy must rely on the syscall flag alone, exactly
          // like posixPolicy. `EIO` maps to UNSUPPORTED_OPERATION (mapErrno's
          // default arm), so a rewrap would be observable as PERMISSION_DENIED.
          const eio = (): NodeJS.ErrnoException =>
            Object.assign(new Error('io error'), { code: 'EIO' });
          const root = '/canonical/mixed-policy';
          const file = '/canonical/mixed-policy/target';
          const lstat = vi.fn().mockResolvedValue({ isSymbolicLink: () => true });
          const fsOps = fakeFsOps({
            realpath: vi.fn().mockImplementation(async (input: string) => input),
            lstat,
            open: vi.fn().mockRejectedValue(eio()),
          });
          const mixedPolicy = { ...posixPolicy, caseInsensitive: true };
          const sut = new NodeFileSystem(root, mixedPolicy, fsOps);

          // Act
          let caught: unknown;
          try {
            await sut.openWithNoFollow(file, 'read');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(lstat).not.toHaveBeenCalled();
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as InstanceType<typeof TsgitError>).data.code).toBe(
            'UNSUPPORTED_OPERATION',
          );
        });
      });
    },
  );
});

describe('NodeFileSystem — non-errno fault propagation (DI)', () => {
  describe('Given `exists` and a stat that rejects with a non-errno value', () => {
    describe('When called', () => {
      it('Then the original value rethrows unchanged', async () => {
        // Arrange — `exists` now probes existence via `fsOps.stat`, not
        // `fsOps.realpath` (which only runs once, for root canonicalisation).
        // stat rejects with a non-Error (string) so isErrnoException returns
        // false. The defensive rethrow keeps the semantic that only errno
        // faults flow through mapErrno.
        const rootDir = 'C:\\canonical\\non-errno-exists';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          stat: vi.fn().mockRejectedValue('not-an-error'),
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
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

  describe('Given `chmod` and a parent realpath that rejects with a non-errno value', () => {
    describe('When called', () => {
      it('Then the original value rethrows unchanged', async () => {
        // Arrange — same idea but through the write guard's (`resolveWrite`)
        // catch. `chmod` always resolves through it, on every platform.
        const rootDir = 'C:\\canonical\\non-errno-read';
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return rootDir;
          throw 'not-an-error';
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fakeFsOps({ realpath }));

        // Act
        let caught: unknown;
        try {
          await sut.chmod('C:\\canonical\\non-errno-read\\sub\\a', 0o644);
        } catch (err) {
          caught = err;
        }
        // Assert
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

        // Act
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
        // `read` so `resolveRead`'s lexical containment check fires (a write
        // surface would surface FILE_NOT_FOUND first because the walk-up
        // segments don't exist in the mock — equally valid security
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
        // `resolveRead`'s containment check, this would surface a different
        // error (or none).
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
          stat: vi.fn().mockResolvedValue({}),
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

        // Act
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
          stat: vi.fn().mockResolvedValue({}),
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

        // Act
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

describe('NodeFileSystem.exists — non-ENOENT errno from stat (DI)', () => {
  describe('Given stat rejects with ENOTDIR', () => {
    describe('When exists is called', () => {
      it('Then throws NOT_A_DIRECTORY', async () => {
        // Arrange — `exists` probes existence via `fsOps.stat`, not
        // `fsOps.realpath` (which now runs only once, for root
        // canonicalisation).
        const rootDir = '/root';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          stat: vi.fn().mockRejectedValue(enotdir()),
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

  describe('Given an in-root path whose target lies outside the canonical root', () => {
    describe('When exists is called', () => {
      it('Then it returns true (read-side containment is lexical, git parity)', async () => {
        // Arrange — simulates an in-root symlink whose target lies outside
        // every root. `exists` no longer realpaths the leaf to detect the
        // escape, so it is followed exactly like `read`/`stat`.
        const rootDir = '/root';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          stat: vi.fn().mockResolvedValue({}),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const result = await sut.exists('/root/escape-link');

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});

describe('NodeFileSystem.resolveWrite — non-ENOENT errno from realpath (DI)', () => {
  describe('Given `chmod` with a parent realpath rejecting ENOTDIR', () => {
    describe('When called', () => {
      it('Then throws NOT_A_DIRECTORY (mapErrno branch in resolveWrite`s catch)', async () => {
        // Arrange — `chmod` always resolves through the write guard
        // (`resolveWrite`), on every platform.
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
          await sut.chmod('/root/block/child.txt', 0o644);
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

describe('resolveRead — lstat() lexical pre-check (DI)', () => {
  describe('Given lstat called against an absolute out-of-tree path', () => {
    describe('When resolveRead runs', () => {
      it('Then PERMISSION_DENIED fires BEFORE realpath(dirname)', async () => {
        // Arrange — `lstat()` never realpaths its parent at all: the lexical
        // containment check (`resolveRead`) is synchronous and syscall-free,
        // so it throws permissionDenied before any I/O on the leaf's parent
        // could even be reached. That absence is documented, not pinned by
        // a call-count assertion below: `resolveRead` has no code path that
        // ever calls `realpath('/elsewhere')`, so such an assertion could
        // never fail and would not be a regression signal.
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

        // Assert — PERMISSION_DENIED is the load-bearing observable here.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });
});

describe('NodeFileSystem — write guard parent-realpath LRU (DI)', () => {
  // Vehicle: `rm` — the parent-realpath cache this suite pins
  // (`cachedParentRealpath`) is shared by every write surface through the
  // single write guard (`resolveWrite`); `rm` exercises it with the least
  // incidental setup.

  describe('Given two rm calls on same-directory siblings', () => {
    describe('When the second fires', () => {
      it('Then realpath(dirname) is invoked exactly once', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({ realpath: realpathSpy });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.rm('/root/sub/a');
        await sut.rm('/root/sub/b');

        // Assert
        const parentCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/sub',
        );
        expect(parentCalls.length).toBe(1);
      });
    });
  });

  describe('Given rm calls in different directories', () => {
    describe('When both fire', () => {
      it('Then realpath is invoked once per distinct dirname', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({ realpath: realpathSpy });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.rm('/root/x/a');
        await sut.rm('/root/y/a');

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

  describe('Given an rm call populates the cache', () => {
    describe('When rmRecursive then a same-dir rm fires', () => {
      it('Then realpath(dirname) is invoked twice total', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          lstat: vi
            .fn()
            .mockResolvedValue({ isDirectory: () => false, isSymbolicLink: () => false }),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.rm('/root/sub/a');
        await sut.rmRecursive('/root/sub/a');
        await sut.rm('/root/sub/b');

        // Assert
        const parentCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/sub',
        );
        expect(parentCalls.length).toBe(2);
      });
    });

    describe('When rename then a same-dir rm fires', () => {
      it('Then realpath(dirname) is invoked twice total', async () => {
        // Arrange
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({ realpath: realpathSpy });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.rm('/root/sub/a');
        await sut.rename('/root/sub/a', '/root/sub/renamed');
        await sut.rm('/root/sub/b');

        // Assert
        const parentCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/sub',
        );
        expect(parentCalls.length).toBe(2);
      });
    });
  });

  describe('Given an rm call whose parent is ENOENT', () => {
    describe('When it fires', () => {
      it('Then nothing is cached, a later same-parent rm re-attempts, and both surface the leaf`s own FILE_NOT_FOUND', async () => {
        // Arrange — a missing parent is NOT cached and falls back to the
        // slow walk-up (`realpathNearestExisting`), same as every other
        // write surface: the containment check itself succeeds (the
        // nearest-existing ancestor is `rootDir`), and the missing leaf
        // surfaces its own FILE_NOT_FOUND from the real `fs.rm` call.
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return rootDir;
          throw enoent();
        });
        const fsOps = fakeFsOps({
          realpath: realpathSpy,
          rm: vi.fn().mockRejectedValue(enoent()),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let firstCaught: unknown;
        try {
          await sut.rm('/root/missing/a');
        } catch (err) {
          firstCaught = err;
        }
        let secondCaught: unknown;
        try {
          await sut.rm('/root/missing/b');
        } catch (err) {
          secondCaught = err;
        }

        // Assert
        expect(firstCaught).toBeInstanceOf(TsgitError);
        expect((firstCaught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
        expect(secondCaught).toBeInstanceOf(TsgitError);
        expect((secondCaught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
        // Nothing was cached: each rm re-attempts `cachedParentRealpath`
        // (1 call) then re-walks via `realpathNearestExisting` (which
        // re-probes the same missing parent once more) — 2 calls per rm,
        // 4 total across both. A mutant that quietly cached the ENOENT
        // result would surface as a lower count here.
        const parentCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/missing',
        );
        expect(parentCalls.length).toBe(4);
      });
    });
  });

  describe('Given N loose-object rm calls sharing one fanout dir (object-resolver probe shape)', () => {
    describe('When each loose probe fires an rm', () => {
      it('Then realpath(fanout dir) is invoked at most once per distinct fanout dir', async () => {
        // Arrange — 5 loose-object paths under the same fanout dir, mirroring
        // the object-resolver's `looseObjectPath` layout (objects/xx/<38 hex>).
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({ realpath: realpathSpy });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);
        const fanoutDir = '/root/objects/ab';

        // Act
        for (let i = 0; i < 5; i += 1) {
          await sut.rm(`${fanoutDir}/leaf${i}`);
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
        const fsOps = fakeFsOps({ realpath: realpathSpy });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);
        const fanoutDir = (n: number): string => `/root/objects/${n.toString(16).padStart(2, '0')}`;

        // Act — touch 300 distinct fanout dirs, then re-touch dir #1.
        for (let i = 0; i < 300; i += 1) {
          await sut.rm(`${fanoutDir(i)}/leaf`);
        }
        await sut.rm(`${fanoutDir(1)}/leaf-again`);

        // Assert — dir #1's realpath was invoked exactly once across the whole run.
        const dir1Calls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === fanoutDir(1),
        );
        expect(dir1Calls.length).toBe(1);
      });
    });
  });
});

describe('NodeFileSystem.rename — parent-realpath cache invalidation soundness (DI)', () => {
  // `rename` clears the whole `parentRealpathCache` rather than narrowing to
  // `dirname(src)`/`dirname(dst)`: `src` can itself be a directory
  // (`worktree move`, `git mv` on a directory), so a cached entry keyed AT
  // `src`/`dst` or nested under either would go stale if only the two
  // dirnames were evicted. These tests pin that soundness call, not just
  // the raw "does `rename` invalidate something" behaviour already covered
  // by the parent-realpath LRU suite above.

  describe('Given cached parent-realpath entries for both rename endpoints` own directories', () => {
    describe('When rename fires', () => {
      it('Then both dirname(src) and dirname(dst) are evicted (re-realpathed on the next write)', async () => {
        // Arrange — seed the cache for `/root/a` (dirname(src)) and
        // `/root/b` (dirname(dst)) via an unrelated sibling write in each.
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({ realpath: realpathSpy });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);
        await sut.rm('/root/a/sibling');
        await sut.rm('/root/b/sibling');
        realpathSpy.mockClear();

        // Act
        await sut.rename('/root/a/x', '/root/b/y');
        await sut.rm('/root/a/another');
        await sut.rm('/root/b/another');

        // Assert — both dirs are re-realpathed after the rename: the cache
        // no longer serves the pre-rename entries.
        const aCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/a',
        );
        const bCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/b',
        );
        expect(aCalls.length).toBeGreaterThanOrEqual(1);
        expect(bCalls.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('Given a cached parent-realpath entry NESTED under the rename source (a subtree move)', () => {
    describe('When rename fires', () => {
      it('Then the nested entry is also evicted, not left stale', async () => {
        // Arrange — `/root/olddir` is the rename source itself (e.g. a
        // `worktree move`); `/root/olddir/nested` was cached as a parent by
        // an earlier write two levels below the source. A `dirname(src)`
        // /`dirname(dst)`-only invalidation would miss this key entirely
        // (`dirname('/root/olddir/x') !== '/root/olddir'`), leaving it
        // stale after the whole subtree moved.
        const rootDir = '/root';
        const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({ realpath: realpathSpy });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);
        await sut.rm('/root/olddir/nested/leaf');
        realpathSpy.mockClear();

        // Act
        await sut.rename('/root/olddir', '/root/newdir');
        await sut.rm('/root/olddir/nested/leaf-again');

        // Assert — the nested entry is re-realpathed, proving it was
        // invalidated by the rename rather than served stale from cache.
        const nestedCalls = realpathSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === '/root/olddir/nested',
        );
        expect(nestedCalls.length).toBeGreaterThanOrEqual(1);
      });
    });
  });
});

describe('NodeFileSystem — write guard per-call containment post-check (DI)', () => {
  // Vehicle: `rm` — the write guard (`resolveWrite`) runs its containment
  // post-check unconditionally on every call, on the joined
  // `realParent`/basename leaf; no verdict is ever cached across calls, so a
  // parent whose realpath later escapes the root is always caught fresh,
  // never served stale.

  describe.each([
    {
      label: 'posix',
      policy: posixPolicy,
      rootDir: '/root',
      sibling: (n: string) => `/root/sub/${n}`,
    },
    {
      label: 'windows',
      policy: windowsPolicy,
      rootDir: 'C:\\Root',
      sibling: (n: string) => `C:\\Root\\sub\\${n}`,
    },
  ])('Given two rm calls under the same parent ($label)', ({ policy, rootDir, sibling }) => {
    describe('When the second fires', () => {
      it('Then the second rm normalises the leaf exactly once (one unconditional post-check, no pre-check)', async () => {
        // Arrange — spy on normalizeForCompare to count containment-check
        // work. `resolveWrite` has no separate pre-check: the ONLY normalise
        // call per rm is the post-check on the joined `real` path.
        const leafB = sibling('b');
        const normalizeSpy = vi.fn((p: string) => policy.normalizeForCompare(p));
        const spyPolicy = { ...policy, normalizeForCompare: normalizeSpy };
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
        });
        const sut = new NodeFileSystem(rootDir, spyPolicy, fsOps);

        // Act
        await sut.rm(sibling('a'));
        normalizeSpy.mockClear();
        await sut.rm(leafB);

        // Assert
        const leafNormaliseCalls = normalizeSpy.mock.calls.filter(
          ([arg]: readonly unknown[]) => arg === leafB,
        );
        expect(leafNormaliseCalls.length).toBe(1);
      });
    });
  });

  describe.each([
    { label: 'posix', policy: posixPolicy, rootDir: '/root', parent: '/root/sub' },
    { label: 'windows', policy: windowsPolicy, rootDir: 'C:\\Root', parent: 'C:\\Root\\sub' },
  ])('Given an rm populated the parent-realpath cache ($label)', ({ policy, rootDir, parent }) => {
    describe('When rename then a same-parent rm fires', () => {
      it('Then the parent realpath is re-resolved (stale-serve would give the WRONG answer)', async () => {
        // Arrange — realpath(parent) starts contained, then AFTER rename
        // resolves to an escaping path. A stale-served cache entry would
        // still resolve to the contained parent; the correct, invalidated
        // behaviour re-resolves and throws.
        const outside = policy.sep === '/' ? '/outside' : 'C:\\Outside';
        let escaped = false;
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === rootDir) return rootDir;
            if (input === parent) return escaped ? outside : parent;
            return input;
          }),
        });
        const sut = new NodeFileSystem(rootDir, policy, fsOps);
        const a = policy.join(parent, 'a');
        const renamedDst = policy.join(parent, 'renamed');
        const b = policy.join(parent, 'b');

        // Act
        await sut.rm(a);
        escaped = true;
        await sut.rename(a, renamedDst);
        let caught: unknown;
        try {
          await sut.rm(b);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });

    describe('When rmRecursive then a same-parent rm fires', () => {
      it('Then the parent realpath is re-resolved (stale-serve would give the WRONG answer)', async () => {
        // Arrange — same shape as rename, but invalidation goes through
        // rmRecursive's `.clear()`.
        const outside = policy.sep === '/' ? '/outside' : 'C:\\Outside';
        let escaped = false;
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === rootDir) return rootDir;
            if (input === parent) return escaped ? outside : parent;
            return input;
          }),
          lstat: vi
            .fn()
            .mockResolvedValue({ isDirectory: () => false, isSymbolicLink: () => false }),
        });
        const sut = new NodeFileSystem(rootDir, policy, fsOps);
        const a = policy.join(parent, 'a');
        const b = policy.join(parent, 'b');

        // Act
        await sut.rm(a);
        escaped = true;
        await sut.rmRecursive(a);
        let caught: unknown;
        try {
          await sut.rm(b);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });

    describe('When rm (leaf) then a same-parent rm fires', () => {
      it('Then the parent realpath is NOT re-resolved (rm invalidates neither cache)', async () => {
        // Arrange — realpath(parent) would escape if re-resolved, but `rm`
        // must not trigger a re-resolution: the cached (contained) parent
        // realpath is still served and the second rm succeeds.
        const outside = policy.sep === '/' ? '/outside' : 'C:\\Outside';
        let afterRm = false;
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => {
            if (input === rootDir) return rootDir;
            if (input === parent) return afterRm ? outside : parent;
            return input;
          }),
        });
        const sut = new NodeFileSystem(rootDir, policy, fsOps);
        const a = policy.join(parent, 'a');
        const b = policy.join(parent, 'b');

        // Act
        await sut.rm(a);
        afterRm = true;
        await sut.rm(a);
        let caught: unknown;
        try {
          await sut.rm(b);
        } catch (err) {
          caught = err;
        }

        // Assert — no throw: rm did not invalidate the (still-valid,
        // cached-contained) parent realpath, so the second rm is served
        // from cache rather than re-resolving to the now-escaping realpath.
        expect(caught).toBeUndefined();
      });
    });
  });

  describe.each([
    { label: 'posix', policy: posixPolicy, rootDir: '/root', leaf: '/root/leaf.bin' },
    { label: 'windows', policy: windowsPolicy, rootDir: 'C:\\Root', leaf: 'C:\\Root\\leaf.bin' },
  ])(
    'Given a read whose leaf lexically stays inside the root ($label)',
    ({ policy, rootDir, leaf }) => {
      describe('When read fires twice', () => {
        it('Then EACH succeeds without realpathing the leaf (read-side containment is lexical, git parity)', async () => {
          // Arrange — the read arm no longer realpaths the leaf at all: only
          // the one-time root canonicalisation calls `realpath`. A mocked
          // escape via the leaf's OWN realpath (as the old 'read' mode's
          // post-check consulted) therefore has no bearing on the outcome.
          // This is documented here, not pinned by a call-count assertion:
          // `resolveRead` has no code path that ever calls `realpath(leaf)`,
          // so such an assertion could never fail and would not be a
          // regression signal — the two successful reads below are the
          // load-bearing observable.
          const realpathSpy = vi.fn().mockImplementation(async (input: string) => input);
          const fsOps = fakeFsOps({
            realpath: realpathSpy,
            readFile: vi.fn().mockResolvedValue(Buffer.from('x')),
          });
          const sut = new NodeFileSystem(rootDir, policy, fsOps);

          // Act
          const first = await sut.read(leaf);
          const second = await sut.read(leaf);

          // Assert
          expect(first).toEqual(new Uint8Array(Buffer.from('x')));
          expect(second).toEqual(new Uint8Array(Buffer.from('x')));
        });
      });
    },
  );

  describe.each([
    {
      label: 'posix',
      policy: posixPolicy,
      rootDir: '/root',
      parent: '/root/newdir',
      leaf: '/root/newdir/leaf.bin',
      outside: '/outside',
    },
    {
      label: 'windows',
      policy: windowsPolicy,
      rootDir: 'C:\\Root',
      parent: 'C:\\Root\\newdir',
      leaf: 'C:\\Root\\newdir\\leaf.bin',
      outside: 'C:\\Outside',
    },
  ])(
    'Given a creation target whose parent realpath escapes the root ($label)',
    ({ policy, rootDir, parent, leaf, outside }) => {
      describe('When write fires twice', () => {
        it('Then EACH throws PERMISSION_DENIED per entry (creation post-check untouched)', async () => {
          // Arrange
          const fsOps = fakeFsOps({
            realpath: vi.fn().mockImplementation(async (input: string) => {
              if (input === rootDir) return rootDir;
              if (input === parent) return outside;
              return input;
            }),
            lstat: vi.fn().mockRejectedValue(enoent()),
          });
          const sut = new NodeFileSystem(rootDir, policy, fsOps);

          // Act
          let firstCaught: unknown;
          try {
            await sut.write(leaf, new Uint8Array([1]));
          } catch (err) {
            firstCaught = err;
          }
          let secondCaught: unknown;
          try {
            await sut.write(leaf, new Uint8Array([2]));
          } catch (err) {
            secondCaught = err;
          }

          // Assert
          expect(firstCaught).toBeInstanceOf(TsgitError);
          expect((firstCaught as TsgitError).data.code).toBe('PERMISSION_DENIED');
          expect(secondCaught).toBeInstanceOf(TsgitError);
          expect((secondCaught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        });
      });
    },
  );
});

describe('NodeFileSystem — lstat exact-root leaf containment (DI)', () => {
  describe.each([
    {
      label: 'posix',
      policy: posixPolicy,
      linkRoot: '/link/repo',
      realParentDir: '/real',
      outside: '/outside',
    },
    {
      label: 'windows',
      policy: windowsPolicy,
      linkRoot: 'C:\\link\\repo',
      realParentDir: 'C:\\real',
      outside: 'C:\\outside',
    },
  ])(
    'Given rootDir is a symlink whose leaf resolves outside its own tree ($label)',
    ({ policy, linkRoot, realParentDir, outside }) => {
      describe('When lstat(rootDir) is called', () => {
        it('Then it is admitted (lexical `===` arm, not a deferred realpath post-check)', async () => {
          // Arrange — rootDir itself is the symlink (`realpath(rootDir)`
          // flips it to `outside`, so the canonical root IS `outside`).
          // `resolveRead` never realpaths the leaf: it admits `linkRoot`
          // because the RAW root prefix's `===` arm matches directly,
          // regardless of what `linkRoot`'s own realpath resolves to. The
          // dirname/`realParentDir` wiring below is dead for this call —
          // kept only so the mock shape stays parallel to the sibling
          // "normal rootDir" case.
          const dirnameOfRoot = policy.dirname(linkRoot);
          const realpathSpy = vi.fn().mockImplementation(async (input: string) => {
            if (input === linkRoot) return outside;
            if (input === dirnameOfRoot) return realParentDir;
            return input;
          });
          const fsOps = fakeFsOps({
            realpath: realpathSpy,
            lstat: vi.fn().mockResolvedValue({
              ctimeMs: BigInt(0),
              mtimeMs: BigInt(0),
              dev: BigInt(0),
              ino: BigInt(0),
              mode: BigInt(0o040755),
              uid: BigInt(0),
              gid: BigInt(0),
              size: BigInt(0),
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false,
            }),
          });
          const sut = new NodeFileSystem(linkRoot, policy, fsOps);

          // Act
          const stat = await sut.lstat(linkRoot);

          // Assert
          expect(stat.isDirectory).toBe(true);
        });
      });
    },
  );

  describe.each([
    { label: 'posix', policy: posixPolicy, rootDir: '/root' },
    { label: 'windows', policy: windowsPolicy, rootDir: 'C:\\Root' },
  ])('Given a normal rootDir with no symlinks ($label)', ({ policy, rootDir }) => {
    describe('When lstat(rootDir) is called', () => {
      it('Then it is admitted (no false-deny regression on the exact-root leaf)', async () => {
        // Arrange — realpath is identity for both rootDir and its dirname;
        // the exact-root leaf must still be admitted once the shortcut is
        // replaced by a deferred post-check.
        const fileStat = {
          ctimeMs: BigInt(0),
          mtimeMs: BigInt(0),
          dev: BigInt(0),
          ino: BigInt(0),
          mode: BigInt(0o040755),
          uid: BigInt(0),
          gid: BigInt(0),
          size: BigInt(0),
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        };
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, policy, fsOps);

        // Act
        const result = await sut.lstat(rootDir);

        // Assert
        expect(result.isDirectory).toBe(true);
      });
    });
  });

  describe.each([
    { label: 'posix', policy: posixPolicy, rootDir: '/root' },
    { label: 'windows', policy: windowsPolicy, rootDir: 'C:\\Root' },
  ])('Given rm on the exact rootDir path ($label)', ({ policy, rootDir }) => {
    describe('When rm is called', () => {
      it('Then it is admitted (the joined parent-realpath + basename reconstructs rootDir, which the post-check`s `===` arm admits)', async () => {
        // Arrange — dirname(rootDir) is the root's own parent, which is
        // NOT itself contained; but `realpathForCreation` joins that
        // parent's realpath with rootDir's own basename, reconstructing
        // rootDir exactly, so the unconditional post-check admits it on
        // its own merits — no exact-root special case is needed.
        const realpath = vi.fn().mockImplementation(async (input: string) => input);
        const fsOps = fakeFsOps({ realpath });
        const sut = new NodeFileSystem(rootDir, policy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.rm(rootDir);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeUndefined();
        expect(fsOps.rm).toHaveBeenCalledWith(rootDir);
      });
    });
  });
});

describe('assertLeafSafeToWrite — non-ENOENT errno on leaf lstat (DI)', () => {
  describe('Given a well-formed target whose leaf lstat throws ENOTDIR (file used as directory)', () => {
    describe('When chmod is called', () => {
      it('Then throws NOT_A_DIRECTORY', async () => {
        // Arrange — `chmod` always runs the explicit leaf check (no portable
        // no-follow chmod exists), on every platform. `interpretCreationLstat`
        // must funnel a non-ENOENT leaf-lstat errno through `mapErrno`.
        const rootDir = '/root';
        const leaf = '/root/leaf.txt';
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockRejectedValue(enotdir()),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.chmod(leaf, 0o644);
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

describe('NodeFileSystem — W2 leaf no-follow composition (DI)', () => {
  const WRITE_CREATE_FLAGS =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
  const WRITE_EXCLUSIVE_FLAGS =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const APPEND_FLAGS =
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;

  describe('Given a contained target', () => {
    describe('When write is called', () => {
      it('Then fsOps.writeFile receives O_NOFOLLOW composed into the creation flags', async () => {
        // Arrange
        const rootDir = '/root';
        const writeFile = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          writeFile,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.write('/root/leaf.bin', new Uint8Array([1]));

        // Assert
        expect(writeFile).toHaveBeenCalledWith('/root/leaf.bin', new Uint8Array([1]), {
          flag: WRITE_CREATE_FLAGS,
        });
      });
    });

    describe('When writeUtf8 is called', () => {
      it('Then fsOps.writeFile receives the utf-8 encoding AND O_NOFOLLOW composed into the creation flags', async () => {
        // Arrange
        const rootDir = '/root';
        const writeFile = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          writeFile,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.writeUtf8('/root/leaf.txt', 'hello');

        // Assert
        expect(writeFile).toHaveBeenCalledWith('/root/leaf.txt', 'hello', {
          encoding: 'utf-8',
          flag: WRITE_CREATE_FLAGS,
        });
      });
    });

    describe('When writeExclusive is called', () => {
      it('Then fsOps.writeFile receives O_EXCL composed with O_NOFOLLOW', async () => {
        // Arrange
        const rootDir = '/root';
        const writeFile = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          writeFile,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.writeExclusive('/root/lock.bin', new Uint8Array([2]));

        // Assert
        expect(writeFile).toHaveBeenCalledWith('/root/lock.bin', new Uint8Array([2]), {
          flag: WRITE_EXCLUSIVE_FLAGS,
        });
      });
    });

    describe('When appendUtf8 is called', () => {
      it('Then fsOps.appendFile receives the utf-8 encoding AND O_APPEND composed with O_NOFOLLOW', async () => {
        // Arrange
        const rootDir = '/root';
        const appendFile = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          appendFile,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.appendUtf8('/root/log.txt', 'entry\n');

        // Assert
        expect(appendFile).toHaveBeenCalledWith('/root/log.txt', 'entry\n', {
          encoding: 'utf-8',
          flag: APPEND_FLAGS,
        });
      });
    });

    describe('When openWithNoFollow(write) is called', () => {
      it('Then fsOps.open receives O_WRONLY composed with O_NOFOLLOW', async () => {
        // Arrange
        const rootDir = '/root';
        const handle = { close: vi.fn().mockResolvedValue(undefined) };
        const open = vi.fn().mockResolvedValue(handle);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          open,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const wrapped = await sut.openWithNoFollow('/root/leaf.bin', 'write');
        await wrapped.close();

        // Assert
        expect(open).toHaveBeenCalledWith(
          '/root/leaf.bin',
          fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
        );
      });
    });
  });

  describe('Given a POSIX policy', () => {
    describe('When write is called', () => {
      it('Then no pre-write lstat is issued (O_NOFOLLOW alone guards the leaf)', async () => {
        // Arrange
        const rootDir = '/root';
        const lstat = vi.fn().mockRejectedValue(enoent());
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.write('/root/leaf.bin', new Uint8Array([1]));

        // Assert
        expect(lstat).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a hypothetical case-insensitive POSIX policy (caseInsensitive=true, honoursNoFollow=true)', () => {
    describe('When write is called', () => {
      it('Then no pre-write lstat is issued — the write guard keys off honoursNoFollow, not caseInsensitive', async () => {
        // Arrange — pins the exact latent break the capability split
        // prevents: before it, `assertWritableLeaf` ran the extra pre-write
        // lstat whenever `caseInsensitive` was true, regardless of whether
        // the platform's `open(2)` actually honours `O_NOFOLLOW`. A policy
        // that is case-insensitive yet still honours `O_NOFOLLOW` (this
        // one) must rely on the syscall flag alone, exactly like posixPolicy.
        const rootDir = '/root';
        const lstat = vi.fn().mockRejectedValue(enoent());
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat,
        });
        const caseInsensitivePosixPolicy = { ...posixPolicy, caseInsensitive: true };
        const sut = new NodeFileSystem(rootDir, caseInsensitivePosixPolicy, fsOps);

        // Act
        await sut.write('/root/leaf.bin', new Uint8Array([1]));

        // Assert
        expect(lstat).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a Windows policy and a symlink leaf', () => {
    describe('When write is called', () => {
      it('Then the pre-write lstat refuses it with PERMISSION_DENIED before any write', async () => {
        // Arrange — O_NOFOLLOW is silently ignored by the Win32 API, so the
        // explicit pre-write lstat is the only defence there.
        const rootDir = 'C:\\Root';
        const writeFile = vi.fn().mockResolvedValue(undefined);
        const lstat = vi.fn().mockResolvedValue({ isSymbolicLink: () => true });
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat,
          writeFile,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        let caught: unknown;
        try {
          await sut.write('C:\\Root\\link.bin', new Uint8Array([1]));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        expect(lstat).toHaveBeenCalledWith('C:\\Root\\link.bin');
        expect(writeFile).not.toHaveBeenCalled();
      });
    });

    describe('When write is called on a non-symlink leaf', () => {
      it('Then the pre-write lstat runs and the write proceeds', async () => {
        // Arrange
        const rootDir = 'C:\\Root';
        const writeFile = vi.fn().mockResolvedValue(undefined);
        const lstat = vi.fn().mockResolvedValue({ isSymbolicLink: () => false });
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat,
          writeFile,
        });
        const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);

        // Act
        await sut.write('C:\\Root\\leaf.bin', new Uint8Array([1]));

        // Assert
        expect(lstat).toHaveBeenCalledWith('C:\\Root\\leaf.bin');
        expect(writeFile).toHaveBeenCalledTimes(1);
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
      it('Then fsOps.symlink is invoked with the target unchanged (no containment check on targets)', async () => {
        // Arrange — a symlink's target is opaque bytes, written verbatim,
        // like git: the target itself is never validated against the root
        // set, so an absolute target outside rootDir is passed through.
        const rootDir = '/root';
        const link = '/root/exfil-link';
        const symlinkOp = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          symlink: symlinkOp,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.symlink('/etc/passwd', link);

        // Assert
        expect(symlinkOp).toHaveBeenCalledWith('/etc/passwd', link);
      });
    });
  });

  describe('Given an absolute target with `..` that resolves OUTSIDE rootDir', () => {
    describe('When symlink runs', () => {
      it('Then fsOps.symlink is invoked with the target unchanged, `..` uncollapsed', async () => {
        // Arrange — targets are never resolved or compared against the root
        // set, so an embedded `..` is passed straight through too.
        const rootDir = '/root';
        const link = '/root/escape-link';
        const symlinkOp = vi.fn().mockResolvedValue(undefined);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          symlink: symlinkOp,
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.symlink('/root/sub/../../escape', link);

        // Assert
        expect(symlinkOp).toHaveBeenCalledWith('/root/sub/../../escape', link);
      });
    });
  });

  describe('Given a relative symlink target (even one containing ..)', () => {
    describe('When symlink is called', () => {
      it('Then fsOps.symlink is invoked unchanged', async () => {
        // Arrange — a relative target is passed through exactly like an
        // absolute one: no target is ever validated at create time.
        // Resolution happens at the OS level, whenever something follows
        // the link.
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
  describe('Given `exists` and a stat that synthesises a TsgitError', () => {
    describe('When exists is called', () => {
      it('Then exists rethrows it unchanged (no re-wrap via mapErrno)', async () => {
        // Arrange — `exists` probes existence via `fsOps.stat`, not
        // `fsOps.realpath` (which now runs only once, for root
        // canonicalisation). A TsgitError has no own `code` — `isErrnoException`
        // is false for it — so exists's catch falls through both errno
        // branches to the final defensive `throw err`. A mutant that widened
        // either errno branch to swallow it would re-wrap or drop the
        // instance instead of rethrowing it unchanged.
        const rootDir = '/root';
        const sentinel = new TsgitError({ code: 'OPERATION_ABORTED' });
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          stat: vi.fn().mockRejectedValue(sentinel),
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
    describe('When chmod is called', () => {
      it('Then resolveWrite rethrows it unchanged', async () => {
        // Arrange — same logic for the write guard's (`resolveWrite`) catch
        // block. `chmod` always resolves through it, on every platform.
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
          await sut.chmod('/root/sub/probe.txt', 0o644);
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
      it('Then the inner probe calls `fsOps.lstat` directly, not the public `lstat` wrapper', async () => {
        // Arrange — pins: the existence probe calls
        // `runFs(() => this.fsOps.lstat(real), path)` directly rather than
        // re-entering the public `this.lstat(real)` wrapper.
        //
        // NOTE (retired oracle): this test used to count `realpath(rootDir)`
        // calls, on the theory that re-entering `this.lstat` would re-run
        // the write guard and add a round-trip. That stopped being true once
        // `lstat` (a read surface) was moved onto `resolveRead` — a
        // synchronous, syscall-free containment check — so a regression back
        // to `this.lstat(real)` would add ZERO extra `realpath` calls and the
        // old assertion could never fail again. The observable that still
        // moves is `fsOps.lstat`'s own call shape: the public `lstat`
        // wrapper always passes a second `{ bigint: true }` argument (for
        // `mapStat`); the direct probe never does. A regression back to
        // `this.lstat(real)` shows up here as a 3rd call carrying that
        // second argument (the existence probe PLUS `removeTree`'s own
        // unconditional leaf `lstat` normally total exactly 2 bare calls).
        const rootDir = '/root';
        const target = '/root/file.txt';
        const lstatSpy = vi.fn().mockResolvedValue(fileStat);
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: lstatSpy,
          rm: vi.fn().mockResolvedValue(undefined),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        await sut.rmRecursive(target);

        // Assert
        expect(lstatSpy.mock.calls).toEqual([[target], [target]]);
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

describe('NodeFileSystem.readSlice — exact-size unsafe allocation (DI)', () => {
  describe('Given a readSlice call', () => {
    describe('When it runs', () => {
      it('Then it allocates via Buffer.allocUnsafe(length), not the zero-filling Buffer.alloc', async () => {
        // Arrange — the pack delta-chain hot path pays for zero-filling a
        // buffer that `handle.read` immediately overwrites; a mutant reverting
        // to the zero-filling `Buffer.alloc` must be caught here.
        const rootDir = '/root';
        const payload = Buffer.from([1, 2, 3, 4]);
        const handle = {
          read: vi.fn().mockImplementation(async (buf: Buffer) => {
            payload.copy(buf);
            return { bytesRead: payload.length, buffer: buf };
          }),
          close: vi.fn().mockResolvedValue(undefined),
        };
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          open: vi.fn().mockResolvedValue(handle),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);
        const allocUnsafeSpy = vi.spyOn(Buffer, 'allocUnsafe');
        const allocSpy = vi.spyOn(Buffer, 'alloc');

        try {
          // Act
          await sut.readSlice('/root/file.bin', 0, 4);

          // Assert
          expect(allocUnsafeSpy).toHaveBeenCalledWith(4);
          expect(allocSpy).not.toHaveBeenCalled();
        } finally {
          allocUnsafeSpy.mockRestore();
          allocSpy.mockRestore();
        }
      });
    });
  });
});

describe('NodeFileSystem.readSlice — short read at EOF (DI)', () => {
  describe('Given a read that returns fewer bytes than requested', () => {
    describe('When readSlice runs', () => {
      it('Then the result is exactly bytesRead long with no trailing zero padding', async () => {
        // Arrange — request 8 bytes but the handle only has 3 available.
        // `Buffer.allocUnsafe` does not zero-fill, so forgetting to trim the
        // view to `bytesRead` (instead of the requested `length`) would leak
        // whatever garbage bytes were already in that memory.
        const rootDir = '/root';
        const payload = Buffer.from([9, 9, 9]);
        const handle = {
          read: vi.fn().mockImplementation(async (buf: Buffer) => {
            payload.copy(buf);
            return { bytesRead: payload.length, buffer: buf };
          }),
          close: vi.fn().mockResolvedValue(undefined),
        };
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          open: vi.fn().mockResolvedValue(handle),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const result = await sut.readSlice('/root/file.bin', 0, 8);

        // Assert
        expect(result).toEqual(new Uint8Array([9, 9, 9]));
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

  // The "N lstats under the same parent normalise the constant parent
  // exactly twice, the child exactly once" oracle used to prove the
  // pre-check/cached-post-check split of the old per-parent containment
  // VERDICT cache. `lstat()` moved to the syscall-free `resolveRead`, and
  // the write guard's post-check now runs unconditionally on every call
  // (no verdict is ever cached) — so the oracle no longer describes a live
  // mechanism anywhere. The equivalent parent-realpath-cache regression
  // coverage (still load-bearing for every write surface) lives in
  // "NodeFileSystem — write guard per-call containment post-check (DI)"
  // above, via `rm`.

  describe('Given a child the root contains (equal to it, or strictly nested under it)', () => {
    describe('When lstat runs', () => {
      it.each([
        {
          label: 'a root-equal child is contained on posix (=== arm)',
          rootDir: '/root',
          policy: posixPolicy,
          leaf: '/root',
        },
        {
          label: 'a nested child is contained on posix (startsWith arm)',
          rootDir: '/root',
          policy: posixPolicy,
          leaf: '/root/sub/leaf',
        },
        {
          label: 'a root-equal child is contained on windows (=== arm)',
          rootDir: 'C:\\Root',
          policy: windowsPolicy,
          leaf: 'C:\\Root',
        },
        {
          label: 'a nested, case-folded child is contained on windows (startsWith arm)',
          rootDir: 'C:\\Root',
          policy: windowsPolicy,
          leaf: 'c:\\root\\x',
        },
      ])('Then $label', async ({ rootDir, policy, leaf }) => {
        // Arrange
        const fsOps = fakeFsOps({
          realpath: vi.fn().mockImplementation(async (input: string) => input),
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, policy, fsOps);

        // Act
        const result = await sut.lstat(leaf);

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

  describe('Given a rootDir whose realpath differs from the raw root', () => {
    describe('When a child of the canonical root is lstat-ed', () => {
      it('Then it is admitted via the canonical +sep prefix', async () => {
        // Arrange — realpath(rootDir) resolves to a DIFFERENT canonical root.
        // A child contained only by the canonical form must be admitted,
        // proving the canonical prefix is unioned into the root set.
        const rootDir = '/root';
        const canonicalRoot = '/canonical-root';
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === rootDir) return canonicalRoot;
          if (input === canonicalRoot) return canonicalRoot;
          throw enoent();
        });
        const fsOps = fakeFsOps({
          realpath,
          lstat: vi.fn().mockResolvedValue(fileStat),
        });
        const sut = new NodeFileSystem(rootDir, posixPolicy, fsOps);

        // Act
        const result = await sut.lstat('/canonical-root/leaf');

        // Assert
        expect(result.isFile).toBe(true);
      });
    });
  });

  describe('Given a root whose entire path is unresolvable (unmounted volume)', () => {
    describe('When exists probes a child of that root', () => {
      it('Then the lexical root gates it and no raw errno escapes', async () => {
        // Arrange — every realpath (root, ancestors, volume root) ENOENTs,
        // the unmounted-drive shape. The root must fall back to its lexical
        // form rather than rejecting the whole adapter unmapped.
        const realpath = vi.fn().mockRejectedValue(enoent());
        const sut = new NodeFileSystem('/gone', posixPolicy, fakeFsOps({ realpath }));

        // Act
        const result = await sut.exists('/gone/file');

        // Assert — inside the lexical root, target absent.
        expect(result).toBe(false);
      });
    });

    describe('When the nearest-existing walk fails with a non-ENOENT errno', () => {
      it('Then that errno propagates instead of being swallowed', async () => {
        // Arrange — realpath('/gone/missing') ENOENTs (triggering the
        // nearest-existing fallback) but the ancestor probe EACCESes.
        const realpath = vi.fn().mockImplementation(async (input: string) => {
          if (input === '/gone/missing') throw enoent();
          throw eacces();
        });
        const sut = new NodeFileSystem('/gone/missing', posixPolicy, fakeFsOps({ realpath }));

        // Act
        let caught: unknown;
        try {
          await sut.exists('/gone/missing/file');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as NodeJS.ErrnoException).code).toBe('EACCES');
      });
    });

    describe('When write targets a child of that root', () => {
      it('Then the raw ENOENT that escapes realpathNearestExisting`s final root probe maps to FILE_NOT_FOUND', async () => {
        // Arrange — every realpath ENOENTs, including the final,
        // try/catch-free `fsOps.realpath(root)` fallback inside
        // `realpathNearestExisting`. That raw ENOENT propagates all the way
        // out of `realpathForCreation` and must be mapped by
        // `resolveWrite`'s own catch, not swallowed or misreported.
        const realpath = vi.fn().mockRejectedValue(enoent());
        const sut = new NodeFileSystem('/gone', posixPolicy, fakeFsOps({ realpath }));

        // Act
        let caught: unknown;
        try {
          await sut.write('/gone/missing/file', new Uint8Array([1]));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
      });
    });
  });
});
