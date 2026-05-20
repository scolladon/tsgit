import { describe, expect, it, vi } from 'vitest';

import {
  MemoryCompressor,
  MemoryFileSystem,
  MemoryHashService,
  MemoryHttpTransport,
} from '../../../src/adapters/memory/index.js';
import { TsgitError } from '../../../src/domain/error.js';
import { SHA1_CONFIG } from '../../../src/domain/objects/hash-config.js';
import { createLruCache } from '../../../src/domain/storage/lru-cache.js';
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

describe('openRepository — construction', () => {
  it('Given a fallback set and no overrides, When openRepository runs, Then resolves to a Repository handle', async () => {
    const sut = await open();

    expect(sut).toBeDefined();
    expect(typeof sut.dispose).toBe('function');
  });

  it('Given the returned handle, When inspecting it, Then it is frozen', async () => {
    const sut = await open();

    expect(Object.isFrozen(sut)).toBe(true);
    expect(Object.isFrozen(sut.primitives)).toBe(true);
  });

  it('Given the returned handle, When inspecting ctx, Then ctx is frozen', async () => {
    const sut = await open();

    expect(Object.isFrozen(sut.ctx)).toBe(true);
  });
});

describe('openRepository — Repository binding integrity', () => {
  it('Given the returned handle, When listing top-level keys, Then they exactly match the documented surface', async () => {
    const sut = await open();

    expect(Object.keys(sut).sort()).toEqual(
      [
        'add',
        'branch',
        'checkout',
        'clone',
        'commit',
        'ctx',
        'diff',
        'dispose',
        'fetch',
        'init',
        'log',
        'merge',
        'primitives',
        'push',
        'reset',
        'revParse',
        'rm',
        'status',
        'tag',
      ].sort(),
    );
  });

  it('Given the returned handle, When listing primitives, Then they match the documented Tier-2 surface', async () => {
    const sut = await open();

    expect(Object.keys(sut.primitives).sort()).toEqual(
      [
        'createCommit',
        'diffTrees',
        'getRepoRoot',
        'mergeBase',
        'readBlob',
        'readIndex',
        'readObject',
        'readTree',
        'resolveRef',
        'updateRef',
        'walkCommits',
        'walkTree',
        'walkWorkingTree',
        'writeObject',
        'writeSymbolicRef',
        'writeTree',
      ].sort(),
    );
  });

  it('Given the returned handle, When typeof every binding is checked, Then each is a function', async () => {
    const sut = await open();

    for (const key of Object.keys(sut)) {
      if (key === 'ctx' || key === 'primitives') continue;
      expect(typeof (sut as unknown as Record<string, unknown>)[key]).toBe('function');
    }
    for (const key of Object.keys(sut.primitives)) {
      expect(typeof (sut.primitives as unknown as Record<string, unknown>)[key]).toBe('function');
    }
  });
});

