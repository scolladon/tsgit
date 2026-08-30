import { describe, expect, it, vi } from 'vitest';

import {
  MemoryCommandRunner,
  MemoryCompressor,
  MemoryFileSystem,
  MemoryHashService,
  MemoryHookRunner,
  MemoryHttpTransport,
} from '../../../src/adapters/memory/index.js';
import { readConfig } from '../../../src/application/primitives/config-read.js';
import { readConfigSections } from '../../../src/application/primitives/config-scoped-read.js';
import { loadShallowSet } from '../../../src/application/primitives/internal/shallow-set.js';
import { readIndex } from '../../../src/application/primitives/read-index.js';
import { TsgitError } from '../../../src/domain/error.js';
import { FILE_MODE } from '../../../src/domain/objects/file-mode.js';
import { SHA1_CONFIG } from '../../../src/domain/objects/hash-config.js';
import type { Blob, FilePath, ObjectId } from '../../../src/domain/objects/index.js';
import { treeEntry } from '../../../src/domain/objects/tree.js';
import { createLruCache } from '../../../src/domain/storage/lru-cache.js';
import type { FileSystem } from '../../../src/ports/file-system.js';
import { openRepository, type Repository, type RuntimeFallback } from '../../../src/repository.js';
import { writeSyntheticPack } from '../application/primitives/pack-fixture.js';

const makeFallback = (): RuntimeFallback => ({
  fs: new MemoryFileSystem({ rootDir: '/repo' }),
  hash: new MemoryHashService('sha1'),
  compressor: new MemoryCompressor(),
  transport: new MemoryHttpTransport(),
  runtime: 'memory',
  layout: { workDir: '/repo', gitDir: '/repo/.git', bare: false, refStorage: 'files' },
  hashConfig: SHA1_CONFIG,
  deltaCache: createLruCache<Uint8Array>(1024),
});

const open = (opts: Parameters<typeof openRepository>[0] = {}): Promise<Repository> =>
  openRepository({ cwd: '/repo', ...opts }, makeFallback());

// A memory FS whose config-path probes are all unavailable (mirrors the browser
// adapter, which throws UNSUPPORTED_OPERATION on these). computeConfigScopePaths
// swallows the throw and skips that scope.
class UnavailableConfigFs extends MemoryFileSystem {
  homedir = (): string => {
    throw new Error('unavailable');
  };
  xdgConfigHome = (): string => {
    throw new Error('unavailable');
  };
  systemConfigPath = (): string => {
    throw new Error('unavailable');
  };
}

// Narrow the optional worktreeFs capability the facade always populates.
const worktreeScopedFs = (repo: Repository, path: string): FileSystem => {
  const factory = repo.ctx.worktreeFs;
  if (factory === undefined) throw new Error('worktreeFs capability missing');
  return factory(path);
};

const rejectionCode = async (op: () => Promise<unknown>): Promise<string> => {
  try {
    await op();
  } catch (err) {
    return (err as { data: { code: string } }).data.code;
  }
  throw new Error('expected a rejection but the call resolved');
};

describe('openRepository — construction', () => {
  describe('Given a fallback set and no overrides', () => {
    describe('When openRepository runs', () => {
      it('Then resolves to a Repository handle', async () => {
        // Arrange / Act
        const sut = await open();

        // Assert
        expect(sut).toBeDefined();
        expect(typeof sut.dispose).toBe('function');
      });
    });
  });

  describe('Given the returned handle', () => {
    describe('When inspecting it', () => {
      it('Then it is frozen', async () => {
        // Arrange / Act
        const sut = await open();

        // Assert
        expect(Object.isFrozen(sut)).toBe(true);
        expect(Object.isFrozen(sut.primitives)).toBe(true);
      });
    });
    describe('When inspecting ctx', () => {
      it('Then ctx is frozen', async () => {
        // Arrange / Act
        const sut = await open();

        // Assert
        expect(Object.isFrozen(sut.ctx)).toBe(true);
      });
    });
    describe('When inspecting layout', () => {
      it('Then repo.layout is the SAME object as ctx.layout, and is deep-frozen', async () => {
        // Arrange / Act
        const sut = await open();

        // Assert — one source of truth, not a copy.
        expect(sut.layout).toBe(sut.ctx.layout);
        expect(Object.isFrozen(sut.layout)).toBe(true);
      });
    });
    describe('When inspecting the blame binding', () => {
      it('Then repo.blame is a bound function', async () => {
        // Arrange / Act
        const sut = await open();

        // Assert
        expect(typeof sut.blame).toBe('function');
      });
    });
  });
});

describe('openRepository — hooks', () => {
  describe('Given no hooks option and a fallback without one', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.hooks is undefined', async () => {
        // Arrange / Act
        const sut = await open();

        // Assert
        expect(sut.ctx.hooks).toBeUndefined();
      });
    });
  });

  describe('Given an explicit hook runner', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.hooks is that runner', async () => {
        // Arrange
        const runner = new MemoryHookRunner();

        // Act
        const sut = await open({ hooks: runner });

        // Assert
        expect(sut.ctx.hooks).toBe(runner);
      });
    });
  });

  describe('Given hooks: false and a fallback that supplies a runner', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.hooks is undefined', async () => {
        // Arrange / Act
        const sut = await openRepository(
          { cwd: '/repo', hooks: false },
          { ...makeFallback(), hooks: new MemoryHookRunner() },
        );

        // Assert
        expect(sut.ctx.hooks).toBeUndefined();
      });
    });
  });

  describe('Given no hooks option but a fallback that supplies a runner', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.hooks is the fallback runner', async () => {
        // Arrange
        const runner = new MemoryHookRunner();

        // Act
        const sut = await openRepository({ cwd: '/repo' }, { ...makeFallback(), hooks: runner });

        // Assert
        expect(sut.ctx.hooks).toBe(runner);
      });
    });
  });
});

describe('openRepository — command', () => {
  describe('Given no command option and a fallback without one', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.command is undefined', async () => {
        // Arrange / Act
        const sut = await open();

        // Assert
        expect(sut.ctx.command).toBeUndefined();
      });
    });
  });

  describe('Given an explicit command runner', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.command is that runner', async () => {
        // Arrange
        const runner = new MemoryCommandRunner();

        // Act
        const sut = await open({ command: runner });

        // Assert
        expect(sut.ctx.command).toBe(runner);
      });
    });
  });

  describe('Given command: false and a fallback that supplies a runner', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.command is undefined', async () => {
        // Arrange / Act
        const sut = await openRepository(
          { cwd: '/repo', command: false },
          { ...makeFallback(), command: new MemoryCommandRunner() },
        );

        // Assert
        expect(sut.ctx.command).toBeUndefined();
      });
    });
  });

  describe('Given no command option but a fallback that supplies a runner', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.command is the fallback runner', async () => {
        // Arrange
        const runner = new MemoryCommandRunner();

        // Act
        const sut = await openRepository({ cwd: '/repo' }, { ...makeFallback(), command: runner });

        // Assert
        expect(sut.ctx.command).toBe(runner);
      });
    });
  });
});

