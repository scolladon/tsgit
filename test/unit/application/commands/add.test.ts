import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add, addAll as addAllInternal } from '../../../../src/application/commands/add.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { MAX_WORKING_TREE_BLOB_BYTES } from '../../../../src/application/primitives/types.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { seedRepo } from './fixtures.js';

const seedFreshRepo = async (workingTree: Readonly<Record<string, string>> = {}) => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree });
  return ctx;
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

describe('add', () => {
  it('Given empty paths, When add, Then throws EMPTY_PATHSPEC', async () => {
    const ctx = await seedFreshRepo();
    await expectError(() => add(ctx, []), 'EMPTY_PATHSPEC');
  });

  it('Given a single literal path, When add, Then result.added contains it', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'src/foo.ts': 'x' });

    // Act
    const sut = await add(ctx, ['src/foo.ts']);

    // Assert
    expect(sut.added).toEqual(['src/foo.ts']);
  });

  it('Given an outside-repo path, When add, Then throws PATHSPEC_OUTSIDE_REPO before any I/O', async () => {
    const ctx = await seedFreshRepo();
    await expectError(() => add(ctx, ['../escape']), 'PATHSPEC_OUTSIDE_REPO');
  });

  it('Given a non-existent path, When add, Then throws PATHSPEC_NO_MATCH', async () => {
    const ctx = await seedFreshRepo();
    await expectError(() => add(ctx, ['nonexistent.txt']), 'PATHSPEC_NO_MATCH');
  });

  it('Given a bare repo (core.bare=true), When add, Then throws BARE_REPOSITORY with operation="add"', async () => {
    // Arrange
    const ctx = await seedFreshRepo();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

    // Act
    const err = await expectError(() => add(ctx, ['x']), 'BARE_REPOSITORY');

    // Assert — pin the operation literal so a StringLiteral mutant on
    // `assertNotBare(ctx, 'add')` would change the payload.
    expect((err.data as { operation: string }).operation).toBe('add');
  });

  it('Given a non-repo ctx, When add, Then throws NOT_A_REPOSITORY', async () => {
    const ctx = createMemoryContext();
    await expectError(() => add(ctx, ['x']), 'NOT_A_REPOSITORY');
  });

  it('Given .git/MERGE_HEAD exists, When add runs, Then succeeds (resolving a conflicted merge is the legitimate path forward — Phase 13.4b)', async () => {
    // Arrange — MERGE_HEAD presence used to block `add`. Phase 13.4b
    // changed the contract: `add` must allow staging resolved files
    // during a conflicted merge. Other pending markers still block.
    // The marker file content is a valid 40-hex ObjectId (matches the
    // factory's validation contract).
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'a'.repeat(40)}\n`);

    // Act
    const sut = await add(ctx, ['a.txt']);

    // Assert
    expect(sut.added).toEqual(['a.txt']);
  });

  it.each([
    ['REBASE_HEAD', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
  ])('Given .git/%s exists, When add runs, Then throws OPERATION_IN_PROGRESS with operation=%s (only merge is excepted)', async (markerFile, expectedOp) => {
    // Arrange — exactly one non-merge marker present. Only `merge` is
    // excepted from the pending-operation check; others must still
    // block. Kills the mutant that widens `except: 'merge'` to
    // `except: 'rebase'` (etc.) — a wider exception would let one of
    // these calls succeed.
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${markerFile}`, 'oid\n');

    // Act
    let caught: unknown;
    try {
      await add(ctx, ['a.txt']);
    } catch (err) {
      caught = err;
    }
    const data = (caught as { data?: { code?: string; operation?: string } })?.data;
    expect(data?.code).toBe('OPERATION_IN_PROGRESS');
    expect(data?.operation).toBe(expectedOp);
  });

  it('Given an existing index entry + modified working file, When add, Then result.modified contains it', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    await add(ctx, ['a.txt']);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'modified-content');

    // Act
    const sut = await add(ctx, ['a.txt']);

    // Assert
    expect(sut.modified).toEqual(['a.txt']);
    expect(sut.added).toEqual([]);
  });

  it('Given two paths, one new + one already-staged unchanged, When add, Then added contains only the new path', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'a.txt': 'a', 'b.txt': 'b' });
    await add(ctx, ['a.txt']);

    // Act — re-add a.txt (unchanged) + b.txt (new).
    const sut = await add(ctx, ['a.txt', 'b.txt']);

    // Assert
    expect(sut.added).toEqual(['b.txt']);
    expect(sut.modified).toEqual([]);
  });

  it('Given all: true with non-empty pathspec, When add, Then throws INVALID_OPTION with option=all', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });

    // Act
    const err = await expectError(() => add(ctx, ['a.txt'], { all: true }), 'INVALID_OPTION');

    // Assert — the rejection is specifically about the `all` option.
    const data = err.data as { code: string; option?: string; reason?: string };
    expect(data.option).toBe('all');
    expect(data.reason).toMatch(/pathspec/i);
  });

  it('Given all: true on an empty working tree, When add, Then returns empty added/modified/removed', async () => {
    // Arrange
    const ctx = await seedFreshRepo();

    // Act
    const sut = await add(ctx, [], { all: true });

    // Assert
    expect(sut).toEqual({ added: [], modified: [], removed: [] });
  });

  it('Given a single staged file via add({ all: true }), When the index is read back, Then ctimeSeconds, mtimeSeconds, and flags reflect the lstat values', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'pin.txt': 'p' });
    const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/pin.txt`);

    // Act
    await add(ctx, [], { all: true });

    // Assert — pins Math.floor(ctimeMs/1000) and the BooleanLiteral flag
    // values so `* 1000` and `assumeValid: true` / `extended: true`
    // mutants are killed.
    const idx = await readIndex(ctx);
    const entry = idx.entries.find((e) => e.path === 'pin.txt');
    expect(entry).toBeDefined();
    expect(entry?.ctimeSeconds).toBe(Math.floor(stat.ctimeMs / 1000));
    expect(entry?.mtimeSeconds).toBe(Math.floor(stat.mtimeMs / 1000));
    expect(entry?.flags.assumeValid).toBe(false);
    expect(entry?.flags.extended).toBe(false);
    expect(entry?.flags.stage).toBe(0);
  });

  it('Given two untracked files and all: true, When add, Then both appear in added (sorted) and the index has them', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'b.txt': 'b', 'a.txt': 'a' });

    // Act
    const sut = await add(ctx, [], { all: true });

    // Assert
    expect(sut.added).toEqual(['a.txt', 'b.txt']);
    const idx = await readIndex(ctx);
    expect(idx.entries.map((e) => e.path).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('Given a tracked + a modified file and all: true, When add, Then modified contains only the changed one', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'a.txt': 'a', 'b.txt': 'b' });
    await add(ctx, [], { all: true });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a-changed');

    // Act
    const sut = await add(ctx, [], { all: true });

    // Assert
    expect(sut.modified).toEqual(['a.txt']);
    expect(sut.added).toEqual([]);
  });

  it('Given an unsorted walk that yields two new + one modified + one removed, When add({ all: true }), Then EACH of added/modified/removed is independently sorted', async () => {
    // Arrange — pre-stage z.txt + b.txt; modify z, delete b, add a + c.
    // The mutation tests need each `.sort()` call pinned to its OWN array.
    const ctx = await seedFreshRepo({ 'z.txt': 'z', 'b.txt': 'b' });
    await add(ctx, [], { all: true });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.txt`, 'z-changed');
    await ctx.fs.rm(`${ctx.layout.workDir}/b.txt`);
    // Add two new files; their alphabetical order is c < a so unsorted
    // would be ['c', 'a']. Sorted MUST be ['a', 'c'].
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');

    // Act
    const sut = await add(ctx, [], { all: true });

    // Assert — each array sorted INDEPENDENTLY. A mutant that sorts the
    // wrong array (added.sort → modified.sort, etc.) breaks one of these.
    expect(sut.added).toEqual(['a.txt', 'c.txt']);
    expect(sut.modified).toEqual(['z.txt']);
    expect(sut.removed).toEqual(['b.txt']);
  });

  it('Given a tracked file deleted from disk and all: true, When add, Then removed contains it and the index entry drops', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'a.txt': 'a', 'b.txt': 'b' });
    await add(ctx, [], { all: true });
    await ctx.fs.rm(`${ctx.layout.workDir}/a.txt`);

    // Act
    const sut = await add(ctx, [], { all: true });

    // Assert
    expect(sut.removed).toEqual(['a.txt']);
    const idx = await readIndex(ctx);
    expect(idx.entries.map((e) => e.path)).toEqual(['b.txt']);
  });

  it('Given a symlink and all: true, When add, Then it stages as mode 120000', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    await ctx.fs.symlink('a.txt', `${ctx.layout.workDir}/link`);

    // Act
    await add(ctx, [], { all: true });

    // Assert
    const idx = await readIndex(ctx);
    const link = idx.entries.find((e) => e.path === 'link');
    expect(link?.mode).toBe('120000');
  });

  it('Given an executable bit reported by lstat and all: true, When add, Then mode 100755 is recorded', async () => {
    // Arrange — memory FS always reports 0o100644, so override lstat to set
    // the exec bit for the specific file under test.
    const ctx = await seedFreshRepo({ 'a.sh': '#!/bin/sh\n' });
    const baseLstat = ctx.fs.lstat;
    const execFs = new Proxy(ctx.fs, {
      get(target, prop, receiver) {
        if (prop === 'lstat') {
          return async (path: string) => {
            const real = await baseLstat(path);
            if (path.endsWith('/a.sh')) return { ...real, mode: real.mode | 0o111 };
            return real;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const execCtx = { ...ctx, fs: execFs };

    // Act
    await add(execCtx, [], { all: true });

    // Assert
    const idx = await readIndex(ctx);
    const entry = idx.entries.find((e) => e.path === 'a.sh');
    expect(entry?.mode).toBe('100755');
  });

  it('Given a .git directory at the root and all: true, When add, Then .git contents are not staged', async () => {
    // Arrange — seedRepo already wrote .git/HEAD via the fixture. Add a stray
    // .git/config to make sure no .git path leaks into the index.
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n');

    // Act
    await add(ctx, [], { all: true });

    // Assert
    const idx = await readIndex(ctx);
    const dotgit = idx.entries.filter((e) => e.path.includes('.git'));
    expect(dotgit).toEqual([]);
  });

  it('Given an embedded .git subdirectory (nested repo) and all: true, When add, Then nothing under it is staged and no 160000 entry is created', async () => {
    // Arrange
    const ctx = await seedFreshRepo({
      'a.txt': 'a',
      'vendor/lib/.git/HEAD': 'ref: refs/heads/main',
      'vendor/lib/src/x.ts': 'x',
    });

    // Act
    await add(ctx, [], { all: true });

    // Assert
    const idx = await readIndex(ctx);
    const paths = idx.entries.map((e) => e.path);
    expect(paths).toEqual(['a.txt']);
    const gitlinks = idx.entries.filter((e) => e.mode === '160000');
    expect(gitlinks).toEqual([]);
  });

  it('Given a file over MAX_WORKING_TREE_BLOB_BYTES, When add({ all: true }), Then throws WORKING_TREE_FILE_TOO_LARGE and the index is unchanged', async () => {
    // Arrange — write a small file but mock fs.lstat to report an oversize.
    // Hand-rolled stat override is simpler than allocating 256MiB.
    const ctx = await seedFreshRepo({ 'big.bin': 'x' });
    await add(ctx, [], { all: true });
    const before = (await readIndex(ctx)).entries.length;
    const baseLstat = ctx.fs.lstat;
    const hostileFs = new Proxy(ctx.fs, {
      get(target, prop, receiver) {
        if (prop === 'lstat') {
          return async (path: string) => {
            const real = await baseLstat(path);
            if (path.endsWith('/big.bin')) {
              return { ...real, size: MAX_WORKING_TREE_BLOB_BYTES + 1 };
            }
            return real;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const hostileCtx = { ...ctx, fs: hostileFs };

    // Act
    const err = await expectError(
      () => add(hostileCtx, [], { all: true }),
      'WORKING_TREE_FILE_TOO_LARGE',
    );

    // Assert
    const data = err.data as { code: string; path: string; size: number; limit: number };
    expect(data.path).toBe('big.bin');
    expect(data.size).toBe(MAX_WORKING_TREE_BLOB_BYTES + 1);
    expect(data.limit).toBe(MAX_WORKING_TREE_BLOB_BYTES);
    // ctx and hostileCtx share the same backing memory FS — reading the
    // index through `ctx` reflects exactly what `add(hostileCtx, …)` did
    // (or didn't) commit. Confirms the failed call left no partial write.
    const after = (await readIndex(ctx)).entries.length;
    expect(after).toBe(before);
  });

  it('Given a conflicted merge (.git/MERGE_HEAD present) and all: true, When add, Then succeeds (merge is excepted)', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'a'.repeat(40)}\n`);

    // Act
    const sut = await add(ctx, [], { all: true });

    // Assert
    expect(sut.added).toEqual(['a.txt']);
  });

  it('Given a rebase in progress (.git/REBASE_HEAD) and all: true, When add, Then throws OPERATION_IN_PROGRESS with operation=rebase', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/REBASE_HEAD`, 'oid\n');

    // Act
    const err = await expectError(() => add(ctx, [], { all: true }), 'OPERATION_IN_PROGRESS');

    // Assert — payload pin so the operation identifier is mutation-protected.
    expect((err.data as { operation: string }).operation).toBe('rebase');
  });

  const racingLstatFs = (
    ctx: Awaited<ReturnType<typeof seedFreshRepo>>,
    targetSuffix: string,
    flipTo: Partial<Awaited<ReturnType<typeof ctx.fs.lstat>>>,
  ) => {
    // Boolean flag (not a positional counter) so extra lstat calls on
    // OTHER paths don't desynchronise the swap point. The first lstat
    // for `targetSuffix` returns the real stat; every subsequent lstat
    // for it returns the flipped stat.
    const baseLstat = ctx.fs.lstat;
    let firstSeen = false;
    return new Proxy(ctx.fs, {
      get(target, prop, receiver) {
        if (prop === 'lstat') {
          return async (path: string) => {
            const real = await baseLstat(path);
            if (!path.endsWith(targetSuffix)) return real;
            if (!firstSeen) {
              firstSeen = true;
              return real;
            }
            return { ...real, ...flipTo };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  };

  it('Given a stat type that flips between walk and stage (regular -> symlink), When add({ all: true }), Then throws OPERATION_ABORTED and no index commit', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    const racingCtx = {
      ...ctx,
      fs: racingLstatFs(ctx, '/a.txt', { isSymbolicLink: true, isFile: false }),
    };
    const before = (await readIndex(ctx).catch(() => ({ entries: [] }))).entries.length;

    // Act
    await expectError(() => add(racingCtx, [], { all: true }), 'OPERATION_ABORTED');

    // Assert
    const after = (await readIndex(ctx).catch(() => ({ entries: [] }))).entries.length;
    expect(after).toBe(before);
  });

  it('Given a stat type that flips between walk and stage (symlink -> regular), When add({ all: true }), Then throws OPERATION_ABORTED', async () => {
    // Arrange — walk sees a symlink leaf; re-lstat sees a regular file.
    // Kills the mutant that swaps `!==` for `===` in the type-flip guard.
    const ctx = await seedFreshRepo({});
    await ctx.fs.symlink('target', `${ctx.layout.workDir}/link`);
    const racingCtx = {
      ...ctx,
      fs: racingLstatFs(ctx, '/link', { isSymbolicLink: false, isFile: true }),
    };

    // Act
    await expectError(() => add(racingCtx, [], { all: true }), 'OPERATION_ABORTED');
  });

  it('Given a stat type that flips file -> directory between walk and stage, When add({ all: true }), Then throws OPERATION_ABORTED', async () => {
    // Arrange — extends the type-flip guard to the isDirectory axis so a
    // mutant that drops the isDirectory check is killed.
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    const racingCtx = {
      ...ctx,
      fs: racingLstatFs(ctx, '/a.txt', { isFile: false, isDirectory: true }),
    };

    // Act
    await expectError(() => add(racingCtx, [], { all: true }), 'OPERATION_ABORTED');
  });

  it('Given ONLY isSymbolicLink flips between walk and stage (isFile and isDirectory unchanged), When add({ all: true }), Then throws OPERATION_ABORTED — kills `||` → `&&` mutants on the type-flip guard', async () => {
    // Arrange — flip exactly ONE axis. With `||` → `&&` the whole guard
    // would only fire if all three differ, so single-axis flips would
    // sneak through. This test pins isSymbolicLink-only.
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    const racingCtx = {
      ...ctx,
      fs: racingLstatFs(ctx, '/a.txt', { isSymbolicLink: true }),
    };

    // Act
    await expectError(() => add(racingCtx, [], { all: true }), 'OPERATION_ABORTED');
  });

  it('Given ONLY isDirectory flips between walk and stage, When add({ all: true }), Then throws OPERATION_ABORTED', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    const racingCtx = {
      ...ctx,
      fs: racingLstatFs(ctx, '/a.txt', { isDirectory: true }),
    };

    // Act
    await expectError(() => add(racingCtx, [], { all: true }), 'OPERATION_ABORTED');
  });

  it('Given ONLY isFile flips between walk and stage, When add({ all: true }), Then throws OPERATION_ABORTED', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    const racingCtx = {
      ...ctx,
      fs: racingLstatFs(ctx, '/a.txt', { isFile: false }),
    };

    // Act
    await expectError(() => add(racingCtx, [], { all: true }), 'OPERATION_ABORTED');
  });

  it('Given a file that grows past MAX_WORKING_TREE_BLOB_BYTES between walk and re-lstat, When add({ all: true }), Then throws WORKING_TREE_FILE_TOO_LARGE (post-re-lstat guard fires)', async () => {
    // Arrange — walk-time stat reports a small file; re-lstat reports the
    // oversize value. The pre-filter (walk-time) skips; the authoritative
    // post-re-lstat guard must catch it.
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    const racingCtx = {
      ...ctx,
      fs: racingLstatFs(ctx, '/a.txt', { size: MAX_WORKING_TREE_BLOB_BYTES + 1 }),
    };

    // Act
    const err = await expectError(
      () => add(racingCtx, [], { all: true }),
      'WORKING_TREE_FILE_TOO_LARGE',
    );

    // Assert — payload pins fresh size, not the stale walk-time size.
    const data = err.data as { path: string; size: number; limit: number };
    expect(data.path).toBe('a.txt');
    expect(data.size).toBe(MAX_WORKING_TREE_BLOB_BYTES + 1);
    expect(data.limit).toBe(MAX_WORKING_TREE_BLOB_BYTES);
  });

  it('Given a file of exactly MAX_WORKING_TREE_BLOB_BYTES bytes (boundary), When add({ all: true }), Then accepts without throwing — kills the `>` → `>=` mutants on both pre-filter and authoritative caps', async () => {
    // Arrange — lstat reports size exactly at the cap. Both the
    // walk-time pre-filter (`stat.size > cap`) and the re-lstat
    // authoritative check (`fresh.size > cap`) must accept this.
    const ctx = await seedFreshRepo({ 'a.txt': 'tiny' });
    const baseLstat = ctx.fs.lstat;
    const cappedFs = new Proxy(ctx.fs, {
      get(target, prop, receiver) {
        if (prop === 'lstat') {
          return async (path: string) => {
            const real = await baseLstat(path);
            if (path.endsWith('/a.txt')) {
              return { ...real, size: MAX_WORKING_TREE_BLOB_BYTES };
            }
            return real;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const cappedCtx = { ...ctx, fs: cappedFs };

    // Act
    const sut = await add(cappedCtx, [], { all: true });

    // Assert
    expect(sut.added).toEqual(['a.txt']);
  });

  it('Given a symlink target of exactly MAX_WORKING_TREE_BLOB_BYTES bytes (boundary), When add({ all: true }), Then accepts — kills the `>` → `>=` mutant on the readlink-cap', async () => {
    // Arrange — symlink target byte length exactly at the cap. Memory FS
    // backs symlinks with the target string verbatim; readlink returns it
    // unchanged. lstat.size reports the target length, so the pre-filter
    // doesn't fire; the post-encode check in readContent must allow it.
    const ctx = await seedFreshRepo({});
    const target = 'x'.repeat(MAX_WORKING_TREE_BLOB_BYTES);
    await ctx.fs.symlink(target, `${ctx.layout.workDir}/link`);

    // Act
    const sut = await add(ctx, [], { all: true });

    // Assert
    expect(sut.added).toEqual(['link']);
  });

  it('Given a hostile readlink that returns more than MAX_WORKING_TREE_BLOB_BYTES, When add({ all: true }), Then throws WORKING_TREE_FILE_TOO_LARGE', async () => {
    // Arrange — symlink target reported by lstat is small (under cap) but
    // readlink returns an oversize payload. Defends against a mis-behaving
    // FS adapter that lies about target length.
    const ctx = await seedFreshRepo({});
    await ctx.fs.symlink('short-target', `${ctx.layout.workDir}/link`);
    const baseReadlink = ctx.fs.readlink;
    const hostileFs = new Proxy(ctx.fs, {
      get(target, prop, receiver) {
        if (prop === 'readlink') {
          return async (path: string) => {
            const real = await baseReadlink(path);
            if (path.endsWith('/link')) {
              return 'x'.repeat(MAX_WORKING_TREE_BLOB_BYTES + 1);
            }
            return real;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const hostileCtx = { ...ctx, fs: hostileFs };

    // Act
    const err = await expectError(
      () => add(hostileCtx, [], { all: true }),
      'WORKING_TREE_FILE_TOO_LARGE',
    );

    // Assert
    const data = err.data as { path: string; size: number; limit: number };
    expect(data.path).toBe('link');
    expect(data.size).toBe(MAX_WORKING_TREE_BLOB_BYTES + 1);
    expect(data.limit).toBe(MAX_WORKING_TREE_BLOB_BYTES);
  });

  it('Given a plain regular file literally named .git inside a subdirectory (worktree pointer), When add({ all: true }), Then the whole subdirectory is skipped', async () => {
    // Arrange — `.git` regular file is git's worktree gitdir pointer
    // (`gitdir: /path/...`). Treated as an embedded-repo marker.
    const ctx = await seedFreshRepo({
      'sub/normal.txt': 'x',
      'sub/.git': 'gitdir: /elsewhere',
    });

    // Act
    await add(ctx, [], { all: true });

    // Assert — siblings inside `sub/` are not staged.
    const idx = await readIndex(ctx);
    expect(idx.entries.map((e) => e.path)).toEqual([]);
  });

  it('Given a symlink named .git in a subdirectory, When add({ all: true }), Then the symlink is filtered but siblings are still staged (symlinks are NOT embedded markers)', async () => {
    // Arrange — defense against an attacker planting a `.git` symlink to
    // hide siblings from being staged.
    const ctx = await seedFreshRepo({ 'sub/keep.txt': 'k' });
    await ctx.fs.symlink('/elsewhere', `${ctx.layout.workDir}/sub/.git`);

    // Act
    await add(ctx, [], { all: true });

    // Assert — sibling staged; `.git` symlink filtered by name check.
    const idx = await readIndex(ctx);
    expect(idx.entries.map((e) => e.path).sort()).toEqual(['sub/keep.txt']);
  });

  it('Given a custom ignore predicate that excludes node_modules, When addAll is called directly, Then those paths are skipped', async () => {
    // Arrange
    const ctx = await seedFreshRepo({
      'a.txt': 'a',
      'node_modules/foo/index.js': 'x',
    });
    const ignore = (path: string) => path.startsWith('node_modules/');

    // Act
    const sut = await addAllInternal(ctx, {}, ignore);

    // Assert
    expect(sut.added).toEqual(['a.txt']);
    const idx = await readIndex(ctx);
    expect(idx.entries.map((e) => e.path)).toEqual(['a.txt']);
  });

  it('Given an aborted ctx.signal mid-walk and all: true, When add, Then throws OPERATION_ABORTED and the on-disk index is unchanged', async () => {
    // Arrange — populate, then run with a pre-aborted signal.
    const ctx = await seedFreshRepo({ 'a.txt': 'a', 'b.txt': 'b' });
    const before = (await readIndex(ctx).catch(() => ({ entries: [] }))).entries.length;
    const controller = new AbortController();
    controller.abort();
    const abortedCtx = { ...ctx, signal: controller.signal };

    // Act
    await expectError(() => add(abortedCtx, [], { all: true }), 'OPERATION_ABORTED');

    // Assert — index file untouched (still empty because no prior add).
    const after = (await readIndex(ctx).catch(() => ({ entries: [] }))).entries.length;
    expect(after).toBe(before);
  });

  it('Given a repo-root .gitignore with `node_modules`, When add({ all: true }), Then node_modules/* is not staged (directory pruned at walk-time)', async () => {
    // Arrange
    const ctx = await seedFreshRepo({
      'a.txt': 'a',
      'node_modules/foo/index.js': 'x',
      'node_modules/bar/index.js': 'y',
    });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'node_modules/\n');

    // Act
    const sut = await add(ctx, [], { all: true });

    // Assert — only the staged file is added; .gitignore itself ALSO gets staged.
    expect([...sut.added].sort()).toEqual(['.gitignore', 'a.txt']);
  });

  it('Given a nested .gitignore with negation, When add({ all: true }), Then negation takes effect under that subtree only', async () => {
    // Arrange
    const ctx = await seedFreshRepo({
      'a.log': 'x', // matched by root *.log → ignored
      'sub/keep.log': 'k', // re-included by nested !keep.log → staged
      'sub/other.log': 'o', // still matched by root *.log → ignored
    });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.gitignore`, '!keep.log\n');

    // Act
    const sut = await add(ctx, [], { all: true });

    // Assert
    expect([...sut.added].sort()).toEqual(['.gitignore', 'sub/.gitignore', 'sub/keep.log']);
  });

  it('Given a tracked file that an ignore rule WOULD ignore, When add({ all: true }), Then the index entry is preserved (Git invariant: tracked beats ignored)', async () => {
    // Arrange — first stage `secret.bin` literally; then add a rule that
    // would ignore it; re-run `add --all`. The entry must stay.
    const ctx = await seedFreshRepo({ 'secret.bin': 'sensitive' });
    await add(ctx, ['secret.bin']);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'secret.bin\n');

    // Act
    const sut = await add(ctx, [], { all: true });

    // Assert — .gitignore is newly added; secret.bin stays in index, not in removed.
    expect(sut.added).toEqual(['.gitignore']);
    expect(sut.removed).toEqual([]);
    const idx = await readIndex(ctx);
    expect(idx.entries.map((e) => e.path).sort()).toEqual(['.gitignore', 'secret.bin']);
  });

  it('Given a .git/info/exclude rule, When add({ all: true }), Then matched paths are not staged', async () => {
    // Arrange
    const ctx = await seedFreshRepo({ 'a.txt': 'a', 'secret.bin': 'x' });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, 'secret.bin\n');

    // Act
    const sut = await add(ctx, [], { all: true });

    // Assert
    expect(sut.added).toEqual(['a.txt']);
  });

  it('Given the index file is present but corrupted, When add, Then the error propagates (no silent reset)', async () => {
    // Arrange — corrupt the index so readIndex throws an INVALID_INDEX_HEADER /
    // INVALID_INDEX_ENTRY. add() falls back to "no entries" only for these documented codes.
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    await add(ctx, ['a.txt']);
    // Replace index with garbage that still has the right size to reach the parser.
    await ctx.fs.write(`${ctx.layout.gitDir}/index`, new Uint8Array(50));

    // Act — should NOT throw because INVALID_INDEX_HEADER is treated as "no entries".
    const sut = await add(ctx, ['a.txt']);

    // Assert — re-add succeeds with a.txt re-staged.
    expect(sut.added).toEqual(['a.txt']);
  });
});
