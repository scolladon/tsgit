/**
 * Wiring coverage for the `io` option (`src/index.node.ts`,
 * `src/adapters/node/node-adapter.ts`): proves the sync fast path is the
 * default, that `io: 'threadpool'` opts every adapter this repository
 * builds out of it entirely, and that an invalid value refuses before any
 * filesystem call.
 *
 * Two seams are spied on, each a genuine cross-module import edge (a
 * same-module call — `syncIoPolicyFor`'s own call to `createSyncIoPolicy` —
 * is NOT interceptable this way, since both live in `sync-io-budget.ts`):
 *  - `syncIoPolicyFor` (`sync-io-budget.ts`, imported by `index.node.ts` and
 *    `node-adapter.ts`) pins HOW MANY TIMES the resolver ran and with what
 *    argument — one call per `openRepository`/`createNodeContext`.
 *  - `realSyncFsOps` (`fs-operations.ts`, imported by `sync-io-budget.ts`)
 *    is replaced by `spyOps`, a pass-through spy of the real `node:fs`
 *    surface, so a call reaching it pins WHICH sync operation ran.
 */
import * as fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spyOps = {
  statSync: vi.fn(fs.statSync),
  lstatSync: vi.fn(fs.lstatSync),
  readlinkSync: vi.fn(fs.readlinkSync),
  openSync: vi.fn(fs.openSync),
  fstatSync: vi.fn(fs.fstatSync),
  readSync: vi.fn(fs.readSync),
  closeSync: vi.fn(fs.closeSync),
  realpathSync: { native: vi.fn(fs.realpathSync.native) },
};

vi.mock('../../src/adapters/node/fs-operations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/node/fs-operations.js')>();
  return { ...actual, realSyncFsOps: spyOps };
});

vi.mock('../../src/adapters/node/sync-io-budget.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/node/sync-io-budget.js')>();
  return { ...actual, syncIoPolicyFor: vi.fn(actual.syncIoPolicyFor) };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const { syncIoPolicyFor } = await import('../../src/adapters/node/sync-io-budget.js');
const { createNodeContext } = await import('../../src/adapters/node/node-adapter.js');
const { openRepository } = await import('../../src/index.node.js');
const { readFile } = await import('node:fs/promises');

const syncIoPolicyForSpy = vi.mocked(syncIoPolicyFor);
const readFileSpy = vi.mocked(readFile);

/**
 * Marks `dir` as a valid git directory: `objects/`, `refs/`, and a `HEAD`
 * file. `findLayout`'s directory validation skips a `.git` that lacks these,
 * continuing the walk upward instead of accepting a bare `mkdir`.
 */
const makeGitDir = async (dir: string): Promise<void> => {
  await mkdir(path.join(dir, 'objects'), { recursive: true });
  await mkdir(path.join(dir, 'refs'), { recursive: true });
  await writeFile(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
};

const everySpyOpsCall = (): number =>
  [
    spyOps.statSync,
    spyOps.lstatSync,
    spyOps.readlinkSync,
    spyOps.openSync,
    spyOps.fstatSync,
    spyOps.readSync,
    spyOps.closeSync,
    spyOps.realpathSync.native,
  ].reduce((total, spy) => total + spy.mock.calls.length, 0);

let tmpdir: string;

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-node-io-strategy-'));
  await makeGitDir(path.join(tmpdir, '.git'));
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(tmpdir, { recursive: true, force: true });
});

