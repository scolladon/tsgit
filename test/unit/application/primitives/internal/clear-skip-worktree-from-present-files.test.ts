import { beforeEach, describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../../src/application/primitives/config-read.js';
import { __resetSectionsCacheForTests } from '../../../../../src/application/primitives/config-scoped-read.js';
import { clearSkipWorktreeFromPresentFiles } from '../../../../../src/application/primitives/internal/clear-skip-worktree-from-present-files.js';
import { commonGitDir } from '../../../../../src/application/primitives/path-layout.js';
import { permissionDenied } from '../../../../../src/domain/error.js';
import {
  type GitIndex,
  type IndexEntry,
  skipWorktreeEntry,
} from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/index.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { FileSystem } from '../../../../../src/ports/file-system.js';

const SPARSE_ON = '[core]\n\tsparseCheckout = true\n';
const EXPECT_FILES = '[sparse]\n\texpectFilesOutsideOfPatterns = true\n';
const ID = '0123456789012345678901234567890123456789' as ObjectId;

const withConfig = async (text: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${commonGitDir(ctx)}/config`, text);
  return ctx;
};

const rowOf = (path: string, skipWorktree = true): IndexEntry => {
  const entry = skipWorktreeEntry({ path: path as FilePath, id: ID, mode: FILE_MODE.REGULAR });
  return { ...entry, flags: { ...entry.flags, skipWorktree } };
};

const indexOf = (...entries: IndexEntry[]): GitIndex => ({
  version: 3,
  entries,
  extensions: [],
  trailerSha: new Uint8Array([1, 2, 3]),
  indexMtime: { seconds: 5, nanoseconds: 6 },
});

const place = (ctx: Context, path: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, 'x');

/** The same file system minus its synchronous probe, so the async probes are the ones under test. */
const withoutSyncProbe = (fs: FileSystem): FileSystem =>
  new Proxy(fs, {
    get: (target, key) => (key === 'lstatReachableSync' ? undefined : Reflect.get(target, key)),
  });

const flagsOf = (index: GitIndex): boolean[] => index.entries.map((e) => e.flags.skipWorktree);

describe('clearSkipWorktreeFromPresentFiles', () => {
  const sut = clearSkipWorktreeFromPresentFiles;

  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  describe('Given core.sparseCheckout is off', () => {
    describe('When a skip-worktree file is present', () => {
      it('Then the same index object is returned', async () => {
        // Arrange
        const ctx = await withConfig('');
        await place(ctx, 'a');
        const index = indexOf(rowOf('a'));

        // Act
        const result = await sut(ctx, index);

        // Assert
        expect(result).toBe(index);
      });
    });
  });

  describe('Given sparse.expectFilesOutsideOfPatterns is true', () => {
    describe('When a skip-worktree file is present', () => {
      it('Then the same index object is returned', async () => {
        // Arrange
        const ctx = await withConfig(`${SPARSE_ON}${EXPECT_FILES}`);
        await place(ctx, 'a');
        const index = indexOf(rowOf('a'));

        // Act
        const result = await sut(ctx, index);

        // Assert
        expect(result).toBe(index);
      });
    });
  });

  describe('Given no entry carries skip-worktree', () => {
    describe('When a file is present', () => {
      it('Then the same index object is returned', async () => {
        // Arrange
        const ctx = await withConfig(SPARSE_ON);
        await place(ctx, 'a');
        const index = indexOf(rowOf('a', false));

        // Act
        const result = await sut(ctx, index);

        // Assert
        expect(result).toBe(index);
      });
    });
  });

  describe('Given a layout without a work tree', () => {
    describe('When an entry carries skip-worktree', () => {
      it('Then the same index object is returned', async () => {
        // Arrange
        const base = await withConfig(SPARSE_ON);
        const { workDir: _workDir, ...layout } = base.layout;
        const ctx: Context = { ...base, layout };
        const index = indexOf(rowOf('a'));

        // Act
        const result = await sut(ctx, index);

        // Assert
        expect(result).toBe(index);
      });
    });
  });

  describe('Given a file at a skip-worktree path', () => {
    describe('When clearing', () => {
      it('Then the bit is cleared', async () => {
        // Arrange
        const ctx = await withConfig(SPARSE_ON);
        await place(ctx, 'a');

        // Act
        const result = await sut(ctx, indexOf(rowOf('a')));

        // Assert
        expect(flagsOf(result)).toEqual([false]);
      });
    });
  });

  describe('Given a directory at a skip-worktree path', () => {
    describe('When clearing', () => {
      it('Then the bit is cleared', async () => {
        // Arrange
        const ctx = await withConfig(SPARSE_ON);
        await ctx.fs.mkdir(`${ctx.layout.workDir}/d`);

        // Act
        const result = await sut(ctx, indexOf(rowOf('d')));

        // Assert
        expect(flagsOf(result)).toEqual([false]);
      });
    });
  });

  describe('Given a regular file where the parent directory should be', () => {
    describe('When clearing', () => {
      it('Then the bit is kept', async () => {
        // Arrange
        const ctx = await withConfig(SPARSE_ON);
        await place(ctx, 'p');
        const index = indexOf(rowOf('p/child'));

        // Act
        const result = await sut(ctx, index);

        // Assert
        expect(result).toBe(index);
      });
    });
  });

  describe('Given lstat refuses with permission denied', () => {
    describe('When clearing', () => {
      it('Then the bit is kept and nothing is thrown', async () => {
        // Arrange
        const base = await withConfig(SPARSE_ON);
        await place(base, 'a');
        const fs = new Proxy(withoutSyncProbe(base.fs), {
          get: (target, key) =>
            key === 'lstatIfReachable'
              ? () => Promise.reject(permissionDenied('a'))
              : Reflect.get(target, key),
        });
        const index = indexOf(rowOf('a'));

        // Act
        const result = await sut({ ...base, fs }, index);

        // Assert
        expect(result).toBe(index);
      });
    });
  });

  describe('Given a lossy path whose file is present', () => {
    describe('When clearing', () => {
      it('Then the bit is kept', async () => {
        // Arrange
        const ctx = await withConfig(SPARSE_ON);
        await place(ctx, 'a');
        const lossy: IndexEntry = { ...rowOf('a'), pathBytes: new Uint8Array([0x61]) };
        const index = indexOf(lossy);

        // Act
        const result = await sut(ctx, index);

        // Assert
        expect(result).toBe(index);
      });
    });
  });

  describe('Given two skip-worktree entries of which one is present', () => {
    describe('When clearing', () => {
      it('Then only that entry is replaced and the rest carries over', async () => {
        // Arrange
        const ctx = await withConfig(SPARSE_ON);
        await place(ctx, 'b');
        const index = indexOf(rowOf('a'), rowOf('b'));

        // Act
        const result = await sut(ctx, index);

        // Assert
        expect(flagsOf(result)).toEqual([true, false]);
        expect(result.entries[0]).toBe(index.entries[0]);
        expect(result.version).toBe(index.version);
        expect(result.extensions).toBe(index.extensions);
        expect(result.trailerSha).toBe(index.trailerSha);
        expect(result.indexMtime).toBe(index.indexMtime);
      });
    });
  });

  describe('Given a present skip-worktree file', () => {
    describe('When clearing', () => {
      it('Then the input index and its entry are not mutated', async () => {
        // Arrange
        const ctx = await withConfig(SPARSE_ON);
        await place(ctx, 'a');
        const index = indexOf(rowOf('a'));

        // Act
        const result = await sut(ctx, index);

        // Assert
        expect(result).not.toBe(index);
        expect(flagsOf(index)).toEqual([true]);
      });
    });
  });

  describe('Given many present skip-worktree files and a parallelism of 3', () => {
    describe('When clearing', () => {
      it('Then lstat calls overlap up to 3 and never beyond, and every bit is cleared', async () => {
        // Arrange
        const base = await withConfig(SPARSE_ON);
        const paths = Array.from({ length: 200 }, (_, i) => `d${i % 10}/f${i}`).sort();
        for (const path of paths) await place(base, path);
        let inFlight = 0;
        let peak = 0;
        const fs = new Proxy(withoutSyncProbe(base.fs), {
          get: (target, key) =>
            key === 'lstatIfReachable'
              ? async (path: string) => {
                  inFlight += 1;
                  peak = Math.max(peak, inFlight);
                  await Promise.resolve();
                  try {
                    return await target.lstatIfReachable?.(path);
                  } finally {
                    inFlight -= 1;
                  }
                }
              : Reflect.get(target, key),
        });
        const ctx = { ...base, fs, config: { parallelism: 3 } } as Context;
        const index = indexOf(...paths.map((path) => rowOf(path)));

        // Act
        const result = await sut(ctx, index);

        // Assert
        expect(peak).toBe(3);
        expect(flagsOf(result).every((bit) => !bit)).toBe(true);
      });
    });
  });

  describe('Given absent directories holding many skip-worktree files', () => {
    describe('When clearing', () => {
      it('Then the bits are kept with far fewer probes than files', async () => {
        // Arrange
        const base = await withConfig(SPARSE_ON);
        const paths = Array.from(
          { length: 200 },
          (_, i) => `gone${i % 4}/f${String(i).padStart(3, '0')}`,
        ).sort();
        let probes = 0;
        const fs = new Proxy(withoutSyncProbe(base.fs), {
          get: (target, key) =>
            key === 'lstatIfReachable'
              ? (path: string) => {
                  probes += 1;
                  return target.lstatIfReachable?.(path);
                }
              : Reflect.get(target, key),
        });
        const ctx = { ...base, fs, config: { parallelism: 3 } } as Context;
        const index = indexOf(...paths.map((path) => rowOf(path)));

        // Act
        const result = await sut(ctx, index);

        // Assert
        expect(result).toBe(index);
        expect(probes).toBeLessThan(paths.length / 2);
      });
    });
  });

  describe('Given a file system with a refusal-free miss probe', () => {
    describe('When clearing a present file and an absent one', () => {
      it('Then the probe answers both and lstat is never asked', async () => {
        // Arrange
        const base = await withConfig(SPARSE_ON);
        await place(base, 'here');
        const fs = new Proxy(withoutSyncProbe(base.fs), {
          get: (target, key) => {
            if (key === 'lstat') return () => Promise.reject(permissionDenied('lstat'));
            if (key === 'lstatIfReachable') {
              return (path: string) => target.lstat(path).catch(() => undefined);
            }
            return Reflect.get(target, key);
          },
        });
        const index = indexOf(rowOf('gone'), rowOf('here'));

        // Act
        const result = await sut({ ...base, fs }, index);

        // Assert
        expect(flagsOf(result)).toEqual([true, false]);
      });
    });
  });

  describe('Given a file system without the refusal-free miss probe', () => {
    describe('When clearing a present file and an absent one', () => {
      it('Then lstat answers both', async () => {
        // Arrange
        const base = await withConfig(SPARSE_ON);
        await place(base, 'here');
        const fs = new Proxy(withoutSyncProbe(base.fs), {
          get: (target, key) => (key === 'lstatIfReachable' ? undefined : Reflect.get(target, key)),
        });
        const index = indexOf(rowOf('gone'), rowOf('here'));

        // Act
        const result = await sut({ ...base, fs }, index);

        // Assert
        expect(flagsOf(result)).toEqual([true, false]);
      });
    });
  });

  describe('Given a file system with a synchronous presence probe', () => {
    describe('When clearing a present file and an absent one', () => {
      it('Then the sync probe answers both and no async probe is asked', async () => {
        // Arrange
        const base = await withConfig(SPARSE_ON);
        await place(base, 'here');
        const fs = new Proxy(base.fs, {
          get: (target, key) => {
            if (key === 'lstat' || key === 'lstatIfReachable') {
              return () => Promise.reject(permissionDenied('async'));
            }
            if (key === 'lstatReachableSync') return (path: string) => path.endsWith('/here');
            return Reflect.get(target, key);
          },
        });
        const index = indexOf(rowOf('gone'), rowOf('here'));

        // Act
        const result = await sut({ ...base, fs }, index);

        // Assert
        expect(flagsOf(result)).toEqual([true, false]);
      });
    });
  });

  describe('Given a synchronous probe that cannot answer yet', () => {
    describe('When clearing a present file and an absent one', () => {
      it('Then the async probe answers instead', async () => {
        // Arrange
        const base = await withConfig(SPARSE_ON);
        await place(base, 'here');
        const fs = new Proxy(base.fs, {
          get: (target, key) =>
            key === 'lstatReachableSync' ? () => undefined : Reflect.get(target, key),
        });
        const index = indexOf(rowOf('gone'), rowOf('here'));

        // Act
        const result = await sut({ ...base, fs }, index);

        // Assert
        expect(flagsOf(result)).toEqual([true, false]);
      });
    });
  });

  describe('Given a synchronous probe whose turn budget runs out every 70 probes', () => {
    describe('When clearing 200 present files across several runs', () => {
      it('Then each cut run yields through the async probe, the walk resumes synchronously and every bit clears', async () => {
        // Arrange
        const base = await withConfig(SPARSE_ON);
        const paths = Array.from({ length: 200 }, (_, i) => `d/f${String(i).padStart(3, '0')}`);
        await Promise.all(paths.map((path) => place(base, path)));
        const turn = { syncProbes: 0 };
        const asked = { sync: 0, async: 0 };
        const fs = new Proxy(base.fs, {
          get: (target, key) => {
            if (key === 'lstatReachableSync') {
              return () => {
                if (turn.syncProbes >= 70) return undefined;
                turn.syncProbes++;
                asked.sync++;
                return true;
              };
            }
            if (key === 'lstatIfReachable') {
              return (path: string) => {
                if (asked.async++ % 64 === 0) turn.syncProbes = 0;
                return target.lstatIfReachable?.(path);
              };
            }
            return Reflect.get(target, key);
          },
        });
        const index = indexOf(...paths.map((path) => rowOf(path)));

        // Act
        const result = await sut({ ...base, fs }, index);

        // Assert
        expect(flagsOf(result).every((flag) => !flag)).toBe(true);
        expect(asked.async).toBeGreaterThan(0);
        expect(asked.sync).toBeGreaterThan(70);
      });
    });
  });

  describe('Given 130 files, spread over several runs, all beneath one missing directory', () => {
    describe('When clearing', () => {
      it('Then the missing directory is found once and no run asks again', async () => {
        // Arrange
        const base = await withConfig(SPARSE_ON);
        const probed: string[] = [];
        const fs = new Proxy(base.fs, {
          get: (target, key) =>
            key === 'lstatReachableSync'
              ? (path: string) => {
                  probed.push(path);
                  return false;
                }
              : Reflect.get(target, key),
        });
        const paths = Array.from({ length: 130 }, (_, i) => `gone/f${String(i).padStart(3, '0')}`);
        const index = indexOf(...paths.map((path) => rowOf(path)));

        // Act
        const result = await sut({ ...base, fs }, index);

        // Assert
        expect(probed).toEqual([
          `${base.layout.workDir}/gone/f000`,
          `${base.layout.workDir}/gone/`,
        ]);
        expect(result).toBe(index);
      });
    });
  });

  describe('Given a synchronous probe that never answers', () => {
    describe('When clearing several runs of files', () => {
      it('Then it is asked once and the async probe answers every path', async () => {
        // Arrange
        const base = await withConfig(SPARSE_ON);
        const paths = Array.from({ length: 130 }, (_, i) => `d/f${i}`);
        await Promise.all(paths.map((path) => place(base, path)));
        let syncAsked = 0;
        const fs = new Proxy(base.fs, {
          get: (target, key) =>
            key === 'lstatReachableSync'
              ? () => {
                  syncAsked++;
                  return undefined;
                }
              : Reflect.get(target, key),
        });
        const index = indexOf(...paths.map((path) => rowOf(path)));

        // Act
        const result = await sut({ ...base, fs }, index);

        // Assert
        expect(syncAsked).toBe(1);
        expect(flagsOf(result).every((flag) => !flag)).toBe(true);
      });
    });
  });

  describe('Given a synchronous probe that throws', () => {
    describe('When clearing', () => {
      it('Then the entry reads absent and nothing is thrown', async () => {
        // Arrange
        const base = await withConfig(SPARSE_ON);
        await place(base, 'here');
        const fs = new Proxy(base.fs, {
          get: (target, key) =>
            key === 'lstatReachableSync'
              ? () => {
                  throw permissionDenied('here');
                }
              : Reflect.get(target, key),
        });
        const index = indexOf(rowOf('here'));

        // Act
        const result = await sut({ ...base, fs }, index);

        // Assert
        expect(result).toBe(index);
      });
    });
  });

  describe('Given the same index object read twice', () => {
    describe('When the file appears between the reads', () => {
      it('Then the second read clears it', async () => {
        // Arrange
        const ctx = await withConfig(SPARSE_ON);
        const index = indexOf(rowOf('a'));
        const first = await sut(ctx, index);
        await place(ctx, 'a');

        // Act
        const result = await sut(ctx, index);

        // Assert
        expect(first).toBe(index);
        expect(flagsOf(result)).toEqual([false]);
      });
    });
  });
});
