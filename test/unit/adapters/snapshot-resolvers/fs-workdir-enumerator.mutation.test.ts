/**
 * Mutation-killer tests for `fs-workdir-enumerator.ts`. Targets the
 * derive-mode ternary, the mtimeNs conditional-spread, the maxDepth /
 * maxEntries / excludes conditional-spreads, and the two isAborted()
 * call sites (pre-loop + per-row).
 */
import { describe, expect, it } from 'vitest';

import { createFsWorkdirEnumerator } from '../../../../src/adapters/snapshot-resolvers/fs-workdir-enumerator.js';
import type { Context } from '../../../../src/ports/context.js';
import type { FileStat, FileSystem } from '../../../../src/ports/file-system.js';
import type {
  WalkIgnorePredicate,
  WorkdirEnumerator,
} from '../../../../src/ports/snapshot-resolvers.js';
import { buildSeededContext } from '../../application/primitives/fixtures.js';

const seedFile = async (ctx: Context, relPath: string, content = 'x'): Promise<void> => {
  await ctx.fs.write(`${ctx.layout.workDir}/${relPath}`, new TextEncoder().encode(content));
};

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

const wrapFsWithStat = (fs: FileSystem, stat: (p: string) => Promise<FileStat>): FileSystem => ({
  ...fs,
  lstat: stat,
  stat,
});

describe('createFsWorkdirEnumerator — deriveFileMode executable bit', () => {
  describe('Given an lstat reporting an executable file (mode bits & 0o111)', () => {
    describe('When enumerate yields the row', () => {
      it('Then mode is "100755"', async () => {
        // Arrange — wrap lstat to flip on the executable bit.
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'go');
        const fs = wrapFsWithStat(ctx.fs, async (p) => ({
          ...(await ctx.fs.lstat(p)),
          mode: 0o755,
          isFile: true,
          isSymbolicLink: false,
        }));
        const sut: WorkdirEnumerator = createFsWorkdirEnumerator();

        // Act
        const rows = await collect(sut.enumerate({ ...ctx, fs }, {}));

        // Assert
        expect(rows.find((r) => r.path === 'go')?.mode).toBe('100755');
      });
    });
  });

  describe('Given an lstat reporting a non-executable regular file (mode bits & 0o111 = 0)', () => {
    describe('When enumerate yields the row', () => {
      it('Then mode is "100644"', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'plain.txt');
        const fs = wrapFsWithStat(ctx.fs, async (p) => ({
          ...(await ctx.fs.lstat(p)),
          mode: 0o644,
          isFile: true,
          isSymbolicLink: false,
        }));
        const sut: WorkdirEnumerator = createFsWorkdirEnumerator();

        // Act
        const rows = await collect(sut.enumerate({ ...ctx, fs }, {}));

        // Assert
        expect(rows.find((r) => r.path === 'plain.txt')?.mode).toBe('100644');
      });
    });
  });
});

describe('createFsWorkdirEnumerator — mtimeNs conditional spread', () => {
  describe('Given an lstat that returns mtimeNs', () => {
    describe('When enumerate yields the row', () => {
      it('Then stat.mtimeNs is preserved in the WorkdirStat', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'with-ns.txt');
        const fs = wrapFsWithStat(ctx.fs, async (p) => ({
          ...(await ctx.fs.lstat(p)),
          mtimeNs: 4242n,
        }));
        const sut: WorkdirEnumerator = createFsWorkdirEnumerator();

        // Act
        const rows = await collect(sut.enumerate({ ...ctx, fs }, {}));

        // Assert
        expect(rows.find((r) => r.path === 'with-ns.txt')?.stat.mtimeNs).toBe(4242n);
      });
    });
  });

  describe('Given an lstat that returns mtimeNs=undefined', () => {
    describe('When enumerate yields the row', () => {
      it('Then the mtimeNs key is ABSENT from the WorkdirStat (not present-but-undefined)', async () => {
        // Arrange — memory FS leaves mtimeNs undefined naturally
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'no-ns.txt');
        const sut: WorkdirEnumerator = createFsWorkdirEnumerator();

        // Act
        const rows = await collect(sut.enumerate(ctx, {}));

        // Assert — using `in` instead of value-equality so the test
        // distinguishes between an absent key and `{ mtimeNs: undefined }`.
        // A mutant that always spreads `{ mtimeNs: stat.mtimeNs }` even
        // when the input is undefined would produce a key-present row.
        const row = rows.find((r) => r.path === 'no-ns.txt');
        expect(row).toBeDefined();
        expect(row?.stat && 'mtimeNs' in row.stat).toBe(false);
      });
    });
  });
});

