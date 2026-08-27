import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { walkWorkingTree } from '../../../../src/application/primitives/walk-working-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Context } from '../../../../src/ports/context.js';
import {
  seedDeepEmptyWorkingTree,
  seedDeepWorkingTree,
  seedDeepWorkingTreeWithNearBottomLeaf,
  seedMaxTreeDepth,
} from './fixtures.js';

const seedFs = async (
  workingTree: Readonly<Record<string, string>>,
  options?: { signal?: AbortSignal },
): Promise<Context> => {
  const ctx =
    options?.signal === undefined
      ? createMemoryContext()
      : createMemoryContext({ signal: options.signal });
  for (const [path, content] of Object.entries(workingTree)) {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
  }
  return ctx;
};

const collect = async (it: AsyncIterable<{ readonly path: string }>): Promise<string[]> => {
  const out: string[] = [];
  for await (const entry of it) out.push(entry.path);
  return out;
};

const expectError = async (fn: () => Promise<unknown>, code: string): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(code);
  return caught as TsgitError;
};

describe('walkWorkingTree', () => {
  describe('Given an empty working tree', () => {
    describe('When walked', () => {
      it('Then yields nothing', async () => {
        // Arrange
        const ctx = await seedFs({});

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given two files at the root', () => {
    describe('When walked', () => {
      it('Then yields both', async () => {
        // Arrange
        const ctx = await seedFs({ 'a.txt': '1', 'b.txt': '2' });

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert
        expect(result.sort()).toEqual(['a.txt', 'b.txt']);
      });
    });
  });

  describe('Given nested directories', () => {
    describe('When walked', () => {
      it('Then DFS yields every leaf', async () => {
        // Arrange
        const ctx = await seedFs({
          'a/b/c.txt': 'x',
          'a/d.txt': 'y',
          'e.txt': 'z',
        });

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert
        expect(result.sort()).toEqual(['a/b/c.txt', 'a/d.txt', 'e.txt']);
      });
    });
  });

  describe('Given a `.git` marker at the root (exact name or case, folded only — narrow git parity)', () => {
    describe('When walked', () => {
      it.each([
        {
          path: '.git/HEAD',
          content: 'ref: refs/heads/main\n',
          label: 'a `.git` directory is skipped',
        },
        {
          path: '.GIT/HEAD',
          content: 'x',
          label: 'a `.GIT` directory is skipped (case-insensitive, matches core.ignorecase=true)',
        },
        {
          path: '.git',
          content: 'gitdir: /elsewhere',
          label: 'a regular file literally named `.git` is skipped but its siblings are yielded',
        },
      ])('Then $label', async ({ path, content }) => {
        // Arrange
        const ctx = await seedFs({ 'a.txt': '1', [path]: content });

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert
        expect(result).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a widened-alias name at the root that only the index-write boundary rejects (git-parity: the walk skips only exact `.git`)', () => {
    describe('When walked', () => {
      it.each([
        {
          path: 'git~1/HEAD',
          content: 'ref: refs/heads/main\n',
          label: 'a `git~1` directory (NTFS short-name alias) is walked, not skipped',
        },
        {
          path: '.git /HEAD',
          content: 'x',
          label: 'a `.git ` (trailing space) directory is walked, not skipped',
        },
        {
          path: '.git./HEAD',
          content: 'x',
          label: 'a `.git.` (trailing dot) directory is walked, not skipped',
        },
        {
          path: '.git:stream/HEAD',
          content: 'x',
          label: 'a `.git:stream` (NTFS ADS alias) directory is walked, not skipped',
        },
      ])('Then $label', async ({ path, content }) => {
        // Arrange — verified against real git's readdir walk (git 2.55.0,
        // darwin): `git status --porcelain -uall` reports every one of
        // these as `??`, never collapsing the directory the way it does
        // for an exact (case-folded) `.git`.
        const ctx = await seedFs({ 'a.txt': '1', [path]: content });

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert — both the marker-named directory's file and the sibling
        // are yielded; nothing is collapsed.
        expect(result.sort()).toEqual([path, 'a.txt'].sort());
      });
    });
  });

  describe('Given a nested.git directory (embedded repo)', () => {
    describe('When walked', () => {
      it('Then the whole directory is skipped', async () => {
        // Arrange — vendor/lib looks like an embedded git repo.
        const ctx = await seedFs({
          'a.txt': '1',
          'vendor/lib/.git/HEAD': 'ref: refs/heads/main',
          'vendor/lib/src/x.ts': 'x',
        });

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert — only the top-level file is yielded; nothing under vendor/lib.
        expect(result).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a nested `git~1` directory (NTFS short-name alias — walked, not an embedded-repo marker)', () => {
    describe('When walked', () => {
      it("Then the git~1 directory's own file AND its unrelated siblings are all yielded", async () => {
        // Arrange — `git~1` is git's NTFS 8.3 short name for `.git`, but the
        // walker's embedded-repo marker is narrowly exact `.git` (case-folded
        // only): git~1 is not a marker, so vendor/lib is an ordinary
        // directory and everything under it is walked.
        const ctx = await seedFs({
          'a.txt': '1',
          'vendor/lib/git~1/HEAD': 'ref: refs/heads/main',
          'vendor/lib/src/x.ts': 'x',
        });

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert — nothing is collapsed; every leaf is yielded.
        expect(result.sort()).toEqual(
          ['a.txt', 'vendor/lib/git~1/HEAD', 'vendor/lib/src/x.ts'].sort(),
        );
      });
    });
  });

  describe('Given a symlink leaf', () => {
    describe('When walked', () => {
      it('Then yields with isSymbolicLink=true', async () => {
        // Arrange
        const ctx = await seedFs({ 'a.txt': '1' });
        await ctx.fs.symlink('a.txt', `${ctx.layout.workDir}/link`);

        // Act
        const entries: Array<{ path: string; isSymbolicLink: boolean }> = [];
        for await (const e of walkWorkingTree(ctx)) {
          entries.push({ path: e.path, isSymbolicLink: e.isSymbolicLink });
        }
        const linkEntry = entries.find((e) => e.path === 'link');

        // Assert
        expect(linkEntry?.isSymbolicLink).toBe(true);
      });
    });
  });

  describe('Given a leaf yielded by the walker', () => {
    const trackLstat = (ctx: Context): { readonly ctx: Context; calls: () => number } => {
      const baseLstat = ctx.fs.lstat;
      let calls = 0;
      const trackingFs = new Proxy(ctx.fs, {
        get(target, prop, receiver) {
          if (prop === 'lstat') {
            return async (p: string) => {
              calls += 1;
              return baseLstat(p);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return { ctx: { ...ctx, fs: trackingFs }, calls: () => calls };
    };

    describe('When only entry.path is read (never entry.stat)', () => {
      it('Then ctx.fs.lstat is never called', async () => {
        // Arrange
        const seeded = await seedFs({ 'a.txt': '1', 'b.txt': '2' });
        const { ctx, calls } = trackLstat(seeded);

        // Act
        await collect(walkWorkingTree(ctx));

        // Assert
        expect(calls()).toBe(0);
      });
    });

    describe('When entry.stat() is read once per entry', () => {
      it('Then ctx.fs.lstat is called exactly once per entry', async () => {
        // Arrange
        const seeded = await seedFs({ 'a.txt': '1', 'b.txt': '2' });
        const { ctx, calls } = trackLstat(seeded);

        // Act
        for await (const entry of walkWorkingTree(ctx)) {
          await entry.stat();
        }

        // Assert
        expect(calls()).toBe(2);
      });
    });

    describe('When entry.stat() is read twice for the same entry', () => {
      it('Then ctx.fs.lstat is called exactly once (memoised)', async () => {
        // Arrange
        const seeded = await seedFs({ 'a.txt': '1' });
        const { ctx, calls } = trackLstat(seeded);

        // Act
        for await (const entry of walkWorkingTree(ctx)) {
          await entry.stat();
          await entry.stat();
        }

        // Assert
        expect(calls()).toBe(1);
      });
    });
  });

  describe('Given a pre-aborted ctx.signal', () => {
    describe('When walked', () => {
      it('Then throws OPERATION_ABORTED', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const ctx = await seedFs({ 'a.txt': '1' }, { signal: controller.signal });

        // Act + Assert
        await expectError(() => collect(walkWorkingTree(ctx)), 'OPERATION_ABORTED');
      });
    });
  });

  describe('Given the signal aborts AFTER the first yield', () => {
    describe('When walked further', () => {
      it('Then throws OPERATION_ABORTED (in-loop check)', async () => {
        // Arrange — controller stays live until we consume one entry.
        const controller = new AbortController();
        const ctx = await seedFs({ 'a.txt': '1', 'b.txt': '2' }, { signal: controller.signal });

        // Act
        let caught: unknown;
        try {
          for await (const _entry of walkWorkingTree(ctx)) {
            controller.abort();
          }
        } catch (err) {
          caught = err;
        }

        // Assert — the abort fires in the iteration's signal check on the
        // SECOND entry, proving the guard is per-entry (not hoisted before
        // the loop).
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });

  describe('Given depth above maxDepth', () => {
    describe('When walked', () => {
      it('Then throws TREE_DEPTH_EXCEEDED carrying the offending depth', async () => {
        // Arrange — depth 3 hierarchy with cap at 2.
        const ctx = await seedFs({ 'a/b/c/d.txt': 'x' });

        // Act
        const err = await expectError(
          () => collect(walkWorkingTree(ctx, { maxDepth: 2 })),
          'TREE_DEPTH_EXCEEDED',
        );

        // Assert — payload pin: depth that tripped the guard.
        expect((err.data as { depth: number }).depth).toBe(3);
      });
    });
  });

  describe('Given depth exactly at maxDepth', () => {
    describe('When walked', () => {
      it('Then yields without throwing (boundary)', async () => {
        // Arrange — depth 2 hierarchy, maxDepth 2. Kills off-by-one mutants
        // on the depth guard (`>` vs `>=`).
        const ctx = await seedFs({ 'a/b/c.txt': 'x' });

        // Act
        const result = await collect(walkWorkingTree(ctx, { maxDepth: 2 }));

        // Assert
        expect(result).toEqual(['a/b/c.txt']);
      });
    });
  });

  describe('Given a working tree exactly 2048 levels deep (config unset, default cap), with a leaf one level short of the bottom', () => {
    describe('When walked', () => {
      it('Then it yields exactly that leaf, proving genuine descent (positive boundary)', async () => {
        // Arrange — a leaf at the very bottom (depth 2048) does not fit:
        // validateWalkedEntryPath's OWN 4096-byte total-path cap (independent
        // of core.maxTreeDepth) would be 2*2048+1 = 4097 bytes for a
        // 1-character leaf there, one byte over. One level up, at depth
        // 2047, the same 1-character leaf's path is 2*2048-1 = 4095 bytes —
        // safely under the cap — so the leaf is planted there while the
        // deepest directory (2048) stays empty, preserving the "completes
        // exactly at the default cap" boundary this fixture also proves.
        // 2048 is the default cap, not a measured ceiling; the
        // explicit-stack walker has no frame ceiling to gamble against.
        const ctx = createMemoryContext();
        const leafPath = await seedDeepWorkingTreeWithNearBottomLeaf(ctx, 2048);

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert — a frame-push regression that stops descending short of
        // the leaf, or one that never reaches the empty 2048th directory
        // (still drained by the walk above), fails this; the previous
        // `toEqual([])` oracle could not distinguish either from a correct
        // full descent.
        expect(result).toEqual([leafPath]);
      });
    });
  });

  describe('Given a working tree 2049 levels deep (config unset, default cap)', () => {
    describe('When walked', () => {
      it('Then throws PATHSPEC_OUTSIDE_REPO, never a raw RangeError', async () => {
        // Arrange — a 2049-segment path cannot be constructed at all under
        // validateWalkedEntryPath's independent 4096-byte total-path cap,
        // even with 1-character directory names (2*2049-1 = 4097 > 4096):
        // that guard fires on the 2049th directory's own entry, before the
        // depth guard (checked one entry later) ever runs. The default
        // cap's own "throws past cap" side is exercised at a small
        // configured cap below, comfortably inside the path-length budget;
        // this test instead pins that no raw RangeError resurfaces here.
        const ctx = createMemoryContext();
        await seedDeepEmptyWorkingTree(ctx, 2049);

        // Act + Assert
        await expectError(() => collect(walkWorkingTree(ctx)), 'PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given core.maxTreeDepth configured to a small cap', () => {
    const SMALL_CAP = 4;

    describe('When a working tree exactly at the configured cap is walked', () => {
      it('Then completes and yields the leaf entry (boundary)', async () => {
        // Arrange — the guard is `depth > maxDepth`, so a frame entered at
        // exactly `maxDepth` must NOT raise TREE_DEPTH_EXCEEDED.
        const ctx = createMemoryContext();
        await seedMaxTreeDepth(ctx, String(SMALL_CAP));
        await seedDeepWorkingTree(ctx, SMALL_CAP);

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert
        expect(result).toHaveLength(1);
      });
    });

    describe('When a working tree one level past the configured cap is walked', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with depth = cap + 1', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedMaxTreeDepth(ctx, String(SMALL_CAP));
        await seedDeepWorkingTree(ctx, SMALL_CAP + 1);

        // Act
        const err = await expectError(() => collect(walkWorkingTree(ctx)), 'TREE_DEPTH_EXCEEDED');

        // Assert
        expect((err.data as { depth: number }).depth).toBe(SMALL_CAP + 1);
      });
    });

    describe('When a working tree far past the configured cap is walked', () => {
      it('Then throws at depth = cap + 1, never the fixture depth or a RangeError', async () => {
        // Arrange — 20x past the cap, proving the guard fires at the cap
        // boundary rather than deferring to the fixture's structural depth.
        const ctx = createMemoryContext();
        await seedMaxTreeDepth(ctx, String(SMALL_CAP));
        await seedDeepWorkingTree(ctx, SMALL_CAP * 20);

        // Act
        const err = await expectError(() => collect(walkWorkingTree(ctx)), 'TREE_DEPTH_EXCEEDED');

        // Assert
        expect((err.data as { depth: number }).depth).toBe(SMALL_CAP + 1);
      });
    });
  });

  describe('Given the same depth-5 working tree tested at two different core.maxTreeDepth values', () => {
    describe('When core.maxTreeDepth = 5', () => {
      it('Then completes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedMaxTreeDepth(ctx, '5');
        await seedDeepWorkingTree(ctx, 5);

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert
        expect(result).toHaveLength(1);
      });
    });

    describe('When core.maxTreeDepth = 4', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with depth = 5', async () => {
        // Arrange — the SAME fixture shape, only the configured cap changes:
        // a site that ignored config would pass the pair above against a
        // hardcoded value and fail only here.
        const ctx = createMemoryContext();
        await seedMaxTreeDepth(ctx, '4');
        await seedDeepWorkingTree(ctx, 5);

        // Act
        const err = await expectError(() => collect(walkWorkingTree(ctx)), 'TREE_DEPTH_EXCEEDED');

        // Assert
        expect((err.data as { depth: number }).depth).toBe(5);
      });
    });
  });

  describe('Given entries above maxEntries', () => {
    describe('When walked', () => {
      it('Then throws TREE_ENTRY_LIMIT_EXCEEDED carrying count and limit', async () => {
        // Arrange
        const ctx = await seedFs({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' });

        // Act
        const err = await expectError(
          () => collect(walkWorkingTree(ctx, { maxEntries: 2 })),
          'TREE_ENTRY_LIMIT_EXCEEDED',
        );

        // Assert — payload pin: 3rd entry over the limit of 2.
        const data = err.data as { count: number; limit: number };
        expect(data.count).toBe(3);
        expect(data.limit).toBe(2);
      });
    });
  });

  describe('Given entries exactly at maxEntries', () => {
    describe('When walked', () => {
      it('Then yields all (boundary)', async () => {
        // Arrange — 2 entries, cap 2. Kills off-by-one mutants on the entry guard.
        const ctx = await seedFs({ 'a.txt': '1', 'b.txt': '2' });

        // Act
        const result = await collect(walkWorkingTree(ctx, { maxEntries: 2 }));

        // Assert
        expect(result.sort()).toEqual(['a.txt', 'b.txt']);
      });
    });
  });

  describe('Given a hostile readdir that returns a `..` segment', () => {
    describe('When walked', () => {
      it('Then throws PATHSPEC_OUTSIDE_REPO', async () => {
        // Arrange — wrap fs.readdir to inject a `..` entry once.
        const ctx = await seedFs({});
        const baseReaddir = ctx.fs.readdir;
        const hostileFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'readdir') {
              return async (path: string) => {
                const real = await baseReaddir(path);
                if (path === ctx.layout.workDir) {
                  return [
                    ...real,
                    { name: '..', isFile: true, isDirectory: false, isSymbolicLink: false },
                  ];
                }
                return real;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const hostileCtx = { ...ctx, fs: hostileFs };

        // Act + Assert
        await expectError(() => collect(walkWorkingTree(hostileCtx)), 'PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given a hostile readdir that yields a non-file / non-dir / non-symlink entry (e.g. block device)', () => {
    describe('When walked', () => {
      it('Then it is silently skipped', async () => {
        // Arrange — kills the `if (!entry.isFile && !entry.isSymbolicLink)`
        // mutant that drops the early return: without the return, lstat would
        // be called on a non-existent leaf and yield bogus data.
        const ctx = await seedFs({ 'a.txt': '1' });
        const baseReaddir = ctx.fs.readdir;
        const hostileFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'readdir') {
              return async (path: string) => {
                const real = await baseReaddir(path);
                if (path === ctx.layout.workDir) {
                  return [
                    ...real,
                    { name: 'phantom', isFile: false, isDirectory: false, isSymbolicLink: false },
                  ];
                }
                return real;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const hostileCtx = { ...ctx, fs: hostileFs };

        // Act
        const result = await collect(walkWorkingTree(hostileCtx));

        // Assert — phantom skipped; real file yielded.
        expect(result).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a hostile readdir that yields a `.git` entry with only `isDirectory=true` (no isFile)', () => {
    describe('When walked at a nested dir', () => {
      it('Then the directory is treated as embedded and skipped', async () => {
        // Arrange — covers the `entry.isDirectory` branch of isEmbeddedGitMarker
        // alone (no isFile flag) so a mutant that drops the isDirectory check
        // is killed.
        const ctx = await seedFs({ 'sub/sibling.txt': 's' });
        const baseReaddir = ctx.fs.readdir;
        const hostileFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'readdir') {
              return async (path: string) => {
                const real = await baseReaddir(path);
                if (path.endsWith('/sub')) {
                  return [
                    ...real,
                    { name: '.git', isFile: false, isDirectory: true, isSymbolicLink: false },
                  ];
                }
                return real;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const hostileCtx = { ...ctx, fs: hostileFs };

        // Act
        const result = await collect(walkWorkingTree(hostileCtx));

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a hostile readdir that yields a `.git` entry with no file/dir/symlink flag', () => {
    describe('When walked at a nested dir', () => {
      it('Then the directory is NOT embedded and siblings are still yielded', async () => {
        // Arrange — a `.git` entry that is neither a directory nor a regular file
        // (e.g. a socket or FIFO) is NOT an embedded-repo marker. The marker test
        // requires `isFile && !isSymbolicLink`; a mutant turning that `&&` into `||`
        // would wrongly treat this entry as a marker and collapse the parent.
        const ctx = await seedFs({ 'sub/sibling.txt': 's' });
        const baseReaddir = ctx.fs.readdir;
        const hostileFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'readdir') {
              return async (path: string) => {
                const real = await baseReaddir(path);
                if (path.endsWith('/sub')) {
                  return [
                    ...real,
                    { name: '.git', isFile: false, isDirectory: false, isSymbolicLink: false },
                  ];
                }
                return real;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const hostileCtx = { ...ctx, fs: hostileFs };

        // Act
        const result = await collect(walkWorkingTree(hostileCtx));

        // Assert — the directory is walked normally; its real sibling is yielded.
        expect(result).toEqual(['sub/sibling.txt']);
      });
    });
  });

  describe('Given an ignore predicate that drops one leaf', () => {
    describe('When walked', () => {
      it('Then only the other leaf is yielded', async () => {
        // Arrange
        const ctx = await seedFs({ 'a.txt': '1', 'b.txt': '2' });
        const ignore = (path: string) => path === 'a.txt';

        // Act
        const result = await collect(walkWorkingTree(ctx, { ignore }));

        // Assert
        expect(result).toEqual(['b.txt']);
      });
    });
  });

  describe('Given an ignore predicate that prunes a directory', () => {
    describe('When walked', () => {
      it('Then NO leaf under it is yielded AND no lstat is invoked for those leaves', async () => {
        // Arrange — count lstats inside the pruned subtree.
        const ctx = await seedFs({
          'kept.txt': 'k',
          'pruned/a.txt': 'a',
          'pruned/sub/b.txt': 'b',
        });
        const baseLstat = ctx.fs.lstat;
        let lstatsInsidePruned = 0;
        const trackingFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'lstat') {
              return async (p: string) => {
                if (p.includes('/pruned/')) lstatsInsidePruned += 1;
                return baseLstat(p);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const trackingCtx = { ...ctx, fs: trackingFs };
        const ignore = (_path: string, isDir: boolean) => isDir; // prune the only directory

        // Act
        const result = await collect(walkWorkingTree(trackingCtx, { ignore }));

        // Assert — only the root file yielded; no descent into `pruned/`.
        expect(result).toEqual(['kept.txt']);
        expect(lstatsInsidePruned).toBe(0);
      });
    });
  });

  describe('Given an async ignore predicate', () => {
    describe('When walked', () => {
      it('Then the walker awaits it', async () => {
        // Arrange
        const ctx = await seedFs({ 'sync.txt': '1', 'asyncfile.txt': '2' });
        const ignore = async (path: string) => {
          await Promise.resolve();
          return path.startsWith('async');
        };

        // Act
        const result = await collect(walkWorkingTree(ctx, { ignore }));

        // Assert
        expect(result).toEqual(['sync.txt']);
      });
    });
  });

  describe('Given no ignore option', () => {
    describe('When walked', () => {
      it('Then behaviour is unchanged from (regression pin)', async () => {
        // Arrange
        const ctx = await seedFs({ 'a.txt': '1', 'b.txt': '2' });

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert — both yielded; no filtering.
        expect(result.sort()).toEqual(['a.txt', 'b.txt']);
      });
    });
  });

  describe('Given an embedded repo at the top level (workDir IS a repo)', () => {
    describe('When walked', () => {
      it('Then only.git is skipped (workDir is not embedded)', async () => {
        // Arrange — distinguish "I am a repo" from "I contain an embedded repo".
        // The workDir has its own.git (we're scanning the host repo), so the
        // pre-scan must NOT treat the host repo's own.git as an embedded marker.
        const ctx = await seedFs({ 'a.txt': '1', 'b/c.txt': 'x' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.git/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert — yielded normal entries;.git skipped; b/c.txt yielded.
        expect(result.sort()).toEqual(['a.txt', 'b/c.txt']);
      });
    });
  });

  describe('Given a non-root directory containing a `.git` DIRECTORY, with a sibling directory at the same level', () => {
    describe('When walked', () => {
      it('Then nothing under the embedded directory is yielded, but its sibling is', async () => {
        // Arrange — one test per embedded-repo-gate condition: this one
        // isolates the `.git` DIRECTORY marker alone.
        const ctx = await seedFs({
          'embedded/.git/HEAD': 'ref: refs/heads/main\n',
          'embedded/file.txt': 'x',
          'sibling/file.txt': 'y',
        });

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert
        expect(result).toEqual(['sibling/file.txt']);
      });
    });
  });

  describe('Given a non-root directory containing a `.git` REGULAR FILE (a worktree gitdir pointer)', () => {
    describe('When walked', () => {
      it('Then the directory is treated as embedded and yields nothing under it', async () => {
        // Arrange — isolates the `.git` FILE marker alone, distinct from
        // the DIRECTORY marker above.
        const ctx = await seedFs({
          'checkout/.git': 'gitdir: /elsewhere/.git/worktrees/checkout\n',
          'checkout/file.txt': 'x',
          'sibling.txt': 'y',
        });

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert
        expect(result).toEqual(['sibling.txt']);
      });
    });
  });

  describe('Given a non-root directory containing a `.git` SYMLINK (neither a directory nor a regular file)', () => {
    describe('When walked', () => {
      it('Then the directory is NOT treated as embedded and its file is yielded', async () => {
        // Arrange — a stray `.git` symlink must NOT be a marker: treating it
        // as one would let an attacker silently hide siblings by planting a
        // symlink literally named `.git`. The symlink entry itself is still
        // skipped (isDotGitWalkEntry), but the directory is walked normally.
        const ctx = await seedFs({ 'checkout/file.txt': 'x' });
        await ctx.fs.symlink('/elsewhere/.git', `${ctx.layout.workDir}/checkout/.git`);

        // Act
        const result = await collect(walkWorkingTree(ctx));

        // Assert
        expect(result).toEqual(['checkout/file.txt']);
      });
    });
  });
});