describe('Given no io option', () => {
  describe('When openRepository runs', () => {
    it('Then syncIoPolicyFor is called exactly once, with undefined', async () => {
      // Arrange & Act
      const sut = openRepository;
      const repository = await sut({ cwd: tmpdir });

      // Assert
      try {
        expect(syncIoPolicyForSpy).toHaveBeenCalledTimes(1);
        expect(syncIoPolicyForSpy).toHaveBeenCalledWith(undefined);
      } finally {
        await repository.dispose();
      }
    });

    it("Then the layout probe's stat member reaches statSync", async () => {
      // Arrange & Act
      const sut = openRepository;
      const repository = await sut({ cwd: tmpdir });

      // Assert
      try {
        expect(spyOps.statSync).toHaveBeenCalled();
      } finally {
        await repository.dispose();
      }
    });

    it("Then the layout probe's readLink member reaches readlinkSync", async () => {
      // Arrange & Act
      const sut = openRepository;
      const repository = await sut({ cwd: tmpdir });

      // Assert
      try {
        expect(spyOps.readlinkSync).toHaveBeenCalled();
      } finally {
        await repository.dispose();
      }
    });

    it("Then the layout probe's readUtf8 member reaches the sync read, never the async fallback", async () => {
      // Arrange & Act
      const sut = openRepository;
      const repository = await sut({ cwd: tmpdir });

      // Assert
      try {
        expect(spyOps.openSync).toHaveBeenCalled();
        expect(spyOps.fstatSync).toHaveBeenCalled();
        expect(spyOps.readSync).toHaveBeenCalled();
        expect(spyOps.closeSync).toHaveBeenCalled();
        expect(readFileSpy).not.toHaveBeenCalled();
      } finally {
        await repository.dispose();
      }
    });

    it('Then canonicalize reaches realpathSync.native', async () => {
      // Arrange & Act
      const sut = openRepository;
      const repository = await sut({ cwd: tmpdir });

      // Assert
      try {
        expect(spyOps.realpathSync.native).toHaveBeenCalled();
      } finally {
        await repository.dispose();
      }
    });
  });

  describe("When revParse('HEAD') runs", () => {
    it('Then it reaches a sync fs operation', async () => {
      // Arrange — the fixture's HEAD points at a branch with no commit yet,
      // so resolution fails past the ref read this row actually probes.
      const sut = openRepository;
      const repository = await sut({ cwd: tmpdir });

      try {
        spyOps.lstatSync.mockClear();
        spyOps.openSync.mockClear();

        // Act
        await repository.revParse('HEAD').catch(() => undefined);

        // Assert
        const reachedSync =
          spyOps.lstatSync.mock.calls.length > 0 || spyOps.openSync.mock.calls.length > 0;
        expect(reachedSync).toBe(true);
      } finally {
        await repository.dispose();
      }
    });
  });
});

describe("Given io: 'sync-fast-path'", () => {
  describe('When openRepository runs', () => {
    it('Then syncIoPolicyFor is called exactly once, with the explicit value', async () => {
      // Arrange & Act
      const sut = openRepository;
      const repository = await sut({ cwd: tmpdir, io: 'sync-fast-path' });

      // Assert
      try {
        expect(syncIoPolicyForSpy).toHaveBeenCalledTimes(1);
        expect(syncIoPolicyForSpy).toHaveBeenCalledWith('sync-fast-path');
      } finally {
        await repository.dispose();
      }
    });

    it('Then the layout probe reaches the sync ops', async () => {
      // Arrange & Act
      const sut = openRepository;
      const repository = await sut({ cwd: tmpdir, io: 'sync-fast-path' });

      // Assert
      try {
        expect(spyOps.statSync).toHaveBeenCalled();
      } finally {
        await repository.dispose();
      }
    });
  });
});

