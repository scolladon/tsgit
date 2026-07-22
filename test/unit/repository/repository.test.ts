import { describe, expect, it, vi } from 'vitest';

import {
  MemoryCommandRunner,
  MemoryCompressor,
  MemoryFileSystem,
  MemoryHashService,
  MemoryHookRunner,
  MemoryHttpTransport,
} from '../../../src/adapters/memory/index.js';
import { TsgitError } from '../../../src/domain/error.js';
import { SHA1_CONFIG } from '../../../src/domain/objects/hash-config.js';
import type { Blob, ObjectId } from '../../../src/domain/objects/index.js';
import { createLruCache } from '../../../src/domain/storage/lru-cache.js';
import type { FileSystem } from '../../../src/ports/file-system.js';
import { openRepository, type Repository, type RuntimeFallback } from '../../../src/repository.js';

const makeFallback = (): RuntimeFallback => ({
  fs: new MemoryFileSystem({ rootDir: '/repo' }),
  hash: new MemoryHashService('sha1'),
  compressor: new MemoryCompressor(),
  transport: new MemoryHttpTransport(),
  runtime: 'memory',
  layout: { workDir: '/repo', gitDir: '/repo/.git', bare: false },
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
        // Arrange
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
        // Arrange
        const sut = await open();

        // Assert
        expect(Object.isFrozen(sut)).toBe(true);
        expect(Object.isFrozen(sut.primitives)).toBe(true);
      });
    });
    describe('When inspecting ctx', () => {
      it('Then ctx is frozen', async () => {
        // Arrange
        const sut = await open();

        // Assert
        expect(Object.isFrozen(sut.ctx)).toBe(true);
      });
    });
    describe('When inspecting the blame binding', () => {
      it('Then repo.blame is a bound function', async () => {
        // Arrange
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
        // Arrange
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

        const sut = await open({ hooks: runner });

        // Assert
        expect(sut.ctx.hooks).toBe(runner);
      });
    });
  });

  describe('Given hooks: false and a fallback that supplies a runner', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.hooks is undefined', async () => {
        // Arrange
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

        const sut = await open({ command: runner });

        // Assert
        expect(sut.ctx.command).toBe(runner);
      });
    });
  });

  describe('Given command: false and a fallback that supplies a runner', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.command is undefined', async () => {
        // Arrange
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
        // Arrange
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
            'log',
            'merge',
            'mv',
            'nameRev',
            'notes',
            'primitives',
            'pull',
            'push',
            'readFileAt',
            'rangeDiff',
            'rebase',
            'reflog',
            'remote',
            'reset',
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
        // Arrange
        const sut = await open();

        // Assert
        expect(Object.keys(sut.primitives).sort()).toEqual(
          [
            'bisectMidpoint',
            'catFileBatch',
            'createCommit',
            'diffTrees',
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
        const nonFunctionKeys = new Set(['ctx', 'primitives', 'snapshot', ...namespaceKeys]);

        for (const key of Object.keys(sut)) {
          if (nonFunctionKeys.has(key)) continue;
          // Assert
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
        // Arrange
        try {
          await openRepository({ cwd: 'relative' }, makeFallback());
          // Assert
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
        // Arrange
        try {
          await openRepository({ cwd: '/repo', config: { parallelism: 0 } }, makeFallback());
          // Assert
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

        await sut.dispose();
        // After dispose, init MUST throw REPOSITORY_DISPOSED.
        try {
          await sut.init();
          // Assert
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
        // Arrange
        const sut = await open();

        // Assert — the port must expose `.fetch(oids)`; a `{}` mutant on the
        // construction site would survive a bare `toBeDefined()`.
        expect(typeof sut.ctx.promisor?.fetch).toBe('function');
      });
    });
  });

  describe('Given a disposed repo', () => {
    describe('When fetchMissing is invoked', () => {
      it('Then throws REPOSITORY_DISPOSED', async () => {
        // Arrange
        const sut = await open();

        await sut.dispose();
        try {
          await sut.fetchMissing({ oids: [] });
          // Assert
          expect.unreachable();
        } catch (err) {
          const data = (err as TsgitError).data;
          expect(data.code).toBe('REPOSITORY_DISPOSED');
        }
      });
    });
    describe('When grep is invoked', () => {
      it('Then throws REPOSITORY_DISPOSED', async () => {
        // Arrange
        const sut = await open();

        await sut.dispose();
        try {
          await sut.grep({ patterns: [{ fixed: 'hello' }] });
          // Assert
          expect.unreachable();
        } catch (err) {
          const data = (err as TsgitError).data;
          expect(data.code).toBe('REPOSITORY_DISPOSED');
        }
      });
    });
    describe('When dispose is called again', () => {
      it('Then resolves without throwing (idempotent)', async () => {
        // Arrange
        const sut = await open();

        await sut.dispose();
        // Assert
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

        await Promise.all([sut.dispose(), sut.dispose(), sut.dispose()]);

        // Assert
        expect(disposeCalls).toBe(1);
      });
    });
  });

  describe('Given dispose has been called', () => {
    describe('When any bound primitive is invoked', () => {
      it('Then throws REPOSITORY_DISPOSED', async () => {
        // Arrange
        const sut = await open();

        await sut.dispose();
        try {
          await sut.primitives.readIndex();
          // Assert
          expect.unreachable();
        } catch (err) {
          const data = (err as TsgitError).data;
          expect(data.code).toBe('REPOSITORY_DISPOSED');
        }
      });
    });
  });

  describe('Given a Repository handle', () => {
    describe('When the merge namespace is accessed', () => {
      it('Then run / continue / abort are all functions', async () => {
        // Arrange
        const sut = await open();

        // Assert
        expect(typeof sut.merge.run).toBe('function');
        expect(typeof sut.merge.continue).toBe('function');
        expect(typeof sut.merge.abort).toBe('function');
      });
    });
  });

  describe('Given a disposed Repository', () => {
    describe('When merge.abort is invoked', () => {
      it('Then throws REPOSITORY_DISPOSED', async () => {
        // Arrange
        const sut = await open();
        await sut.dispose();

        // Act
        let caught: unknown;
        try {
          await sut.merge.abort();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('REPOSITORY_DISPOSED');
      });
    });
    describe('When merge.continue is invoked', () => {
      it('Then throws REPOSITORY_DISPOSED', async () => {
        // Arrange
        const sut = await open();
        await sut.dispose();

        // Act
        let caught: unknown;
        try {
          await sut.merge.continue();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('REPOSITORY_DISPOSED');
      });
    });
    describe('When merge.run is invoked', () => {
      it('Then throws REPOSITORY_DISPOSED', async () => {
        // Arrange
        const sut = await open();
        await sut.dispose();

        // Act
        let caught: unknown;
        try {
          await sut.merge.run({ rev: 'feature' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('REPOSITORY_DISPOSED');
      });
    });
    describe('When show is invoked', () => {
      it('Then throws REPOSITORY_DISPOSED', async () => {
        // Arrange
        const sut = await open();
        await sut.dispose();

        // Act
        let caught: unknown;
        try {
          await sut.show();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('REPOSITORY_DISPOSED');
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
        try {
          await sut.init();
          // Assert
          expect.unreachable();
        } catch (err) {
          const data = (err as TsgitError).data;
          expect(data.code).toBe('REPOSITORY_DISPOSED');
        }
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

        try {
          // Bypass type-system: invoke wrapped fs directly with an out-of-cwd path.
          await sut.ctx.fs.write('/etc/passwd', new Uint8Array(0));
          // Assert
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
        const sut = await openRepository(
          { cwd: '/repo', signal: controller.signal },
          makeFallback(),
        );

        // Assert
        expect(sut.ctx.signal).toBeDefined();
        expect(sut.ctx.signal?.aborted).toBe(false);
        controller.abort();
        expect(sut.ctx.signal?.aborted).toBe(true);
      });
    });
  });

  describe('Given opts.config with parallelism', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.config carries the value and is frozen', async () => {
        // Arrange
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
        // Arrange
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
        const sut = await openRepository({ cwd: '/repo', progress: reporter }, makeFallback());

        // Assert
        expect(sut.ctx.progress).toBe(reporter);
      });
    });
  });

  describe('Given an opts.logger', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.logger is present (sanitizer-wrapped) — kills the empty-object spread mutant', async () => {
        // Arrange
        // The `{ logger: sanitizedLogger }` literal carries the logger into ctx;
        // a `{}` mutant would drop it entirely.
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const sut = await openRepository({ cwd: '/repo', logger }, makeFallback());

        // Assert — all four levels survive the wrap and forward to the inner sink.
        sut.ctx.logger?.debug?.('debug-message');
        sut.ctx.logger?.info?.('info-message');
        sut.ctx.logger?.warn?.('warn-message');
        sut.ctx.logger?.error?.('error-message');
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
        // Arrange
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
      it('Then the wrapper rejects it with PATHSPEC_OUTSIDE_REPO', async () => {
        // Arrange
        const sut = await open();
        const worktreeFs = worktreeScopedFs(sut, '/repo/wt');

        // Act — an unwrapped raw adapter would surface its own error instead.
        const code = await rejectionCode(() => worktreeFs.read('/outside/secret'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
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

describe('openRepository — config-scope allowlist', () => {
  describe('Given a default-wrapped repo whose adapter exposes home, XDG and system config scopes', () => {
    describe('When accessing the user home git config through the wrapped fs', () => {
      it('Then it escapes the workDir guard and reaches the adapter', async () => {
        // Arrange — MemoryFileSystem defaults home to '/home/user'.
        const sut = await open();

        // Act — '/home/user/.gitconfig' is outside workDir; only the config-scope
        // allowlist admits it. Reaching the adapter yields its own out-of-root
        // PERMISSION_DENIED; a blocked path would raise PATHSPEC_OUTSIDE_REPO.
        const code = await rejectionCode(() => sut.ctx.fs.read('/home/user/.gitconfig'));

        // Assert
        expect(code).toBe('PERMISSION_DENIED');
      });
    });

    describe('When accessing the XDG git config through the wrapped fs', () => {
      it('Then it escapes the workDir guard and reaches the adapter', async () => {
        // Arrange — MemoryFileSystem defaults XDG to '/home/user/.config'.
        const sut = await open();

        // Act
        const code = await rejectionCode(() => sut.ctx.fs.read('/home/user/.config/git/config'));

        // Assert
        expect(code).toBe('PERMISSION_DENIED');
      });
    });

    describe('When accessing the system git config through the wrapped fs', () => {
      it('Then it escapes the workDir guard and reaches the adapter', async () => {
        // Arrange — MemoryFileSystem defaults the system config to '/etc/gitconfig'.
        const sut = await open();

        // Act
        const code = await rejectionCode(() => sut.ctx.fs.read('/etc/gitconfig'));

        // Assert
        expect(code).toBe('PERMISSION_DENIED');
      });
    });

    describe('When accessing a non-config path outside the repo', () => {
      it('Then it is rejected — the allowlist admits only the computed config scopes', async () => {
        // Arrange
        const sut = await open();

        // Act — proves the allowlist base is empty: no phantom entry is admitted.
        const code = await rejectionCode(() => sut.ctx.fs.read('Stryker was here'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
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

    describe('When accessing the unavailable home config scope through the wrapped fs', () => {
      it('Then it is not admitted to the allowlist', async () => {
        // Arrange
        const sut = await openUnavailable();

        // Act — an unconditional home push would admit this stringified scope.
        const code = await rejectionCode(() => sut.ctx.fs.read('undefined/.gitconfig'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });

    describe('When accessing the unavailable XDG config scope through the wrapped fs', () => {
      it('Then it is not admitted to the allowlist', async () => {
        // Arrange
        const sut = await openUnavailable();

        // Act — an unconditional XDG push would admit this stringified scope.
        const code = await rejectionCode(() => sut.ctx.fs.read('undefined/git/config'));

        // Assert
        expect(code).toBe('PATHSPEC_OUTSIDE_REPO');
      });
    });
  });
});
