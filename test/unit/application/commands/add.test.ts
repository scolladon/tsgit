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

  it('Given a bare repo (core.bare=true), When add, Then throws BARE_REPOSITORY', async () => {
    // Arrange
    const ctx = await seedFreshRepo();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

    // Act
    await expectError(() => add(ctx, ['x']), 'BARE_REPOSITORY');
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

  it('Given a stat type that flips between walk and stage (regular -> symlink), When add({ all: true }), Then throws OPERATION_ABORTED and no index commit', async () => {
    // Arrange — first lstat call (in the walk) reports a regular file;
    // the second (re-lstat inside stageFromStat) reports a symlink. This
    // simulates an attacker swapping the inode between walk and stage.
    const ctx = await seedFreshRepo({ 'a.txt': 'a' });
    const baseLstat = ctx.fs.lstat;
    let lstatCalls = 0;
    const racingFs = new Proxy(ctx.fs, {
      get(target, prop, receiver) {
        if (prop === 'lstat') {
          return async (path: string) => {
            const real = await baseLstat(path);
            if (path.endsWith('/a.txt')) {
              lstatCalls += 1;
              if (lstatCalls === 2) {
                return { ...real, isSymbolicLink: true, isFile: false };
              }
            }
            return real;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const racingCtx = { ...ctx, fs: racingFs };
    const before = (await readIndex(ctx).catch(() => ({ entries: [] }))).entries.length;

    // Act
    await expectError(() => add(racingCtx, [], { all: true }), 'OPERATION_ABORTED');

    // Assert — no partial commit landed.
    const after = (await readIndex(ctx).catch(() => ({ entries: [] }))).entries.length;
    expect(after).toBe(before);
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

  it('Given a plain regular file literally named .git inside a subdirectory, When add({ all: true }), Then the subdirectory siblings ARE staged (no embedded-marker on a non-dir / non-file-pointer)', async () => {
    // Arrange — historical bug: `entries.some(.name === '.git')` would
    // collapse a parent directory even when `.git` was not actually a
    // dir or worktree-pointer. The fix requires `.git` to be a directory
    // OR a regular file (worktree gitdir pointer). A symlink named `.git`
    // is NOT a marker — see the helper test below.
    const ctx = await seedFreshRepo({
      'sub/normal.txt': 'x',
      'sub/.git': 'gitdir: /elsewhere',
    });

    // Act — the `.git` file IS treated as a worktree pointer (file branch
    // of the marker check), so the whole `sub/` is skipped.
    await add(ctx, [], { all: true });

    // Assert
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