describe('createFsWorkdirEnumerator — ctx.signal abort', () => {
  describe('Given a pre-aborted ctx.signal (not opts.signal)', () => {
    describe('When enumerate is iterated', () => {
      it('Then iteration throws OPERATION_ABORTED before yielding', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        const controller = new AbortController();
        controller.abort();
        const abortedCtx: Context = { ...ctx, signal: controller.signal };
        const sut = createFsWorkdirEnumerator();

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut.enumerate(abortedCtx, {})) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'OPERATION_ABORTED' },
        });
      });
    });
  });

  describe('Given a signal that aborts mid-iteration', () => {
    describe('When enumerate yields the first row then the signal fires', () => {
      it('Then the next iteration throws OPERATION_ABORTED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        await seedFile(ctx, 'b.txt');
        const controller = new AbortController();
        const sut = createFsWorkdirEnumerator();

        // Act
        const iter = sut.enumerate(ctx, { signal: controller.signal })[Symbol.asyncIterator]();
        const first = await iter.next();
        controller.abort();

        // Assert
        expect(first.done).toBe(false);
        await expect(iter.next()).rejects.toMatchObject({
          data: { code: 'OPERATION_ABORTED' },
        });
      });
    });
  });
});

describe('createFsWorkdirEnumerator — option forwarding to walkWorkingTree', () => {
  describe('Given opts.maxDepth set explicitly', () => {
    describe('When the workdir contains nested directories exceeding maxDepth', () => {
      it('Then enumeration throws TREE_DEPTH_EXCEEDED', async () => {
        // Arrange — workdir/a/b/c.txt requires depth 3.
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a/b/c.txt');
        const sut = createFsWorkdirEnumerator();

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut.enumerate(ctx, { maxDepth: 1 })) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'TREE_DEPTH_EXCEEDED' },
        });
      });
    });
  });

  describe('Given opts.maxEntries set below the actual count', () => {
    describe('When enumeration proceeds', () => {
      it('Then it throws TREE_ENTRY_LIMIT_EXCEEDED (already covered, dup retained for the conditional-spread branch)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        await seedFile(ctx, 'b.txt');
        await seedFile(ctx, 'c.txt');
        const sut = createFsWorkdirEnumerator();

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut.enumerate(ctx, { maxEntries: 2 })) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'TREE_ENTRY_LIMIT_EXCEEDED' },
        });
      });
    });
  });

  describe('Given opts.excludes that drops a leaf', () => {
    describe('When enumeration proceeds', () => {
      it('Then the excluded leaf is not yielded', async () => {
        // Arrange — drop only `b.txt`; `a.txt` survives.
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        await seedFile(ctx, 'b.txt');
        const excludes: WalkIgnorePredicate = (path, isDir) => !isDir && path === 'b.txt';
        const sut = createFsWorkdirEnumerator();

        // Act
        const rows = await collect(sut.enumerate(ctx, { excludes }));

        // Assert
        expect(rows.map((r) => r.path).sort()).toEqual(['a.txt']);
      });
    });
  });
});

describe('createFsWorkdirEnumerator — live (non-aborted) ctx.signal', () => {
  describe('Given a ctx.signal that is present but not aborted', () => {
    describe('When enumerate is iterated', () => {
      it('Then the file is still yielded (a live signal never triggers an abort)', async () => {
        // Arrange — a live signal means `ctx.signal.aborted === false`.
        const controller = new AbortController();
        const ctx = await buildSeededContext({ signal: controller.signal });
        await seedFile(ctx, 'a.txt');
        const sut = createFsWorkdirEnumerator();

        // Act
        const rows = await collect(sut.enumerate(ctx, {}));

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['a.txt']);
        expect(rows[0]?.kind).toBe('file');
      });
    });
  });
});

describe('createFsWorkdirEnumerator — pre-loop abort guard (opts.signal, empty walk)', () => {
  describe('Given a pre-aborted opts.signal and a walk whose every leaf is excluded', () => {
    describe('When enumerate is iterated', () => {
      it('Then the pre-loop guard raises OPERATION_ABORTED even though no row is walked', async () => {
        // Arrange — excluding every leaf makes the inner walk yield nothing,
        // so only the pre-loop guard (not the per-row guard) can abort.
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        const controller = new AbortController();
        controller.abort();
        const dropEveryLeaf: WalkIgnorePredicate = (_path, isDir) => !isDir;
        const sut = createFsWorkdirEnumerator();

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut.enumerate(ctx, {
            signal: controller.signal,
            excludes: dropEveryLeaf,
          })) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'OPERATION_ABORTED' },
        });
      });
    });
  });
});