describe("Given io: 'threadpool'", () => {
  describe('When openRepository runs', () => {
    it('Then syncIoPolicyFor is called exactly once, with the explicit value', async () => {
      // Arrange & Act
      const sut = openRepository;
      const repository = await sut({ cwd: tmpdir, io: 'threadpool' });

      // Assert
      try {
        expect(syncIoPolicyForSpy).toHaveBeenCalledTimes(1);
        expect(syncIoPolicyForSpy).toHaveBeenCalledWith('threadpool');
      } finally {
        await repository.dispose();
      }
    });

    it('Then no spyOps member is called', async () => {
      // Arrange & Act
      const sut = openRepository;
      const repository = await sut({ cwd: tmpdir, io: 'threadpool' });

      // Assert
      try {
        expect(everySpyOpsCall()).toBe(0);
      } finally {
        await repository.dispose();
      }
    });

    it('Then the layout probe reads HEAD through the async readFile', async () => {
      // Arrange & Act
      const sut = openRepository;
      const repository = await sut({ cwd: tmpdir, io: 'threadpool' });

      // Assert
      try {
        expect(readFileSpy).toHaveBeenCalled();
      } finally {
        await repository.dispose();
      }
    });

    it('Then a worktree adapter it builds also carries no sync policy', async () => {
      // Arrange
      const sut = openRepository;
      const repository = await sut({
        cwd: tmpdir,
        io: 'threadpool',
        unsafeRawAdapters: true,
      });
      const resolvedWorkDir = repository.ctx.layout.workDir as string;

      try {
        // Act
        repository.ctx.worktreeFs?.(path.join(resolvedWorkDir, 'wt'));

        // Assert — building the adapter must not have reached any sync op.
        expect(everySpyOpsCall()).toBe(0);
      } finally {
        await repository.dispose();
      }
    });
  });
});

describe('Given an invalid io value', () => {
  describe('When openRepository runs', () => {
    it('Then it throws INVALID_OPTION before any fs call', async () => {
      // Arrange
      const sut = openRepository;
      let caught: unknown;

      // Act
      try {
        await sut({ cwd: tmpdir, io: 'bogus' as unknown as 'sync-fast-path' });
        expect.unreachable('expected openRepository to throw');
      } catch (err) {
        caught = err;
      }

      // Assert
      const data = (caught as { data: { code: string; option: string; reason: string } }).data;
      expect(data.code).toBe('INVALID_OPTION');
      expect(data.option).toBe('io');
      expect(everySpyOpsCall()).toBe(0);
      expect(readFileSpy).not.toHaveBeenCalled();
    });
  });
});

describe('Given the sync stat reports HEAD as a non-regular file', () => {
  describe('When openRepository runs', () => {
    it('Then it falls back to the async readFile', async () => {
      // Arrange
      const sut = openRepository;
      spyOps.fstatSync.mockReturnValueOnce({
        isFile: () => false,
        size: 0,
      } as unknown as ReturnType<typeof fs.fstatSync>);

      // Act
      const repository = await sut({ cwd: tmpdir });

      // Assert
      try {
        expect(readFileSpy).toHaveBeenCalled();
      } finally {
        await repository.dispose();
      }
    });
  });
});

describe('Given the sync stat always throws a non-ENOENT error', () => {
  describe('When openRepository runs', () => {
    it('Then it still resolves, matching the async arm collapsing every error to undefined', async () => {
      // Arrange
      const sut = openRepository;
      spyOps.statSync.mockImplementation(() => {
        throw Object.assign(new Error('boom'), { code: 'EACCES' });
      });

      try {
        // Act
        const repository = await sut({ cwd: tmpdir });

        // Assert — a genuine, fully-opened repository, not a degraded stub.
        try {
          expect(repository.ctx.layout.workDir).toBe(fs.realpathSync(tmpdir));
        } finally {
          await repository.dispose();
        }
      } finally {
        spyOps.statSync.mockImplementation(fs.statSync);
      }
    });
  });
});

describe('Given the sync lstat always throws a non-ENOENT error', () => {
  describe('When openRepository runs', () => {
    it('Then it still resolves — the lstat-first probe collapses the error to absent, same as a missing entry', async () => {
      // Arrange
      const sut = openRepository;
      spyOps.lstatSync.mockImplementation(() => {
        throw Object.assign(new Error('boom'), { code: 'EACCES' });
      });

      try {
        // Act
        const repository = await sut({ cwd: tmpdir });

        // Assert — a genuine, fully-opened repository, not a degraded stub.
        try {
          expect(repository.ctx.layout.workDir).toBe(fs.realpathSync(tmpdir));
        } finally {
          await repository.dispose();
        }
      } finally {
        spyOps.lstatSync.mockImplementation(fs.lstatSync);
      }
    });
  });
});