describe('openRepository — Repository binding integrity', () => {
  describe('Given the returned handle', () => {
    describe('When listing top-level keys', () => {
      it('Then they exactly match the documented surface', async () => {
        // Arrange / Act
        const sut = await open();

        // Assert
        expect(Object.keys(sut).sort()).toEqual(
          [
            'add',
            'archive',
            'blame',
            'branch',
            'bundle',
            'catFile',
            'checkout',
            'cherryPick',
            'clone',
            'commit',
            'config',
            'ctx',
            'describe',
            'diff',
            'dispose',
            'fetch',
            'fetchMissing',
            'fsck',
            'grep',
            'init',
            'layout',
            'log',
            'maintenance',
            'merge',
            'mv',
            'nameRev',
            'notes',
            'packObjects',
            'packRefs',
            'primitives',
            'pull',
            'push',
            'readFileAt',
            'rangeDiff',
            'rebase',
            'reflog',
            'remote',
            'reset',
            'revList',
            'revParse',
            'revert',
            'rm',
            'shortlog',
            'show',
            'snapshot',
            'sparseCheckout',
            'stash',
            'status',
            'submodule',
            'tag',
            'whatchanged',
            'worktree',
          ].sort(),
        );
      });
    });
    describe('When listing primitives', () => {
      it('Then they match the documented Tier-2 surface', async () => {
        // Arrange / Act
        const sut = await open();

        // Assert
        expect(Object.keys(sut.primitives).sort()).toEqual(
          [
            'bisectMidpoint',
            'catFileBatch',
            'commonGitDir',
            'createCommit',
            'diffTrees',
            'flattenTree',
            'getRepoRoot',
            'hashBlob',
            'isIgnored',
            'mergeBase',
            'readBlob',
            'readIndex',
            'readObject',
            'readTree',
            'resolveRef',
            'runHook',
            'streamBlob',
            'updateRef',
            'walkCommits',
            'walkCommitsByDate',
            'walkSubmodules',
            'walkTree',
            'walkWorkingTree',
            'writeObject',
            'writeTree',
          ].sort(),
        );
      });
    });
    describe('When typeof every binding is checked', () => {
      it('Then each is a function', async () => {
        // Arrange
        const sut = await open();
        // CRUD-family bindings are nested-namespace objects, not functions.
        const namespaceKeys = new Set([
          'bundle',
          'config',
          'remote',
          'branch',
          'notes',
          'tag',
          'sparseCheckout',
          'stash',
          'cherryPick',
          'revert',
          'rebase',
          'merge',
          'submodule',
          'worktree',
        ]);
        const nonFunctionKeys = new Set([
          'ctx',
          'layout',
          'primitives',
          'snapshot',
          ...namespaceKeys,
        ]);

        // Assert
        for (const key of Object.keys(sut)) {
          if (nonFunctionKeys.has(key)) continue;
          expect(typeof (sut as unknown as Record<string, unknown>)[key]).toBe('function');
        }
        // Each namespace is a frozen object whose methods are all functions.
        for (const ns of namespaceKeys) {
          const namespace = (sut as unknown as Record<string, Record<string, unknown>>)[ns];
          expect(typeof namespace).toBe('object');
          expect(Object.isFrozen(namespace)).toBe(true);
          for (const key of Object.keys(namespace as object)) {
            expect(typeof (namespace as Record<string, unknown>)[key]).toBe('function');
          }
        }
        for (const key of Object.keys(sut.primitives)) {
          expect(typeof (sut.primitives as unknown as Record<string, unknown>)[key]).toBe(
            'function',
          );
        }
      });
    });
  });
});

describe('openRepository — INVALID_OPTION validation', () => {
  describe('Given a relative cwd', () => {
    describe('When openRepository runs', () => {
      it('Then throws INVALID_OPTION with .data.option === cwd', async () => {
        // Arrange / Act / Assert
        try {
          await openRepository({ cwd: 'relative' }, makeFallback());
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          const data = (err as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code === 'INVALID_OPTION') {
            expect(data.option).toBe('cwd');
          }
        }
      });
    });
  });

  describe('Given parallelism = 0', () => {
    describe('When openRepository runs', () => {
      it('Then throws INVALID_OPTION', async () => {
        // Arrange / Act / Assert
        try {
          await openRepository({ cwd: '/repo', config: { parallelism: 0 } }, makeFallback());
          expect.unreachable();
        } catch (err) {
          const data = (err as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
        }
      });
    });
  });
});

describe('openRepository — dispose state machine', () => {
  describe('Given a fresh repo', () => {
    describe('When dispose is called', () => {
      it('Then state transitions to DISPOSED', async () => {
        // Arrange
        const sut = await open();

        // Act
        await sut.dispose();

        // Assert — after dispose, init MUST throw REPOSITORY_DISPOSED.
        try {
          await sut.init();
          expect.unreachable();
        } catch (err) {
          const data = (err as TsgitError).data;
          expect(data.code).toBe('REPOSITORY_DISPOSED');
        }
      });
    });
  });

  describe('Given an opened repo', () => {
    describe('When ctx is inspected', () => {
      it('Then the promisor port is wired and exposes the fetch contract', async () => {
        // Arrange / Act
        const sut = await open();

        // Assert — the port must expose `.fetch(oids)`; a `{}` mutant on the
        // construction site would survive a bare `toBeDefined()`.
        expect(typeof sut.ctx.promisor?.fetch).toBe('function');
      });
    });
  });

  describe('Given a disposed repo', () => {
    describe('When a bound primitive, command, or namespace method is invoked', () => {
      it.each([
        ['fetchMissing', (repo: Repository) => repo.fetchMissing({ oids: [] })],
        ['grep', (repo: Repository) => repo.grep({ patterns: [{ fixed: 'hello' }] })],
        ['primitives.readIndex', (repo: Repository) => repo.primitives.readIndex()],
        ['merge.abort', (repo: Repository) => repo.merge.abort()],
        ['merge.continue', (repo: Repository) => repo.merge.continue()],
        ['merge.run', (repo: Repository) => repo.merge.run({ rev: 'feature' })],
        ['show', (repo: Repository) => repo.show()],
      ] as const)('Then %s throws REPOSITORY_DISPOSED', async (_label, call) => {
        // Arrange
        const sut = await open();
        await sut.dispose();

        // Act
        let caught: unknown;
        try {
          await call(sut);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('REPOSITORY_DISPOSED');
      });
    });

    describe('When dispose is called again', () => {
      it('Then resolves without throwing (idempotent)', async () => {
        // Arrange
        const sut = await open();
        await sut.dispose();

        // Act / Assert
        await expect(sut.dispose()).resolves.toBeUndefined();
      });
    });
  });

  describe('Given a port that increments a counter on dispose AND two concurrent dispose calls', () => {
    describe('When awaited', () => {
      it('Then dispose is called EXACTLY ONCE on that port', async () => {
        // Arrange
        let disposeCalls = 0;
        const fallback = makeFallback();
        const innerFs = fallback.fs;
        const fsWithDispose = {
          ...innerFs,
          dispose: async () => {
            disposeCalls += 1;
          },
        };
        const sut = await openRepository(
          { cwd: '/repo', fs: fsWithDispose, unsafeRawAdapters: true },
          fallback,
        );

        // Act
        await Promise.all([sut.dispose(), sut.dispose(), sut.dispose()]);

        // Assert
        expect(disposeCalls).toBe(1);
      });
    });
  });

  describe('Given a repo whose pack was touched by a read (persistent handle opened)', () => {
    describe('When dispose is called', () => {
      it('Then closes the loaded pack handle', async () => {
        // Arrange — A4's pack registry lazily opens a persistent FileHandle on
        // the first slice read; dispose() must close it before the fs adapter
        // itself is torn down.
        const fallback = makeFallback();
        const innerFs = fallback.fs;
        let closeCalls = 0;
        const wrappedFs: FileSystem = {
          ...innerFs,
          openWithNoFollow: async (path, mode) => {
            const handle = await innerFs.openWithNoFollow(path, mode);
            return {
              ...handle,
              close: async () => {
                closeCalls += 1;
                await handle.close();
              },
            };
          },
        };
        const sut = await openRepository(
          { cwd: '/repo', fs: wrappedFs, unsafeRawAdapters: true },
          fallback,
        );
        await sut.init();
        const [id] = await writeSyntheticPack(sut.ctx, 'dispose-pack', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('handle-close') },
        ]);
        await sut.primitives.readObject(id as ObjectId);

        // Act
        await sut.dispose();

        // Assert
        expect(closeCalls).toBe(1);
      });
    });
  });

  describe('Given a repo that never touched a pack', () => {
    describe('When dispose is called', () => {
      it('Then resolves without scanning the pack directory', async () => {
        // Arrange — disposePackRegistry must not create a registry (and thus
        // never scan objects/pack/) when no primitive ever read a pack.
        const fallback = makeFallback();
        const innerFs = fallback.fs;
        let readdirCalls = 0;
        const wrappedFs: FileSystem = {
          ...innerFs,
          readdir: async (path) => {
            if (path === '/repo/.git/objects/pack') readdirCalls += 1;
            return innerFs.readdir(path);
          },
        };
        const sut = await openRepository(
          { cwd: '/repo', fs: wrappedFs, unsafeRawAdapters: true },
          fallback,
        );
        await sut.init();

        // Act
        await sut.dispose();

        // Assert
        expect(readdirCalls).toBe(0);
      });
    });
  });

  describe('Given a Repository handle', () => {
    describe('When the merge namespace is accessed', () => {
      it('Then run / continue / abort are all functions', async () => {
        // Arrange / Act
        const sut = await open();

        // Assert
        expect(typeof sut.merge.run).toBe('function');
        expect(typeof sut.merge.continue).toBe('function');
        expect(typeof sut.merge.abort).toBe('function');
      });
    });
  });

  describe('Given a user-supplied signal that aborts before dispose', () => {
    describe('When a bound method is invoked', () => {
      it('Then it throws REPOSITORY_DISPOSED via the atomic gate', async () => {
        // Arrange
        const controller = new AbortController();
        const sut = await openRepository(
          { cwd: '/repo', signal: controller.signal },
          makeFallback(),
        );
        controller.abort();

        // Act / Assert
        try {
          await sut.init();
          expect.unreachable();
        } catch (err) {
          const data = (err as TsgitError).data;
          expect(data.code).toBe('REPOSITORY_DISPOSED');
        }
      });
    });
  });
});