describe('openRepository — INVALID_OPTION validation', () => {
  it('Given a relative cwd, When openRepository runs, Then throws INVALID_OPTION with .data.option === cwd', async () => {
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

  it('Given parallelism = 0, When openRepository runs, Then throws INVALID_OPTION', async () => {
    try {
      await openRepository({ cwd: '/repo', config: { parallelism: 0 } }, makeFallback());
      expect.unreachable();
    } catch (err) {
      const data = (err as TsgitError).data;
      expect(data.code).toBe('INVALID_OPTION');
    }
  });
});

describe('openRepository — dispose state machine', () => {
  it('Given a fresh repo, When dispose is called, Then state transitions to DISPOSED', async () => {
    const sut = await open();

    await sut.dispose();
    // After dispose, init MUST throw REPOSITORY_DISPOSED.
    try {
      await sut.init();
      expect.unreachable();
    } catch (err) {
      const data = (err as TsgitError).data;
      expect(data.code).toBe('REPOSITORY_DISPOSED');
    }
  });

  it('Given a disposed repo, When dispose is called again, Then resolves without throwing (idempotent)', async () => {
    const sut = await open();

    await sut.dispose();
    await expect(sut.dispose()).resolves.toBeUndefined();
  });

  it('Given a port that increments a counter on dispose AND two concurrent dispose calls, When awaited, Then dispose is called EXACTLY ONCE on that port', async () => {
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

    expect(disposeCalls).toBe(1);
  });

  it('Given dispose has been called, When any bound primitive is invoked, Then throws REPOSITORY_DISPOSED', async () => {
    const sut = await open();

    await sut.dispose();
    try {
      await sut.primitives.readIndex();
      expect.unreachable();
    } catch (err) {
      const data = (err as TsgitError).data;
      expect(data.code).toBe('REPOSITORY_DISPOSED');
    }
  });

  it('Given a user-supplied signal that aborts before dispose, When a bound method is invoked, Then it throws REPOSITORY_DISPOSED via the atomic gate', async () => {
    const controller = new AbortController();
    const sut = await openRepository({ cwd: '/repo', signal: controller.signal }, makeFallback());

    controller.abort();
    try {
      await sut.init();
      expect.unreachable();
    } catch (err) {
      const data = (err as TsgitError).data;
      expect(data.code).toBe('REPOSITORY_DISPOSED');
    }
  });
});

describe('openRepository — unsafeRawAdapters', () => {
  it('Given unsafeRawAdapters: true and a custom fs, When the wrapped fs is read from ctx, Then it is reference-equal to the user-supplied fs (no wrapper layer in between) — kills mutants on the wrapping condition', async () => {
    // Reference-equality is a stronger probe than behavioral: if wrapping is
    // applied, ctx.fs is a NEW object (the wrapper); without wrapping, ctx.fs
    // IS the user-supplied object.
    const fallback = makeFallback();
    const innerFs = fallback.fs;
    const sut = await openRepository(
      { cwd: '/repo', fs: innerFs, unsafeRawAdapters: true },
      fallback,
    );

    expect(sut.ctx.fs).toBe(innerFs);
  });

  it('Given unsafeRawAdapters: false (default) and a custom fs, When the wrapped fs is read from ctx, Then it is NOT reference-equal to the user-supplied fs (wrapper applied)', async () => {
    const fallback = makeFallback();
    const innerFs = fallback.fs;
    const sut = await openRepository({ cwd: '/repo', fs: innerFs }, fallback);

    expect(sut.ctx.fs).not.toBe(innerFs);
  });

  it('Given unsafeRawAdapters: false (default), When the user-supplied fs writes outside cwd, Then PATHSPEC_OUTSIDE_REPO is thrown by the wrapper', async () => {
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
      expect.unreachable();
    } catch (err) {
      expect((err as { data: { code: string } }).data.code).toBe('PATHSPEC_OUTSIDE_REPO');
    }
  });
});

describe('openRepository — round-trip via memory adapter', () => {
  // A minimal smoke test that the bound init command delegates correctly.
  it('Given a fresh repo, When init is called, Then it completes and the .git directory is created', async () => {
    const fallback = makeFallback();
    const sut = await openRepository({ cwd: '/repo' }, fallback);

    await sut.init();

    expect(await sut.ctx.fs.exists('/repo/.git/HEAD')).toBe(true);
  });
});

describe('openRepository — ctx fields', () => {
  it('Given an opts.signal, When openRepository runs, Then ctx.signal is set and aborts when the user signal aborts', async () => {
    const controller = new AbortController();
    const sut = await openRepository({ cwd: '/repo', signal: controller.signal }, makeFallback());

    expect(sut.ctx.signal).toBeDefined();
    expect(sut.ctx.signal!.aborted).toBe(false);
    controller.abort();
    expect(sut.ctx.signal!.aborted).toBe(true);
  });

  it('Given opts.config with parallelism, When openRepository runs, Then ctx.config carries the value and is frozen', async () => {
    const sut = await openRepository({ cwd: '/repo', config: { parallelism: 4 } }, makeFallback());

    expect(sut.ctx.config).toBeDefined();
    expect(sut.ctx.config!.parallelism).toBe(4);
    expect(Object.isFrozen(sut.ctx.config)).toBe(true);
  });

  it('Given opts.config is omitted, When openRepository runs, Then ctx.config is undefined (NOT a frozen empty object) — kills the always-deepFreeze mutant', async () => {
    const sut = await openRepository({ cwd: '/repo' }, makeFallback());

    expect(sut.ctx.config).toBeUndefined();
  });

  it('Given opts.progress, When openRepository runs, Then ctx.progress is the user-supplied reporter', async () => {
    const reporter = { start: vi.fn(), update: vi.fn(), end: vi.fn() };
    const sut = await openRepository({ cwd: '/repo', progress: reporter }, makeFallback());

    expect(sut.ctx.progress).toBe(reporter);
  });

  it('Given an opts.logger, When openRepository runs, Then ctx.logger is present (sanitizer-wrapped) — kills the empty-object spread mutant', async () => {
    // The `{ logger: sanitizedLogger }` literal carries the logger into ctx;
    // a `{}` mutant would drop it entirely.
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sut = await openRepository({ cwd: '/repo', logger }, makeFallback());

    expect(sut.ctx.logger).toBeDefined();
  });

  it('Given opts.logger is omitted, When openRepository runs, Then ctx.logger is undefined', async () => {
    const sut = await openRepository({ cwd: '/repo' }, makeFallback());

    expect(sut.ctx.logger).toBeUndefined();
  });
});

describe('openRepository — dispose macrotask scheduler', () => {
  it('Given setImmediate is available, When dispose runs, Then setImmediate is used and setTimeout(_, 0) is NOT used for the macrotask boundary', async () => {
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

  it('Given setImmediate is unavailable, When dispose runs, Then it still resolves via the setTimeout(0) fallback', async () => {
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
