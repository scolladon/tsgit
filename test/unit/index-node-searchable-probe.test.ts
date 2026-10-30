/**
 * Unit coverage for the Node shim's `isSearchable` layout-probe member
 * (`src/index.node.ts`): git's `access(path, X_OK)` folds EACCES, ENOENT and
 * ENOTDIR into "not a git directory" and lets any other errno surface. The
 * `node:fs/promises` `access` (the `threadpool` arm) and `node:fs`
 * `accessSync` (the default sync fast path) are faked per path so no
 * permission-stripped directory (and no unprivileged user) is needed.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failures = new Map<string, string>();

const injectedFailure = (target: string): string | undefined =>
  [...failures].find(([fragment]) => target.includes(fragment))?.[1];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    accessSync: vi.fn((target: string, mode?: number) => {
      const code = injectedFailure(String(target));
      if (code === undefined) return actual.accessSync(target, mode);
      throw Object.assign(new Error(code), { code });
    }),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: vi.fn(async (target: string, mode?: number) => {
      const code = injectedFailure(target);
      if (code === undefined) return actual.access(target, mode);
      throw Object.assign(new Error(code), { code });
    }),
  };
});

const { openRepository } = await import('../../src/index.node.js');
const fsPromises = await import('node:fs/promises');
const nodeFs = await import('node:fs');

let tmpdir: string;

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-node-searchable-'));
});

afterEach(async () => {
  failures.clear();
  await rm(tmpdir, { recursive: true, force: true });
});

const makeGitDir = async (dir: string): Promise<void> => {
  await mkdir(path.join(dir, 'objects'), { recursive: true });
  await mkdir(path.join(dir, 'refs'), { recursive: true });
  await writeFile(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
};

const nestedRepositories = async (): Promise<{ outer: string; inner: string }> => {
  const outer = path.join(tmpdir, '.git');
  const inner = path.join(tmpdir, 'inner');
  await makeGitDir(outer);
  await makeGitDir(path.join(inner, '.git'));
  return { outer, inner };
};

describe.each(['EACCES', 'ENOENT', 'ENOTDIR'])(
  'Given the threadpool io mode and access() fails with %s on the inner repository refs directory',
  (code) => {
    describe('When openRepository walks from the inner directory', () => {
      it('Then the inner gitdir is not adopted and the walk lands on the outer one', async () => {
        // Arrange
        const { outer, inner } = await nestedRepositories();
        failures.set(path.join('inner', '.git', 'refs'), code);
        const sut = openRepository;

        // Act
        const repo = await sut({ cwd: inner, io: 'threadpool' });

        // Assert
        try {
          expect(path.relative(await realpath(outer), repo.ctx.layout.gitDir)).toBe('');
        } finally {
          await repo.dispose();
        }
      });
    });
  },
);

describe('Given the threadpool io mode and access() fails with an unexpected errno on the inner repository refs directory', () => {
  describe('When openRepository walks from the inner directory', () => {
    it('Then the fault surfaces instead of being read as "not searchable"', async () => {
      // Arrange
      const { inner } = await nestedRepositories();
      failures.set(path.join('inner', '.git', 'refs'), 'EIO');
      const sut = openRepository;

      // Act
      let caught: unknown;
      try {
        await sut({ cwd: inner, io: 'threadpool' });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect((caught as NodeJS.ErrnoException).code).toBe('EIO');
    });
  });
});

describe.each(['EACCES', 'ENOENT', 'ENOTDIR'])(
  'Given the default io mode and accessSync() fails with %s on the inner repository refs directory',
  (code) => {
    describe('When openRepository walks from the inner directory', () => {
      it('Then the inner gitdir is not adopted and the walk lands on the outer one', async () => {
        // Arrange
        const { outer, inner } = await nestedRepositories();
        failures.set(path.join('inner', '.git', 'refs'), code);
        const sut = openRepository;

        // Act
        const repo = await sut({ cwd: inner });

        // Assert
        try {
          expect(path.relative(await realpath(outer), repo.ctx.layout.gitDir)).toBe('');
        } finally {
          await repo.dispose();
        }
      });
    });
  },
);

describe('Given the default io mode and accessSync() fails with an unexpected errno', () => {
  describe('When openRepository walks from the inner directory', () => {
    it('Then the fault surfaces instead of being read as "not searchable"', async () => {
      // Arrange
      const { inner } = await nestedRepositories();
      failures.set(path.join('inner', '.git', 'refs'), 'EIO');
      const sut = openRepository;

      // Act
      let caught: unknown;
      try {
        await sut({ cwd: inner });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect((caught as NodeJS.ErrnoException).code).toBe('EIO');
    });
  });
});

describe('Given the default io mode', () => {
  describe('When openRepository probes a shared directory', () => {
    it('Then the sync access is used and the async access is never called', async () => {
      // Arrange
      const { inner } = await nestedRepositories();
      vi.mocked(fsPromises.access).mockClear();
      vi.mocked(nodeFs.accessSync).mockClear();
      const sut = openRepository;

      // Act
      const repo = await sut({ cwd: inner });

      // Assert
      try {
        expect(vi.mocked(nodeFs.accessSync)).toHaveBeenCalled();
        expect(vi.mocked(fsPromises.access)).not.toHaveBeenCalled();
      } finally {
        await repo.dispose();
      }
    });
  });
});