describe('openRepository — dispose cache hygiene', () => {
  describe('Given a repo whose deltaCache holds an entry', () => {
    describe('When dispose runs', () => {
      it('Then deltaCache is cleared (currentSize and entryCount both drop to zero)', async () => {
        // Arrange — a pooling server disposing an idle repo must reclaim
        // this memory, not keep it pinned while the handle stays reachable.
        const sut = await open();
        sut.ctx.deltaCache.set('some-key', new Uint8Array([1, 2, 3]), 3);
        expect(sut.ctx.deltaCache.currentSize).toBeGreaterThan(0);

        // Act
        await sut.dispose();

        // Assert
        expect(sut.ctx.deltaCache.currentSize).toBe(0);
        expect(sut.ctx.deltaCache.entryCount).toBe(0);
      });
    });
  });

  describe('Given a repo whose config-read cache was warmed before dispose', () => {
    describe('When dispose runs and readConfig is called again on the same ctx', () => {
      it('Then the cache re-reads instead of serving the pre-dispose entry — forgetSessionCaches dropped it', async () => {
        // Arrange — calls the primitive directly (not through a bound
        // facade method), since bound methods refuse outright once disposed;
        // this isolates the cache-hygiene effect from the dispose guard.
        const sut = await open();
        await sut.ctx.fs.writeUtf8(`${sut.ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');
        await readConfig(sut.ctx);
        const spy = vi.spyOn(sut.ctx.fs, 'readUtf8');

        // Act
        await sut.dispose();
        await readConfig(sut.ctx);

        // Assert
        expect(spy).toHaveBeenCalled();
      });
    });
  });

  describe('Given a repo whose shallow-set memo was warmed before dispose', () => {
    describe('When dispose runs and loadShallowSet is called again on the same ctx', () => {
      it('Then the memo re-reads instead of serving the pre-dispose entry — forgetSessionCaches dropped it', async () => {
        // Arrange
        const sut = await open();
        await loadShallowSet(sut.ctx);
        const spy = vi.spyOn(sut.ctx.fs, 'readUtf8');

        // Act
        await sut.dispose();
        await loadShallowSet(sut.ctx);

        // Assert
        expect(spy).toHaveBeenCalled();
      });
    });
  });

  describe('Given a repo whose index cache was warmed before dispose', () => {
    describe('When dispose runs and readIndex is called again on the same ctx', () => {
      it('Then the cache re-reads instead of serving the pre-dispose entry — forgetSessionCaches dropped it', async () => {
        // Arrange — a real index file (via add), so readIndex actually
        // populates its per-session cache rather than short-circuiting on
        // a missing file.
        const sut = await open();
        await sut.init();
        await sut.ctx.fs.writeUtf8(`${sut.ctx.layout.workDir}/tracked.txt`, 'hi');
        await sut.add(['tracked.txt']);
        await readIndex(sut.ctx);
        const spy = vi.spyOn(sut.ctx.fs, 'read');

        // Act
        await sut.dispose();
        await readIndex(sut.ctx);

        // Assert
        expect(spy).toHaveBeenCalled();
      });
    });
  });

  describe('Given a deltaCache whose clear() throws synchronously', () => {
    describe('When dispose runs', () => {
      it('Then adapter teardown still runs — a cache-release fault must not skip disposeAdapters', async () => {
        // Arrange — a pooling server disposing an idle repo must reclaim
        // adapter resources (here: the fs port's own teardown) even when an
        // unrelated in-process cache release faults first.
        const fallback = makeFallback();
        const boom = new Error('boom');
        const throwingDeltaCache = {
          ...fallback.deltaCache,
          clear: () => {
            throw boom;
          },
        };
        let disposeCalls = 0;
        const fsWithDispose = {
          ...fallback.fs,
          dispose: async () => {
            disposeCalls += 1;
          },
        };
        const sut = await openRepository(
          { cwd: '/repo', fs: fsWithDispose, unsafeRawAdapters: true },
          { ...fallback, deltaCache: throwingDeltaCache },
        );

        // Act
        await expect(sut.dispose()).rejects.toBe(boom);

        // Assert
        expect(disposeCalls).toBe(1);
      });
    });

    describe('When dispose is called again after that fault', () => {
      it('Then it resolves without re-throwing — a faulted first call still reaches DISPOSED', async () => {
        // Arrange — dispose is best-effort teardown: a fault the FIRST call
        // already surfaced (asserted above) must not wedge every later call
        // into re-awaiting the same rejected promise forever.
        const fallback = makeFallback();
        const boom = new Error('boom');
        const throwingDeltaCache = {
          ...fallback.deltaCache,
          clear: () => {
            throw boom;
          },
        };
        const sut = await openRepository(
          { cwd: '/repo', unsafeRawAdapters: true },
          { ...fallback, deltaCache: throwingDeltaCache },
        );
        await sut.dispose().catch(() => undefined);

        // Act / Assert
        await expect(sut.dispose()).resolves.toBeUndefined();
      });
    });
  });
});

describe('openRepository — unsafeRawAdapters', () => {
  describe('Given unsafeRawAdapters: true and a custom fs', () => {
    describe('When the wrapped fs is read from ctx', () => {
      it('Then it is reference-equal to the user-supplied fs (no wrapper layer in between) — kills mutants on the wrapping condition', async () => {
        // Arrange
        // Reference-equality is a stronger probe than behavioral: if wrapping is
        // applied, ctx.fs is a NEW object (the wrapper); without wrapping, ctx.fs
        // IS the user-supplied object.
        const fallback = makeFallback();
        const innerFs = fallback.fs;

        // Act
        const sut = await openRepository(
          { cwd: '/repo', fs: innerFs, unsafeRawAdapters: true },
          fallback,
        );

        // Assert
        expect(sut.ctx.fs).toBe(innerFs);
      });
    });
  });

  describe('Given unsafeRawAdapters: false (default) and a custom fs', () => {
    describe('When the wrapped fs is read from ctx', () => {
      it('Then it is NOT reference-equal to the user-supplied fs (wrapper applied)', async () => {
        // Arrange
        const fallback = makeFallback();
        const innerFs = fallback.fs;

        // Act
        const sut = await openRepository({ cwd: '/repo', fs: innerFs }, fallback);

        // Assert
        expect(sut.ctx.fs).not.toBe(innerFs);
      });
    });
  });

  describe('Given unsafeRawAdapters: false (default)', () => {
    describe('When the user-supplied fs writes outside cwd', () => {
      it('Then PATHSPEC_OUTSIDE_REPO is thrown by the wrapper', async () => {
        // Arrange
        const fallback = makeFallback();
        const innerFs = fallback.fs;
        const sut = await openRepository(
          // explicit override so wrapping fires on writes
          { cwd: '/repo', fs: innerFs },
          fallback,
        );

        // Act / Assert — bypass the type system: invoke the wrapped fs directly
        // with an out-of-cwd path.
        try {
          await sut.ctx.fs.write('/etc/passwd', new Uint8Array(0));
          expect.unreachable();
        } catch (err) {
          expect((err as { data: { code: string } }).data.code).toBe('PATHSPEC_OUTSIDE_REPO');
        }
      });
    });
  });
});

describe('openRepository — round-trip via memory adapter', () => {
  // A minimal smoke test that the bound init command delegates correctly.
  describe('Given a fresh repo', () => {
    describe('When init is called', () => {
      it('Then it completes and the .git directory is created', async () => {
        // Arrange
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo' }, fallback);

        // Act
        await sut.init();

        // Assert
        expect(await sut.ctx.fs.exists('/repo/.git/HEAD')).toBe(true);
      });
    });
    describe('When the bound reflog command is called', () => {
      it('Then it delegates and returns a show result', async () => {
        // Arrange — the bound `reflog` strips `ctx`; calling it with no args
        // defaults to `show` on HEAD with an empty entry list.
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo' }, fallback);
        await sut.init();

        // Act
        const result = await sut.reflog();

        // Assert
        expect(result).toEqual({ kind: 'show', ref: 'HEAD', entries: [] });
      });
    });
    describe('When the bound sparseCheckout command is called', () => {
      it('Then it delegates and returns a list result', async () => {
        // Arrange — the bound `sparseCheckout` strips `ctx`; a fresh repo has
        // sparse checkout disabled, so `list` returns the empty non-cone list.
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo' }, fallback);
        await sut.init();

        // Act
        const result = await sut.sparseCheckout.list();

        // Assert
        expect(result).toEqual({ cone: false, patterns: [] });
      });
    });
  });

  describe('Given a fresh repo and an initialised working tree', () => {
    describe('When grep is invoked', () => {
      it('Then it delegates and returns an empty result for no matches', async () => {
        // Arrange
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo' }, fallback);
        await sut.init();

        // Act
        const result = await sut.grep({ patterns: [{ fixed: 'hello' }] });

        // Assert
        expect(result).toEqual({ paths: [] });
      });
    });
  });

  describe('Given a fresh repo with an empty tree', () => {
    describe('When the bound submodule.list command is called', () => {
      it('Then it delegates and returns an empty list', async () => {
        // Arrange — write an empty tree and target it explicitly so the call does
        // not depend on an unborn HEAD; exercises the `submodule` namespace binding.
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo' }, fallback);
        await sut.init();
        const treeId = await sut.primitives.writeTree([]);

        // Act
        const result = await sut.submodule.list({ ref: treeId });

        // Assert
        expect(result).toEqual({ entries: [] });
      });
    });
  });

  describe('Given the bound walkSubmodules primitive', () => {
    describe('When iterated on an empty tree', () => {
      it('Then yields nothing', async () => {
        // Arrange
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo' }, fallback);
        await sut.init();
        const treeId = await sut.primitives.writeTree([]);

        // Act
        let count = 0;
        for await (const _ of sut.primitives.walkSubmodules({ ref: treeId })) count += 1;

        // Assert
        expect(count).toBe(0);
      });
    });
  });

  describe('Given the bound flattenTree primitive', () => {
    describe('When called on a single-file tree', () => {
      it('Then it delegates and returns a FlatTree with one entry', async () => {
        // Arrange
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo' }, fallback);
        await sut.init();
        const blobId = await sut.primitives.writeObject({
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('hi'),
        } satisfies Blob);
        const treeId = await sut.primitives.writeTree([
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, blobId),
        ]);

        // Act
        const result = await sut.primitives.flattenTree(treeId);

        // Assert
        expect(result.entries.get('a.txt' as FilePath)).toEqual({
          id: blobId,
          mode: FILE_MODE.REGULAR,
        });
      });
    });
  });

  describe('Given a stored blob', () => {
    describe('When the bound catFile command is called', () => {
      it('Then it returns the parsed entry', async () => {
        // Arrange
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo' }, fallback);
        await sut.init();
        const content = new TextEncoder().encode('hi');
        const blobId = await sut.primitives.writeObject({
          type: 'blob',
          id: '' as ObjectId,
          content,
        } satisfies Blob);

        // Act
        const result = await sut.catFile({ ids: [blobId] });

        // Assert
        expect(result.kind).toBe('batch');
        expect(result.entries).toHaveLength(1);
        const [entry] = result.entries;
        if (entry?.ok !== true) throw new Error('expected ok');
        expect(entry.size).toBe(content.byteLength);
      });
    });
  });

  describe('Given the bound catFileBatch primitive with maxBytes', () => {
    describe('When the blob exceeds the cap', () => {
      it('Then OBJECT_TOO_LARGE propagates (options forwarded by the binding)', async () => {
        // Arrange
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo' }, fallback);
        await sut.init();
        const id = await sut.primitives.writeObject({
          type: 'blob',
          id: '' as ObjectId,
          content: new Uint8Array([1, 2, 3, 4]),
        } satisfies Blob);

        // Act
        let caught: unknown;
        try {
          for await (const _ of sut.primitives.catFileBatch([id], { maxBytes: 2 })) {
            // No iterations expected — the read should reject pre-yield.
          }
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        if (!(caught instanceof TsgitError)) throw caught;
        expect(caught.data.code).toBe('OBJECT_TOO_LARGE');
      });
    });
  });

  describe('Given the bound catFileBatch primitive', () => {
    describe('When fed two ids', () => {
      it('Then yields entries in order', async () => {
        // Arrange
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo' }, fallback);
        await sut.init();
        const a = await sut.primitives.writeObject({
          type: 'blob',
          id: '' as ObjectId,
          content: new Uint8Array([1]),
        } satisfies Blob);
        const b = await sut.primitives.writeObject({
          type: 'blob',
          id: '' as ObjectId,
          content: new Uint8Array([2]),
        } satisfies Blob);

        // Act
        const ids: string[] = [];
        for await (const e of sut.primitives.catFileBatch([a, b])) ids.push(e.id);

        // Assert
        expect(ids).toEqual([a, b]);
      });
    });
  });
});

describe('openRepository — streamBlob smoke', () => {
  describe('Given a written blob', () => {
    describe('When sut.primitives.streamBlob is drained', () => {
      it('Then the concatenated bytes equal the original content', async () => {
        // Arrange
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo' }, fallback);
        await sut.init();
        const content = new Uint8Array([10, 20, 30, 40]);
        const id = await sut.primitives.writeObject({
          type: 'blob',
          id: '' as ObjectId,
          content,
        } satisfies Blob);

        // Act
        const stream = await sut.primitives.streamBlob(id);
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const result = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          result.set(c, off);
          off += c.length;
        }

        // Assert
        expect(result).toEqual(content);
      });
    });
  });
});

describe('openRepository — ctx fields', () => {
  describe('Given an opts.signal', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.signal is set and aborts when the user signal aborts', async () => {
        // Arrange
        const controller = new AbortController();

        // Act
        const sut = await openRepository(
          { cwd: '/repo', signal: controller.signal },
          makeFallback(),
        );

        // Assert
        expect(sut.ctx.signal).toBeDefined();
        expect(sut.ctx.signal?.aborted).toBe(false);

        // Act
        controller.abort();

        // Assert
        expect(sut.ctx.signal?.aborted).toBe(true);
      });
    });
  });

  describe('Given opts.config with parallelism', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.config carries the value and is frozen', async () => {
        // Arrange / Act
        const sut = await openRepository(
          { cwd: '/repo', config: { parallelism: 4 } },
          makeFallback(),
        );

        // Assert
        expect(sut.ctx.config).toBeDefined();
        expect(sut.ctx.config?.parallelism).toBe(4);
        expect(Object.isFrozen(sut.ctx.config)).toBe(true);
      });
    });
  });

  describe('Given opts.config is omitted', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.config is undefined (NOT a frozen empty object) — kills the always-deepFreeze mutant', async () => {
        // Arrange / Act
        const sut = await openRepository({ cwd: '/repo' }, makeFallback());

        // Assert
        expect(sut.ctx.config).toBeUndefined();
      });
    });
  });

  describe('Given opts.progress', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.progress is the user-supplied reporter', async () => {
        // Arrange
        const reporter = { start: vi.fn(), update: vi.fn(), end: vi.fn() };

        // Act
        const sut = await openRepository({ cwd: '/repo', progress: reporter }, makeFallback());

        // Assert
        expect(sut.ctx.progress).toBe(reporter);
      });
    });
  });

  describe('Given an opts.logger', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.logger is present (sanitizer-wrapped) — kills the empty-object spread mutant', async () => {
        // Arrange — the `{ logger: sanitizedLogger }` literal carries the logger
        // into ctx; a `{}` mutant would drop it entirely.
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        // Act
        const sut = await openRepository({ cwd: '/repo', logger }, makeFallback());
        sut.ctx.logger?.debug?.('debug-message');
        sut.ctx.logger?.info?.('info-message');
        sut.ctx.logger?.warn?.('warn-message');
        sut.ctx.logger?.error?.('error-message');

        // Assert — all four levels survive the wrap and forward to the inner sink.
        expect(logger.debug).toHaveBeenCalledWith('debug-message', undefined);
        expect(logger.info).toHaveBeenCalledWith('info-message', undefined);
        expect(logger.warn).toHaveBeenCalledWith('warn-message', undefined);
        expect(logger.error).toHaveBeenCalledWith('error-message', undefined);
      });
    });
  });

  describe('Given opts.logger is omitted', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.logger is undefined', async () => {
        // Arrange / Act
        const sut = await openRepository({ cwd: '/repo' }, makeFallback());

        // Assert
        expect(sut.ctx.logger).toBeUndefined();
      });
    });
  });
});

describe('openRepository — dispose macrotask scheduler', () => {
  describe('Given setImmediate is available', () => {
    describe('When dispose runs', () => {
      it('Then setImmediate is used and setTimeout(_, 0) is NOT used for the macrotask boundary', async () => {
        // Arrange — spy on both schedulers; the real branch must pick setImmediate.
        const immediateSpy = vi.spyOn(globalThis, 'setImmediate');
        const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const sut = await open();

        // Act
        await sut.dispose();

        // Assert — setImmediate scheduled at least once; setTimeout never called with delay 0.
        expect(immediateSpy).toHaveBeenCalled();
        const zeroDelayCalls = timeoutSpy.mock.calls.filter(([, delay]) => delay === 0);
        expect(zeroDelayCalls).toHaveLength(0);

        immediateSpy.mockRestore();
        timeoutSpy.mockRestore();
      });
    });
  });

  describe('Given setImmediate is unavailable', () => {
    describe('When dispose runs', () => {
      it('Then it still resolves via the setTimeout(0) fallback', async () => {
        // Arrange — remove setImmediate so the runtime-detection branch must fall
        // back to setTimeout. A mutant that unconditionally calls setImmediate would
        // throw (setImmediate is undefined) and dispose would reject.
        const sut = await open();
        vi.stubGlobal('setImmediate', undefined);

        // Act
        let caught: unknown;
        try {
          await sut.dispose();
        } catch (err) {
          caught = err;
        } finally {
          vi.unstubAllGlobals();
        }

        // Assert — fallback path completed cleanly.
        expect(caught).toBeUndefined();
      });
    });
  });
});

describe('openRepository — worktreeFs capability', () => {
  describe('Given a default-wrapped repo', () => {
    describe('When operating on a worktree-scoped fs under the worktree path', () => {
      it('Then the worktree path is a permitted root and write/read round-trips', async () => {
        // Arrange
        const sut = await open();
        const worktreeFs = worktreeScopedFs(sut, '/repo/wt');

        // Act — the worktree path lives outside the gitDir; only a roots array
        // that includes it admits this write. An empty roots array would reject.
        await worktreeFs.writeUtf8('/repo/wt/tracked.txt', 'inside');
        const roundTripped = await worktreeFs.readUtf8('/repo/wt/tracked.txt');

        // Assert
        expect(roundTripped).toBe('inside');
      });
    });

    describe('When accessing a path outside the worktree-scoped fs roots', () => {
      it('Then it is refused with PATHSPEC_OUTSIDE_REPO — the default (memory-runtime) fs is NOT branded first-party, so the wrapper stays the read-containment authority', async () => {
        // Arrange — MemoryFileSystem is single-rooted independently of the
        // layout, so unlike node it cannot license skipping the wrapper's
        // own read guard.
        const sut = await open();
        const worktreeFs = worktreeScopedFs(sut, '/repo/wt');

        // Act
        const code = await rejectionCode(() => worktreeFs.read('/outside/secret'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });

    describe('When accessing a path outside the worktree-scoped fs roots through a user-supplied (unbranded) fs', () => {
      it('Then the wrapper still rejects it with PATHSPEC_OUTSIDE_REPO — R3: unbranded behaviour is unchanged', async () => {
        // Arrange
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo', fs: fallback.fs }, fallback);
        const worktreeFs = worktreeScopedFs(sut, '/repo/wt');

        // Act
        const code = await rejectionCode(() => worktreeFs.read('/outside/secret'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given a linked-worktree path that is a sibling of workDir, not nested under it', () => {
    describe('When operating on a worktree-scoped fs under that worktree path', () => {
      it('Then the worktree path is admitted as a root and write/read round-trips', async () => {
        // Arrange — '/root' is the memory adapter's containment boundary;
        // layoutRoots minimizes to ['/root/repo'] (workDir), which does NOT
        // contain the sibling '/root/wt': only a roots array that explicitly
        // carries the worktree path admits this write.
        const fs = new MemoryFileSystem({ rootDir: '/root' });
        const fallback: RuntimeFallback = {
          ...makeFallback(),
          fs,
          layout: {
            workDir: '/root/repo',
            gitDir: '/root/repo/.git',
            bare: false,
            refStorage: 'files',
          },
        };
        const sut = await openRepository({ cwd: '/root/repo' }, fallback);
        const worktreeFs = worktreeScopedFs(sut, '/root/wt');

        // Act
        await worktreeFs.writeUtf8('/root/wt/tracked.txt', 'inside');
        const roundTripped = await worktreeFs.readUtf8('/root/wt/tracked.txt');

        // Assert
        expect(roundTripped).toBe('inside');
      });
    });
  });

  describe('Given unsafeRawAdapters: true and a custom fs', () => {
    describe('When resolving a worktree-scoped fs', () => {
      it('Then it returns the raw adapter unwrapped (reference-equal)', async () => {
        // Arrange
        const fallback = makeFallback();
        const innerFs = fallback.fs;
        const sut = await openRepository(
          { cwd: '/repo', fs: innerFs, unsafeRawAdapters: true },
          fallback,
        );

        // Act
        const worktreeFs = worktreeScopedFs(sut, '/repo/wt');

        // Assert — no wrapper layer: the returned fs IS the raw adapter.
        expect(worktreeFs).toBe(innerFs);
      });
    });
  });
});

describe('openRepository — layout.commonDir plumbing', () => {
  // '/root' is the memory adapter's own containment boundary; '/root/repo' and
  // '/root/common' are sibling subtrees of it — commonDir is unreachable
  // through a single-root workDir-only guard, but still inside the adapter's
  // own bound.
  const commonDirFallback = (fs: MemoryFileSystem): RuntimeFallback => ({
    ...makeFallback(),
    fs,
    layout: {
      workDir: '/root/repo',
      gitDir: '/root/repo/.git',
      bare: false,
      commonDir: '/root/common',
      refStorage: 'files',
    },
  });

  describe('Given a fallback.layout carrying commonDir (a linked-worktree shape)', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.layout.commonDir is populated from the fallback layout', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/root' });
        const fallback = commonDirFallback(fs);

        // Act
        const sut = await openRepository({ cwd: '/root/repo' }, fallback);

        // Assert
        expect(sut.ctx.layout.commonDir).toBe('/root/common');
      });
    });

    describe('When reading a path under commonDir through the wrapped fs', () => {
      it('Then it does not throw — commonDir is an admitted root', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/root' });
        await fs.mkdir('/root/common');
        await fs.writeUtf8('/root/common/HEAD', 'ref: refs/heads/main\n');
        const fallback = commonDirFallback(fs);
        const sut = await openRepository({ cwd: '/root/repo' }, fallback);

        // Act
        const result = await sut.ctx.fs.readUtf8('/root/common/HEAD');

        // Assert
        expect(result).toBe('ref: refs/heads/main\n');
      });
    });

    describe('When reading a path outside every layout root through a user-supplied (unbranded) fs', () => {
      it('Then it still throws PATHSPEC_OUTSIDE_REPO — R3: unbranded behaviour is unchanged', async () => {
        // Arrange — an explicit fs override keeps this fs unbranded, so both
        // layers still apply exactly as before this part.
        const fs = new MemoryFileSystem({ rootDir: '/root' });
        const fallback = commonDirFallback(fs);
        const sut = await openRepository({ cwd: '/root/repo', fs }, fallback);

        // Act
        const code = await rejectionCode(() => sut.ctx.fs.read('/root/outside/secret'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });

    describe('When reading that SAME path through the default (memory-runtime) fs', () => {
      it("Then it STILL throws PATHSPEC_OUTSIDE_REPO — memory is never branded, so the wrapper narrows to the layout's own roots ('/root/repo', '/root/common') regardless of the adapter's own wider construction root ('/root')", async () => {
        // Arrange — this fixture deliberately constructs the memory adapter at
        // a WIDER root ('/root') than the layout's own roots to prove the
        // wrapper — not the adapter — is the containment authority for
        // memory. The real memory runtime shim never constructs a
        // RuntimeFallback this way; this fixture exists to make the
        // authority observable.
        const fs = new MemoryFileSystem({ rootDir: '/root' });
        const fallback = commonDirFallback(fs);
        const sut = await openRepository({ cwd: '/root/repo' }, fallback);

        // Act
        const code = await rejectionCode(() => sut.ctx.fs.read('/root/outside/secret'));

        // Assert — the wrapper refuses before the adapter's own (wider) root
        // is ever consulted.
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });
  });
});

describe('openRepository — config-scope allowlist', () => {
  describe('Given a default-wrapped repo whose adapter exposes home, XDG and system config scopes', () => {
    describe('When accessing a config-scope or arbitrary path through the wrapped fs', () => {
      it.each([
        {
          path: '/home/user/.gitconfig',
          expectedCode: 'PERMISSION_DENIED',
          label:
            'the user home git config escapes the workDir guard and reaches the adapter (MemoryFileSystem defaults home to /home/user)',
        },
        {
          path: '/home/user/.config/git/config',
          expectedCode: 'PERMISSION_DENIED',
          label:
            'the XDG git config escapes the workDir guard and reaches the adapter (MemoryFileSystem defaults XDG to /home/user/.config)',
        },
        {
          path: '/etc/gitconfig',
          expectedCode: 'PERMISSION_DENIED',
          label:
            'the system git config escapes the workDir guard and reaches the adapter (MemoryFileSystem defaults the system config to /etc/gitconfig)',
        },
        {
          path: '/Stryker/was/here',
          expectedCode: 'PATHSPEC_OUTSIDE_REPO',
          label:
            'a non-config absolute path is rejected by the WRAPPER — memory is never branded, so its allowlist runs for the default fs too, and this path is in neither the allowlist nor the layout roots',
        },
      ])('Then $label', async ({ path, expectedCode }) => {
        // Arrange
        const sut = await open();

        // Act — memory is never branded first-party, so the wrapper's own
        // guard (allowlist + roots) runs first for every one of these four
        // paths. The three real config-scope paths are IN the allowlist, so
        // they still reach the adapter — whose own root ('/repo') then
        // rejects them, unchanged from before. The fourth path is in
        // neither the allowlist nor the roots, so the wrapper itself now
        // refuses it before the adapter is ever consulted.
        const code = await rejectionCode(() => sut.ctx.fs.read(path));

        // Assert
        expect(code).toBe(expectedCode);
      });
    });
  });

  describe('Given a user-supplied (unbranded) fs exposing the same config scopes', () => {
    describe('When accessing a non-config path through the wrapped fs', () => {
      it('Then the wrapper still rejects it with PATHSPEC_OUTSIDE_REPO — R3: unbranded behaviour is unchanged', async () => {
        // Arrange — an explicit fs override keeps this fs unbranded.
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo', fs: fallback.fs }, fallback);

        // Act — the allowlist admits only the computed config scopes; the wrapper's
        // own guard (not the adapter) rejects this non-config path first.
        const code = await rejectionCode(() => sut.ctx.fs.read('/Stryker/was/here'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given a Context branded first-party (node runtime, default fs) whose adapter root is wider than layoutRoots', () => {
    describe("When reading a path inside the adapter's own root but outside layoutRoots", () => {
      it("Then the read succeeds — guardReads must be false, deferring to the first-party adapter's own (wider) containment", async () => {
        // Arrange — isFirstPartyFs brands the fs only when composeAdapters
        // sources it from a 'node'-runtime fallback with no opts.fs
        // override; a MemoryFileSystem masquerading as that runtime is
        // branded all the same (the signal is provenance, not class).
        // Its own root ('/root') is wider than layoutRoots (['/root/repo']
        // only), so this path is reachable ONLY when the wrapper's own
        // (narrower) read guard is skipped in favour of the adapter's own.
        const fs = new MemoryFileSystem({ rootDir: '/root' });
        await fs.writeUtf8(
          '/root/sibling-file.txt',
          'outside layoutRoots, inside the adapter root',
        );
        const fallback: RuntimeFallback = {
          ...makeFallback(),
          fs,
          runtime: 'node',
          layout: {
            workDir: '/root/repo',
            gitDir: '/root/repo/.git',
            bare: false,
            refStorage: 'files',
          },
        };
        const sut = await openRepository({ cwd: '/root/repo' }, fallback);

        // Act
        const content = await sut.ctx.fs.readUtf8('/root/sibling-file.txt');

        // Assert
        expect(content).toBe('outside layoutRoots, inside the adapter root');
      });
    });
  });

  describe('Given a Context branded first-party (node runtime, default fs) reading a worktree-scoped fs', () => {
    describe("When reading a path inside the adapter's own root but outside the worktree-scoped roots", () => {
      it("Then the read succeeds — worktreeFs's own guardReads must be false too, deferring to the first-party adapter", async () => {
        // Arrange — mirrors the top-level detected.fs case, but for
        // worktreeFs's own wrapFsValidator call: worktreeRawIsFirstParty
        // is true here purely via `|| fsIsFirstParty` (no makeWorktreeFs
        // capability supplied), so raw falls back to the SAME
        // first-party-branded fs.
        const fs = new MemoryFileSystem({ rootDir: '/root' });
        await fs.writeUtf8(
          '/root/other-sibling.txt',
          'outside worktree-scoped roots, inside the adapter root',
        );
        const fallback: RuntimeFallback = {
          ...makeFallback(),
          fs,
          runtime: 'node',
          layout: {
            workDir: '/root/repo',
            gitDir: '/root/repo/.git',
            bare: false,
            refStorage: 'files',
          },
        };
        const sut = await openRepository({ cwd: '/root/repo' }, fallback);
        const worktreeFs = worktreeScopedFs(sut, '/root/wt');

        // Act
        const content = await worktreeFs.readUtf8('/root/other-sibling.txt');

        // Assert
        expect(content).toBe('outside worktree-scoped roots, inside the adapter root');
      });
    });
  });

  describe('Given fallback.makeWorktreeFs is supplied while the top-level fs is NOT first-party (memory runtime)', () => {
    describe("When reading a path inside the makeWorktreeFs-supplied adapter's own (wider) root but outside the worktree-scoped roots", () => {
      it('Then the read succeeds — makeWorktreeFs alone must brand the worktree raw fs as first-party, independent of fsIsFirstParty', async () => {
        // Arrange — makeWorktreeFs's presence is documented as its own,
        // sufficient, first-party signal (never re-derived from
        // isFirstPartyFs on its return value); this pins that the `||`
        // really does let EITHER operand carry it.
        const rootFs = new MemoryFileSystem({ rootDir: '/root' });
        await rootFs.writeUtf8(
          '/root/other-sibling.txt',
          'reachable only via makeWorktreeFs branding alone',
        );
        const fallback: RuntimeFallback = {
          ...makeFallback(),
          makeWorktreeFs: () => rootFs,
        };
        const sut = await openRepository({ cwd: '/repo' }, fallback);
        const worktreeFs = worktreeScopedFs(sut, '/root/wt');

        // Act
        const content = await worktreeFs.readUtf8('/root/other-sibling.txt');

        // Assert
        expect(content).toBe('reachable only via makeWorktreeFs branding alone');
      });
    });
  });

  describe('Given a default-wrapped repo whose adapter config-path probes all throw', () => {
    const openUnavailable = (): Promise<Repository> =>
      openRepository(
        { cwd: '/repo' },
        { ...makeFallback(), fs: new UnavailableConfigFs({ rootDir: '/repo' }) },
      );

    describe('When openRepository runs', () => {
      it('Then it resolves — unavailable config scopes are skipped, not fatal', async () => {
        // Arrange — a repo whose adapter config-path probes all throw
        const sut = await openUnavailable();

        // Act
        const fs = sut.ctx.fs;

        // Assert — openRepository resolved; a system scope pushed unconditionally
        // would inject `undefined` into the allowlist and crash sanitisation.
        expect(fs).toBeDefined();
      });
    });

    describe('When accessing the unavailable home config scope through the default (memory-runtime) fs', () => {
      it('Then the wrapper rejects it with PATHSPEC_OUTSIDE_REPO — no path in the allowlist admitted it, and memory is never branded so the wrapper guards this read too', async () => {
        // Arrange
        const sut = await openUnavailable();

        // Act — an unconditional home push would have admitted this
        // stringified scope into the wrapper's allowlist; it did not, and
        // the relative-shaped probe 'undefined/.gitconfig' is not contained
        // in any layout root either, so the wrapper refuses it before the
        // adapter is ever consulted. No real home-config content is ever
        // reached.
        const code = await rejectionCode(() => sut.ctx.fs.read('undefined/.gitconfig'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });

    describe('When accessing the unavailable home config scope through a user-supplied (unbranded) fs', () => {
      it('Then the wrapper still rejects it with PATHSPEC_OUTSIDE_REPO — R3: unbranded behaviour is unchanged', async () => {
        // Arrange
        const fallback = { ...makeFallback(), fs: new UnavailableConfigFs({ rootDir: '/repo' }) };
        const sut = await openRepository({ cwd: '/repo', fs: fallback.fs }, fallback);

        // Act — an unconditional home push would admit this stringified scope.
        const code = await rejectionCode(() => sut.ctx.fs.read('undefined/.gitconfig'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });

    describe('When accessing the unavailable XDG config scope through the default (memory-runtime) fs', () => {
      it('Then the wrapper rejects it with PATHSPEC_OUTSIDE_REPO — same reasoning as the home scope above', async () => {
        // Arrange
        const sut = await openUnavailable();

        // Act
        const code = await rejectionCode(() => sut.ctx.fs.read('undefined/git/config'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });

    describe('When accessing the unavailable XDG config scope through a user-supplied (unbranded) fs', () => {
      it('Then the wrapper still rejects it with PATHSPEC_OUTSIDE_REPO — R3: unbranded behaviour is unchanged', async () => {
        // Arrange
        const fallback = { ...makeFallback(), fs: new UnavailableConfigFs({ rootDir: '/repo' }) };
        const sut = await openRepository({ cwd: '/repo', fs: fallback.fs }, fallback);

        // Act — an unconditional XDG push would admit this stringified scope.
        const code = await rejectionCode(() => sut.ctx.fs.read('undefined/git/config'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });
  });
});

describe('openRepository — object algorithm resolution', () => {
  const fallbackWithDeclaredFormat = (objectFormat: 'sha1' | 'sha256'): RuntimeFallback => ({
    ...makeFallback(),
    layout: {
      workDir: '/repo',
      gitDir: '/repo/.git',
      bare: false,
      objectFormat,
      refStorage: 'files',
    },
  });

  describe('Given a repository whose layout declares extensions.objectFormat = sha256', () => {
    describe('When openRepository runs with no algorithm option', () => {
      it("Then ctx.hashConfig.algorithm is 'sha256' and ctx.hash.algorithm is 'sha256' (the layout channel)", async () => {
        // Arrange
        const fallback = fallbackWithDeclaredFormat('sha256');

        // Act
        const sut = await openRepository({ cwd: '/repo' }, fallback);

        // Assert — the fallback's own default hash service (sha1) is upgraded
        // via withAlgorithm to match the declared format.
        expect(sut.ctx.hashConfig.algorithm).toBe('sha256');
        expect(sut.ctx.hash.algorithm).toBe('sha256');
      });
    });

    describe('When openRepository is called with algorithm: sha256', () => {
      it('Then it opens (agreement is not a conflict)', async () => {
        // Arrange
        const fallback = fallbackWithDeclaredFormat('sha256');

        // Act
        const sut = await openRepository({ cwd: '/repo', algorithm: 'sha256' }, fallback);

        // Assert
        expect(sut.ctx.hashConfig.algorithm).toBe('sha256');
      });
    });
  });

  describe('Given no declared format and no algorithm option (the default)', () => {
    describe('When openRepository runs', () => {
      it("Then ctx.hashConfig is SHA1_CONFIG and ctx.hash is the fallback's own instance unchanged", async () => {
        // Arrange
        const fallback = makeFallback();

        // Act
        const sut = await openRepository({ cwd: '/repo' }, fallback);

        // Assert — R6: default stays sha1; no upgrade needed, so the fallback's
        // own hash instance is reused (kills a mutant that always upgrades).
        expect(sut.ctx.hashConfig).toBe(SHA1_CONFIG);
        expect(sut.ctx.hash).toBe(fallback.hash);
      });
    });
  });

  describe('Given the algorithm option disagrees with the declared format', () => {
    describe('When openRepository runs', () => {
      it('Then throws OBJECT_FORMAT_CONFLICT{ requested: option, declared, source: "option" }', async () => {
        // Arrange
        const fallback = fallbackWithDeclaredFormat('sha1');
        let caught: unknown;

        // Act
        try {
          await openRepository({ cwd: '/repo', algorithm: 'sha256' }, fallback);
          expect.fail('expected OBJECT_FORMAT_CONFLICT');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_FORMAT_CONFLICT',
          requested: 'sha256',
          declared: 'sha1',
          source: 'option',
        });
      });
    });
  });

  describe('Given a caller-supplied hash algorithm disagrees with the declared format', () => {
    describe('When openRepository runs', () => {
      it('Then throws OBJECT_FORMAT_CONFLICT{ requested: hash, declared, source: "hash" }', async () => {
        // Arrange
        const fallback = fallbackWithDeclaredFormat('sha1');
        let caught: unknown;

        // Act
        try {
          await openRepository({ cwd: '/repo', hash: new MemoryHashService('sha256') }, fallback);
          expect.fail('expected OBJECT_FORMAT_CONFLICT');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_FORMAT_CONFLICT',
          requested: 'sha256',
          declared: 'sha1',
          source: 'hash',
        });
      });
    });
  });

  describe('Given a caller-supplied hash algorithm disagrees with the algorithm option', () => {
    describe('When openRepository runs', () => {
      it('Then throws OBJECT_FORMAT_CONFLICT{ requested: hash, declared: option, source: "hash" }', async () => {
        // Arrange
        let caught: unknown;

        // Act
        try {
          await openRepository(
            { cwd: '/repo', algorithm: 'sha1', hash: new MemoryHashService('sha256') },
            makeFallback(),
          );
          expect.fail('expected OBJECT_FORMAT_CONFLICT');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_FORMAT_CONFLICT',
          requested: 'sha256',
          declared: 'sha1',
          source: 'hash',
        });
      });
    });
  });

  describe("Given today's desync bug shape — a caller-supplied sha256 hash on a plain sha1 repository", () => {
    describe('When openRepository runs', () => {
      it('Then it refuses instead of silently pairing ctx.hash=sha256 with ctx.hashConfig=SHA1_CONFIG', async () => {
        // Arrange — a plain repository (declared sha1), no algorithm option —
        // the exact desync that existed before this reconciliation: ctx.hash
        // reporting sha256 paired with ctx.hashConfig staying SHA1_CONFIG.
        const fallback = fallbackWithDeclaredFormat('sha1');

        // Act
        const rejection = await openRepository(
          { cwd: '/repo', hash: new MemoryHashService('sha256') },
          fallback,
        ).catch((err: unknown) => err);

        // Assert
        expect(rejection).toBeInstanceOf(TsgitError);
        expect((rejection as TsgitError).data.code).toBe('OBJECT_FORMAT_CONFLICT');
      });
    });
  });
});

describe('openRepository — memory-runtime read containment stays wrapper-authoritative', () => {
  describe('Given the default (memory-runtime) fs and an in-repo read path containing a `..` segment that collapses back inside the roots', () => {
    describe('When the path is read', () => {
      it("Then it is STILL refused with PATHSPEC_OUTSIDE_REPO — memory is never branded, so the wrapper guards this read and refuses any `..` segment outright, before the adapter's own collapsing logic ever runs", async () => {
        // Arrange
        const sut = await open();
        await sut.ctx.fs.mkdir('/repo/sub');
        await sut.ctx.fs.writeUtf8('/repo/target.txt', 'collapsed-and-contained');

        // Act
        const code = await rejectionCode(() => sut.ctx.fs.readUtf8('/repo/sub/../target.txt'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given a user-supplied (unbranded) fs and the same `..`-collapsing-inside path', () => {
    describe('When the path is read', () => {
      it('Then it is STILL refused with PATHSPEC_OUTSIDE_REPO — R3: unbranded behaviour is unchanged', async () => {
        // Arrange
        const fallback = makeFallback();
        const sut = await openRepository({ cwd: '/repo', fs: fallback.fs }, fallback);
        await sut.ctx.fs.mkdir('/repo/sub');
        await sut.ctx.fs.writeUtf8('/repo/target.txt', 'collapsed-and-contained');

        // Act
        const code = await rejectionCode(() => sut.ctx.fs.readUtf8('/repo/sub/../target.txt'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given the default (memory-runtime) fs and a write to the same `..`-collapsing-inside path', () => {
    describe('When the write runs', () => {
      it('Then it is STILL refused with PATHSPEC_OUTSIDE_REPO — writes always take the wrapper guard, branding or not', async () => {
        // Arrange
        const sut = await open();
        await sut.ctx.fs.mkdir('/repo/sub');

        // Act
        const code = await rejectionCode(() =>
          sut.ctx.fs.writeUtf8('/repo/sub/../evil.txt', 'should never land'),
        );

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given the default (memory-runtime) fs and a config-scope path (home/XDG/system)', () => {
    describe('When the config primitive reads the global scope', () => {
      it('Then it resolves to an empty array, not a throw — the wrapper allowlist admits the path, and the adapter refusal beyond it is caught exactly like a missing file', async () => {
        // Arrange — MemoryFileSystem defaults home to /home/user, outside the
        // repository roots. The wrapper's allowlist admits this exact
        // config-scope path (computeConfigScopePaths), so the read reaches
        // the adapter — whose own root ('/repo') then refuses it with
        // PERMISSION_DENIED; the config primitive already tolerates that
        // code alongside FILE_NOT_FOUND.
        const sut = await open();

        // Act
        const sections = await readConfigSections({ ctx: sut.ctx, scope: 'global' });

        // Assert
        expect(sections).toEqual([]);
      });
    });

    describe('When the config primitive reads the system scope', () => {
      it('Then it also resolves to an empty array, not a throw', async () => {
        // Arrange
        const sut = await open();

        // Act
        const sections = await readConfigSections({ ctx: sut.ctx, scope: 'system' });

        // Assert
        expect(sections).toEqual([]);
      });
    });
  });
});

describe('openRepository — worktreeFs memoisation', () => {
  describe('Given repeated worktreeFs calls for the same root set', () => {
    describe('When the capability is invoked twice with the same worktree path', () => {
      it('Then the returned fs is built once — the two calls are reference-equal', async () => {
        // Arrange
        const sut = await open();

        // Act
        const first = worktreeScopedFs(sut, '/repo/wt');
        const second = worktreeScopedFs(sut, '/repo/wt');

        // Assert
        expect(second).toBe(first);
      });
    });

    describe('When the capability is invoked with a different worktree path', () => {
      it('Then a NEW fs is built — the cache key is the root set, not a constant', async () => {
        // Arrange
        const sut = await open();

        // Act
        const first = worktreeScopedFs(sut, '/repo/wt-a');
        const second = worktreeScopedFs(sut, '/repo/wt-b');

        // Assert
        expect(second).not.toBe(first);
      });
    });

    describe('When invoked with two distinct root arrays that concatenate to the identical string without a separator', () => {
      it('Then it still builds and caches DISTINCT fs instances — the cache key must not collide two different root sets', async () => {
        // Arrange — ['/ab'] and ['/a', 'b'] are different root arrays, but
        // Array.prototype.join('') folds both (plus the shared layoutRoots
        // tail) to the identical string; only a real separator (e.g. '\0',
        // never a legal path character) keeps them apart.
        const sut = await open();
        const factory = sut.ctx.worktreeFs;
        if (factory === undefined) throw new Error('worktreeFs capability missing');

        // Act
        const fsA = factory(['/ab']);
        const fsB = factory(['/a', 'b']);

        // Assert
        expect(fsB).not.toBe(fsA);
      });
    });
  });
});