describe('Given the sync read always throws opening the file', () => {
  describe('When openRepository runs', () => {
    it('Then it falls back to the async readFile instead of rejecting', async () => {
      // Arrange
      const sut = openRepository;
      spyOps.openSync.mockImplementation(() => {
        throw Object.assign(new Error('boom'), { code: 'EACCES' });
      });

      try {
        // Act
        const repository = await sut({ cwd: tmpdir });

        // Assert
        try {
          expect(readFileSpy).toHaveBeenCalled();
        } finally {
          await repository.dispose();
        }
      } finally {
        spyOps.openSync.mockImplementation(fs.openSync);
      }
    });
  });
});

describe('Given both the sync read and its async fallback fail', () => {
  describe('When openRepository runs', () => {
    it('Then it still resolves rather than rejecting', async () => {
      // Arrange
      const sut = openRepository;
      spyOps.fstatSync.mockReturnValueOnce({
        isFile: () => false,
        size: 0,
      } as unknown as ReturnType<typeof fs.fstatSync>);
      readFileSpy.mockRejectedValueOnce(new Error('read failed'));

      // Act
      const repository = await sut({ cwd: tmpdir });

      // Assert — a genuine, fully-opened repository, not a degraded stub.
      try {
        expect(repository.ctx.layout.workDir).toBe(fs.realpathSync(tmpdir));
      } finally {
        await repository.dispose();
      }
    });
  });
});

describe("Given io: 'threadpool' and the async readFile fails", () => {
  describe('When openRepository runs', () => {
    it('Then it still resolves rather than rejecting', async () => {
      // Arrange
      const sut = openRepository;
      readFileSpy.mockRejectedValueOnce(new Error('read failed'));

      // Act
      const repository = await sut({ cwd: tmpdir, io: 'threadpool' });

      // Assert — a genuine, fully-opened repository, not a degraded stub.
      try {
        expect(repository.ctx.layout.workDir).toBe(fs.realpathSync(tmpdir));
      } finally {
        await repository.dispose();
      }
    });
  });
});

describe("Given createNodeContext with io: 'threadpool'", () => {
  describe('When creating a context', () => {
    it('Then syncIoPolicyFor is called exactly once, with the explicit value', () => {
      // Arrange & Act
      const sut = createNodeContext;
      const context = sut({ workDir: tmpdir, io: 'threadpool' });

      // Assert
      expect(context.layout.workDir).toBe(tmpdir);
      expect(syncIoPolicyForSpy).toHaveBeenCalledTimes(1);
      expect(syncIoPolicyForSpy).toHaveBeenCalledWith('threadpool');
    });
  });
});

describe('Given createNodeContext with no io option', () => {
  describe('When creating a context', () => {
    it('Then syncIoPolicyFor is called exactly once, with undefined', () => {
      // Arrange & Act
      const sut = createNodeContext;
      sut({ workDir: tmpdir });

      // Assert
      expect(syncIoPolicyForSpy).toHaveBeenCalledTimes(1);
      expect(syncIoPolicyForSpy).toHaveBeenCalledWith(undefined);
    });
  });
});

describe('Given a path whose parent segment is a regular file (ENOTDIR)', () => {
  describe('When probed via statSync with throwIfNoEntry:false and via async stat().catch()', () => {
    it('Then both collapse to undefined', async () => {
      // Arrange
      const { stat } = await import('node:fs/promises');
      const filePath = path.join(tmpdir, 'not-a-directory');
      await writeFile(filePath, 'x');
      const bogusPath = path.join(filePath, 'nested');

      // Act
      const syncResult = fs.statSync(bogusPath, { throwIfNoEntry: false });
      const asyncResult = await stat(bogusPath).catch(() => undefined);

      // Assert
      expect(syncResult).toBeUndefined();
      expect(asyncResult).toBeUndefined();
    });
  });
});
