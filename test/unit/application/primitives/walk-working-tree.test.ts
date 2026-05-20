import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { walkWorkingTree } from '../../../../src/application/primitives/walk-working-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Context } from '../../../../src/ports/context.js';

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
  it('Given an empty working tree, When walked, Then yields nothing', async () => {
    // Arrange
    const ctx = await seedFs({});

    // Act
    const sut = await collect(walkWorkingTree(ctx));

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given two files at the root, When walked, Then yields both', async () => {
    // Arrange
    const ctx = await seedFs({ 'a.txt': '1', 'b.txt': '2' });

    // Act
    const sut = await collect(walkWorkingTree(ctx));

    // Assert
    expect(sut.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('Given nested directories, When walked, Then DFS yields every leaf', async () => {
    // Arrange
    const ctx = await seedFs({
      'a/b/c.txt': 'x',
      'a/d.txt': 'y',
      'e.txt': 'z',
    });

    // Act
    const sut = await collect(walkWorkingTree(ctx));

    // Assert
    expect(sut.sort()).toEqual(['a/b/c.txt', 'a/d.txt', 'e.txt']);
  });

  it('Given a.git directory at the root, When walked, Then it is skipped', async () => {
    // Arrange
    const ctx = await seedFs({ 'a.txt': '1' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.git/HEAD`, 'ref: refs/heads/main\n');

    // Act
    const sut = await collect(walkWorkingTree(ctx));

    // Assert
    expect(sut).toEqual(['a.txt']);
  });

  it('Given a nested.git directory (embedded repo), When walked, Then the whole directory is skipped', async () => {
    // Arrange — vendor/lib looks like an embedded git repo.
    const ctx = await seedFs({
      'a.txt': '1',
      'vendor/lib/.git/HEAD': 'ref: refs/heads/main',
      'vendor/lib/src/x.ts': 'x',
    });

    // Act
    const sut = await collect(walkWorkingTree(ctx));

    // Assert — only the top-level file is yielded; nothing under vendor/lib.
    expect(sut).toEqual(['a.txt']);
  });

  it('Given a.GIT directory (uppercase), When walked, Then it is skipped (case-insensitive)', async () => {
    // Arrange
    const ctx = await seedFs({ 'a.txt': '1', '.GIT/HEAD': 'x' });

    // Act
    const sut = await collect(walkWorkingTree(ctx));

    // Assert
    expect(sut).toEqual(['a.txt']);
  });

  it('Given a `.git ` (trailing space) directory, When walked, Then it is skipped (NTFS hardening)', async () => {
    // Arrange
    const ctx = await seedFs({ 'a.txt': '1', '.git /HEAD': 'x' });

    // Act
    const sut = await collect(walkWorkingTree(ctx));

    // Assert
    expect(sut).toEqual(['a.txt']);
  });

  it('Given a symlink leaf, When walked, Then yields with isSymbolicLink=true', async () => {
    // Arrange
    const ctx = await seedFs({ 'a.txt': '1' });
    await ctx.fs.symlink('a.txt', `${ctx.layout.workDir}/link`);

    // Act
    const entries: Array<{ path: string; stat: { isSymbolicLink: boolean } }> = [];
    for await (const e of walkWorkingTree(ctx)) entries.push({ path: e.path, stat: e.stat });
    const sut = entries.find((e) => e.path === 'link');

    // Assert
    expect(sut?.stat.isSymbolicLink).toBe(true);
  });

  it('Given a pre-aborted ctx.signal, When walked, Then throws OPERATION_ABORTED', async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort();
    const ctx = await seedFs({ 'a.txt': '1' }, { signal: controller.signal });

    // Act
    await expectError(() => collect(walkWorkingTree(ctx)), 'OPERATION_ABORTED');
  });

  it('Given the signal aborts AFTER the first yield, When walked further, Then throws OPERATION_ABORTED (in-loop check)', async () => {
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

  it('Given a regular file literally named.git (not a directory), When walked, Then it is skipped but its siblings are yielded', async () => {
    // Arrange — a `.git` REGULAR FILE inside a subdir means git-worktree
    // pointer (treated as embedded). A `.git` regular file at the root
    // is the host's worktree pointer — also treated as a marker. Either
    // way, the file is filtered. This test ensures a stray `.git` plain
    // file at the root does NOT collapse siblings.
    const ctx = await seedFs({ 'a.txt': '1', '.git': 'gitdir: /elsewhere' });

    // Act
    const sut = await collect(walkWorkingTree(ctx));

    // Assert — `.git` skipped, sibling yielded.
    expect(sut).toEqual(['a.txt']);
  });

  it('Given depth above maxDepth, When walked, Then throws TREE_DEPTH_EXCEEDED carrying the offending depth', async () => {
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

  it('Given depth exactly at maxDepth, When walked, Then yields without throwing (boundary)', async () => {
    // Arrange — depth 2 hierarchy, maxDepth 2. Kills off-by-one mutants
    // on the depth guard (`>` vs `>=`).
    const ctx = await seedFs({ 'a/b/c.txt': 'x' });

    // Act
    const sut = await collect(walkWorkingTree(ctx, { maxDepth: 2 }));

    // Assert
    expect(sut).toEqual(['a/b/c.txt']);
  });

  it('Given entries above maxEntries, When walked, Then throws TREE_ENTRY_LIMIT_EXCEEDED carrying count and limit', async () => {
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

  it('Given entries exactly at maxEntries, When walked, Then yields all (boundary)', async () => {
    // Arrange — 2 entries, cap 2. Kills off-by-one mutants on the entry guard.
    const ctx = await seedFs({ 'a.txt': '1', 'b.txt': '2' });

    // Act
    const sut = await collect(walkWorkingTree(ctx, { maxEntries: 2 }));

    // Assert
    expect(sut.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('Given a hostile readdir that returns a `..` segment, When walked, Then throws PATHSPEC_OUTSIDE_REPO', async () => {
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

    // Act
    await expectError(() => collect(walkWorkingTree(hostileCtx)), 'PATHSPEC_OUTSIDE_REPO');
  });

  it('Given a hostile readdir that yields a non-file / non-dir / non-symlink entry (e.g. block device), When walked, Then it is silently skipped', async () => {
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
    const sut = await collect(walkWorkingTree(hostileCtx));

    // Assert — phantom skipped; real file yielded.
    expect(sut).toEqual(['a.txt']);
  });

  it('Given a hostile readdir that yields a `.git` entry with only `isDirectory=true` (no isFile), When walked at a nested dir, Then the directory is treated as embedded and skipped', async () => {
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
    const sut = await collect(walkWorkingTree(hostileCtx));

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a hostile readdir that yields a `.git` entry with no file/dir/symlink flag, When walked at a nested dir, Then the directory is NOT embedded and siblings are still yielded', async () => {
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
    const sut = await collect(walkWorkingTree(hostileCtx));

    // Assert — the directory is walked normally; its real sibling is yielded.
    expect(sut).toEqual(['sub/sibling.txt']);
  });

  it('Given an ignore predicate that drops one leaf, When walked, Then only the other leaf is yielded', async () => {
    // Arrange
    const ctx = await seedFs({ 'a.txt': '1', 'b.txt': '2' });
    const ignore = (path: string) => path === 'a.txt';

    // Act
    const sut = await collect(walkWorkingTree(ctx, { ignore }));

    // Assert
    expect(sut).toEqual(['b.txt']);
  });

  it('Given an ignore predicate that prunes a directory, When walked, Then NO leaf under it is yielded AND no lstat is invoked for those leaves', async () => {
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
    const sut = await collect(walkWorkingTree(trackingCtx, { ignore }));

    // Assert — only the root file yielded; no descent into `pruned/`.
    expect(sut).toEqual(['kept.txt']);
    expect(lstatsInsidePruned).toBe(0);
  });

  it('Given an async ignore predicate, When walked, Then the walker awaits it', async () => {
    // Arrange
    const ctx = await seedFs({ 'sync.txt': '1', 'asyncfile.txt': '2' });
    const ignore = async (path: string) => {
      await Promise.resolve();
      return path.startsWith('async');
    };

    // Act
    const sut = await collect(walkWorkingTree(ctx, { ignore }));

    // Assert
    expect(sut).toEqual(['sync.txt']);
  });

  it('Given no ignore option, When walked, Then behaviour is unchanged from (regression pin)', async () => {
    // Arrange
    const ctx = await seedFs({ 'a.txt': '1', 'b.txt': '2' });

    // Act
    const sut = await collect(walkWorkingTree(ctx));

    // Assert — both yielded; no filtering.
    expect(sut.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('Given an embedded repo at the top level (workDir IS a repo), When walked, Then only.git is skipped (workDir is not embedded)', async () => {
    // Arrange — distinguish "I am a repo" from "I contain an embedded repo".
    // The workDir has its own.git (we're scanning the host repo), so the
    // pre-scan must NOT treat the host repo's own.git as an embedded marker.
    const ctx = await seedFs({ 'a.txt': '1', 'b/c.txt': 'x' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.git/HEAD`, 'ref: refs/heads/main\n');

    // Act
    const sut = await collect(walkWorkingTree(ctx));

    // Assert — yielded normal entries;.git skipped; b/c.txt yielded.
    expect(sut.sort()).toEqual(['a.txt', 'b/c.txt']);
  });
});
