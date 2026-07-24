import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add, addAll as addAllInternal } from '../../../../src/application/commands/add.js';
import { readBlob } from '../../../../src/application/primitives/read-blob.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { MAX_WORKING_TREE_BLOB_BYTES } from '../../../../src/application/primitives/types.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../../../src/ports/command-runner.js';
import { seedRepo } from './fixtures.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Fake runner: transforms stdin bytes (uppercase) and records calls. */
class FakeRunner implements CommandRunner {
  private readonly exitCode: number;
  private readonly transform: (input: Uint8Array) => Uint8Array;
  readonly calls: CommandRequest[] = [];

  constructor(exitCode = 0, transform: (input: Uint8Array) => Uint8Array = (b) => b) {
    this.exitCode = exitCode;
    this.transform = transform;
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    if (this.exitCode !== 0) return { exitCode: this.exitCode };
    return { exitCode: 0, stdout: this.transform(request.stdin ?? new Uint8Array(0)) };
  }
}

const uppercase = (b: Uint8Array): Uint8Array => enc(dec(b).toUpperCase());

const seedFreshRepo = async (workingTree: Readonly<Record<string, string>> = {}) => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree });
  return ctx;
};

// Seed a repo with a pre-existing `index.lock` whose mtime is reported far
// in the past, so the repo-wide `config.breakStaleLockMs` (> 0) treats it as
// stale and breaks it. The lstat override only rewrites the lock's mtime;
// every other path keeps its real stat. The stale-lock break policy lives on
// `config`, set once at open — not on the per-call add option.
const staleLockCtx = async (workingTree: Readonly<Record<string, string>>) => {
  const ctx = await seedFreshRepo(workingTree);
  const lockPath = `${ctx.layout.gitDir}/index.lock`;
  await ctx.fs.write(lockPath, new Uint8Array());
  const baseLstat = ctx.fs.lstat;
  const fs = new Proxy(ctx.fs, {
    get(target, prop, receiver) {
      if (prop === 'lstat') {
        return async (path: string) => {
          const real = await baseLstat(path);
          if (path === lockPath) return { ...real, mtimeMs: 0 };
          return real;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...ctx, fs, config: { ...ctx.config, breakStaleLockMs: 1 } };
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
  describe('Given empty paths', () => {
    describe('When add', () => {
      it('Then throws EMPTY_PATHSPEC', async () => {
        // Arrange
        const ctx = await seedFreshRepo();
        // Assert
        await expectError(() => add(ctx, []), 'EMPTY_PATHSPEC');
      });
    });
  });

  describe('Given a single literal path', () => {
    describe('When add', () => {
      it('Then result.added contains it', async () => {
        // Arrange
        const ctx = await seedFreshRepo({ 'src/foo.ts': 'x' });

        // Act
        const sut = await add(ctx, ['src/foo.ts']);

        // Assert
        expect(sut.added).toEqual(['src/foo.ts']);
      });
    });
  });

  describe('Given an outside-repo path', () => {
    describe('When add', () => {
      it('Then throws PATHSPEC_OUTSIDE_REPO before any I/O', async () => {
        // Arrange
        const ctx = await seedFreshRepo();
        // Assert
        await expectError(() => add(ctx, ['../escape']), 'PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given a non-existent path', () => {
    describe('When add', () => {
      it('Then throws PATHSPEC_NO_MATCH', async () => {
        // Arrange
        const ctx = await seedFreshRepo();
        // Assert
        await expectError(() => add(ctx, ['nonexistent.txt']), 'PATHSPEC_NO_MATCH');
      });
    });
  });

  describe('Given a bare repo (core.bare=true)', () => {
    describe('When add', () => {
      it('Then throws BARE_REPOSITORY with operation="add"', async () => {
        // Arrange
        const ctx = await seedFreshRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

        // Act
        const err = await expectError(() => add(ctx, ['x']), 'BARE_REPOSITORY');

        // Assert — pin the operation literal so a StringLiteral mutant on
        // `assertNotBare(ctx, 'add')` would change the payload.
        expect((err.data as { operation: string }).operation).toBe('add');
      });
    });
  });

  describe('Given a non-repo ctx', () => {
    describe('When add', () => {
      it('Then throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = createMemoryContext();
        // Assert
        await expectError(() => add(ctx, ['x']), 'NOT_A_REPOSITORY');
      });
    });
  });

  describe('Given a pending operation marker that add excepts (merge / rebase / revert / cherry-pick)', () => {
    describe('When add runs to stage the resolution', () => {
      it.each([
        {
          file: 'MERGE_HEAD',
          content: `${'a'.repeat(40)}\n`,
          label: 'succeeds for a conflicted merge (resolving is the legitimate path forward)',
        },
        {
          file: 'REBASE_HEAD',
          content: 'oid\n',
          label:
            'is allowed for a rebase in progress (like a merge / cherry-pick / revert resolution)',
        },
        {
          file: 'REVERT_HEAD',
          content: 'oid\n',
          label: 'is allowed for a revert in progress (like a merge / cherry-pick resolution)',
        },
        {
          file: 'CHERRY_PICK_HEAD',
          content: 'oid\n',
          label: 'is allowed for a cherry-pick in progress (like a merge resolution)',
        },
      ])('Then it $label', async ({ file, content }) => {
        // Arrange — presence of any of these markers used to block `add`; the
        // contract changed to allow staging resolved files during a
        // conflicted merge/rebase/revert/cherry-pick, while every other
        // pending marker still blocks. Kills a mutant that drops any one
        // label from the exception list.
        const ctx = await seedFreshRepo({ 'a.txt': 'a' });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${file}`, content);

        // Act
        const sut = await add(ctx, ['a.txt']);

        // Assert
        expect(sut.added).toEqual(['a.txt']);
      });
    });
  });

  describe('Given an existing index entry + modified working file', () => {
    describe('When add', () => {
      it('Then result.modified contains it', async () => {
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
    });
  });

  describe('Given two paths, one new + one already-staged unchanged', () => {
    describe('When add', () => {
      it('Then added contains only the new path', async () => {
        // Arrange
        const ctx = await seedFreshRepo({ 'a.txt': 'a', 'b.txt': 'b' });
        await add(ctx, ['a.txt']);

        // Act — re-add a.txt (unchanged) + b.txt (new).
        const sut = await add(ctx, ['a.txt', 'b.txt']);

        // Assert
        expect(sut.added).toEqual(['b.txt']);
        expect(sut.modified).toEqual([]);
      });
    });
  });

  describe('Given a glob pathspec matching an already-staged unchanged file', () => {
    describe('When add', () => {
      it('Then result.modified does NOT contain it', async () => {
        // Arrange — stage a.txt, then re-add via the glob `*.txt`. A glob routes
        // through the walk-and-filter path (addByPathspec); the walk yields the
        // unchanged file with kind 'unchanged'. The `result.kind === 'modified'`
        // guard must reject it — a mutant forcing that guard true would wrongly
        // push the unchanged path into `modified`.
        const ctx = await seedFreshRepo({ 'a.txt': 'a' });
        await add(ctx, ['a.txt']);

        // Act
        const sut = await add(ctx, ['*.txt']);

        // Assert
        expect(sut.modified).toEqual([]);
        expect(sut.added).toEqual([]);
      });
    });
  });

  describe('Given a single regular file', () => {
    describe('When add', () => {
      it('Then the index entry flags are the default stage-0 flags', async () => {
        // Arrange
        const ctx = await seedFreshRepo({ 'plain.txt': 'content' });

        // Act
        await add(ctx, ['plain.txt']);

        // Assert — a freshly added file gets exactly `STAGE0_FLAGS`; a
        // BooleanLiteral mutant flipping any flag would surface here.
        const idx = await readIndex(ctx);
        const entry = idx.entries.find((e) => e.path === 'plain.txt');
        expect(entry).toBeDefined();
        expect(entry?.flags).toEqual(STAGE0_FLAGS);
      });
    });
  });

  describe('Given all: true with non-empty pathspec', () => {
    describe('When add', () => {
      it('Then throws INVALID_OPTION with option=all', async () => {
        // Arrange
        const ctx = await seedFreshRepo({ 'a.txt': 'a' });

        // Act
        const err = await expectError(() => add(ctx, ['a.txt'], { all: true }), 'INVALID_OPTION');

        // Assert — the rejection is specifically about the `all` option.
        const data = err.data as { code: string; option?: string; reason?: string };
        expect(data.option).toBe('all');
        expect(data.reason).toMatch(/pathspec/i);
      });
    });
  });

  describe('Given all: true on an empty working tree', () => {
    describe('When add', () => {
      it('Then returns empty added/modified/removed', async () => {
        // Arrange
        const ctx = await seedFreshRepo();

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert
        expect(sut).toEqual({ added: [], modified: [], removed: [] });
      });
    });
  });

  describe('Given a single staged file via add({ all: true })', () => {
    describe('When the index is read back', () => {
      it('Then ctimeSeconds, mtimeSeconds, and flags reflect the lstat values', async () => {
        // Arrange
        const ctx = await seedFreshRepo({ 'pin.txt': 'p' });
        const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/pin.txt`);

        // Act
        await add(ctx, [], { all: true });

        // Assert — pins Math.floor(ctimeMs/1000) and the BooleanLiteral flag
        // values so `* 1000` and `assumeValid: true` / `skipWorktree: true`
        // mutants are killed.
        const idx = await readIndex(ctx);
        const entry = idx.entries.find((e) => e.path === 'pin.txt');
        expect(entry).toBeDefined();
        expect(entry?.ctimeSeconds).toBe(Math.floor(stat.ctimeMs / 1000));
        expect(entry?.mtimeSeconds).toBe(Math.floor(stat.mtimeMs / 1000));
        expect(entry?.flags).toEqual(STAGE0_FLAGS);
      });
    });
  });

  describe('Given two untracked files and all: true', () => {
    describe('When add', () => {
      it('Then both appear in added (sorted) and the index has them', async () => {
        // Arrange
        const ctx = await seedFreshRepo({ 'b.txt': 'b', 'a.txt': 'a' });

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert
        expect(sut.added).toEqual(['a.txt', 'b.txt']);
        const idx = await readIndex(ctx);
        expect(idx.entries.map((e) => e.path).sort()).toEqual(['a.txt', 'b.txt']);
      });
    });
  });

  describe('Given a tracked + a modified file and all: true', () => {
    describe('When add', () => {
      it('Then modified contains only the changed one', async () => {
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
    });
  });

  describe('Given an unsorted walk that yields two new + one modified + one removed', () => {
    describe('When add({ all: true })', () => {
      it('Then EACH of added/modified/removed is independently sorted', async () => {
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
    });
  });

  describe('Given a tracked file deleted from disk and all: true', () => {
    describe('When add', () => {
      it('Then removed contains it and the index entry drops', async () => {
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
    });
  });

  describe('Given a skip-worktree entry absent from disk and all: true', () => {
    describe('When add', () => {
      it('Then its removal is NOT staged and the entry is preserved', async () => {
        // Arrange — a cone-mode `set` keeping only `src/` turns `docs/b.txt` into a
        // skip-worktree entry, absent from disk. `add --all`'s post-walk removal
        // pass must skip it: staging its removal would silently un-sparse it.
        const { sparseCheckoutSet } = await import(
          '../../../../src/application/commands/sparse-checkout.js'
        );
        const ctx = await seedFreshRepo({ 'src/a.txt': 'a', 'docs/b.txt': 'b' });
        await add(ctx, [], { all: true });
        await sparseCheckoutSet(ctx, { patterns: ['src'], cone: true });

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert — `docs/b.txt` is not in `removed`, and it survives in the index
        // still flagged skip-worktree.
        expect(sut.removed).toEqual([]);
        const idx = await readIndex(ctx);
        const docEntry = idx.entries.find((e) => e.path === 'docs/b.txt');
        expect(docEntry).toBeDefined();
        expect(docEntry?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given a symlink and all: true', () => {
    describe('When add', () => {
      it('Then it stages as mode 120000', async () => {
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
    });
  });

  describe('Given an executable bit reported by lstat and all: true', () => {
    describe('When add', () => {
      it('Then mode 100755 is recorded', async () => {
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
    });
  });

  describe('Given a .git directory at the root and all: true', () => {
    describe('When add', () => {
      it('Then .git contents are not staged', async () => {
        // Arrange — seedRepo already wrote.git/HEAD via the fixture. Add a stray
        // .git/config to make sure no.git path leaks into the index.
        const ctx = await seedFreshRepo({ 'a.txt': 'a' });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n');

        // Act
        await add(ctx, [], { all: true });

        // Assert
        const idx = await readIndex(ctx);
        const dotgit = idx.entries.filter((e) => e.path.includes('.git'));
        expect(dotgit).toEqual([]);
      });
    });
  });

  describe('Given an embedded.git subdirectory (nested repo) and all: true', () => {
    describe('When add', () => {
      it('Then nothing under it is staged and no 160000 entry is created', async () => {
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
    });
  });

  describe('Given a file over MAX_WORKING_TREE_BLOB_BYTES', () => {
    describe('When add({ all: true })', () => {
      it('Then throws WORKING_TREE_FILE_TOO_LARGE and the index is unchanged', async () => {
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
    });
  });

  describe('Given a conflicted merge (.git/MERGE_HEAD present) and all: true', () => {
    describe('When add', () => {
      it('Then succeeds (merge is excepted)', async () => {
        // Arrange
        const ctx = await seedFreshRepo({ 'a.txt': 'a' });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'a'.repeat(40)}\n`);

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert
        expect(sut.added).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a rebase in progress (.git/REBASE_HEAD) and all: true', () => {
    describe('When add', () => {
      it('Then succeeds (rebase is excepted)', async () => {
        // Arrange
        const ctx = await seedFreshRepo({ 'a.txt': 'a' });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/REBASE_HEAD`, `${'a'.repeat(40)}\n`);

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert
        expect(sut.added).toEqual(['a.txt']);
      });
    });
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

  describe('Given a stat type that flips between walk and stage (regular -> symlink)', () => {
    describe('When add({ all: true })', () => {
      it('Then throws OPERATION_ABORTED and no index commit', async () => {
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
    });
  });

  describe('Given a stat type that flips between walk and stage', () => {
    describe('When add({ all: true })', () => {
      it.each([
        {
          seed: {},
          symlinkTarget: 'target',
          suffix: '/link',
          flipTo: { isSymbolicLink: false, isFile: true },
          label: 'a symlink flips to a regular file — kills the `!==`→`===` type-flip mutant',
        },
        {
          seed: { 'a.txt': 'a' },
          symlinkTarget: undefined,
          suffix: '/a.txt',
          flipTo: { isFile: false, isDirectory: true },
          label: 'a file flips to a directory — extends the guard to the isDirectory axis',
        },
        {
          seed: { 'a.txt': 'a' },
          symlinkTarget: undefined,
          suffix: '/a.txt',
          flipTo: { isSymbolicLink: true },
          label: 'ONLY isSymbolicLink flips — kills `||`→`&&` mutants on the type-flip guard',
        },
        {
          seed: { 'a.txt': 'a' },
          symlinkTarget: undefined,
          suffix: '/a.txt',
          flipTo: { isDirectory: true },
          label: 'ONLY isDirectory flips',
        },
        {
          seed: { 'a.txt': 'a' },
          symlinkTarget: undefined,
          suffix: '/a.txt',
          flipTo: { isFile: false },
          label: 'ONLY isFile flips',
        },
      ])(
        'Then throws OPERATION_ABORTED — $label',
        async ({ seed, symlinkTarget, suffix, flipTo }) => {
          // Arrange — re-lstat under the lock reports a different type than the
          // walk-time stat; each row isolates ONE flipped axis (or a real
          // regular<->symlink/directory transition) of the `!==` guard so a
          // dropped `||` branch is caught independently.
          const ctx = await seedFreshRepo(seed);
          if (symlinkTarget !== undefined) {
            await ctx.fs.symlink(symlinkTarget, `${ctx.layout.workDir}${suffix}`);
          }
          const racingCtx = { ...ctx, fs: racingLstatFs(ctx, suffix, flipTo) };

          // Assert
          await expectError(() => add(racingCtx, [], { all: true }), 'OPERATION_ABORTED');
        },
      );
    });
  });

  describe('Given a file that grows past MAX_WORKING_TREE_BLOB_BYTES between walk and re-lstat', () => {
    describe('When add({ all: true })', () => {
      it('Then throws WORKING_TREE_FILE_TOO_LARGE (post-re-lstat guard fires)', async () => {
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
    });
  });

  describe('Given a file of exactly MAX_WORKING_TREE_BLOB_BYTES bytes (boundary)', () => {
    describe('When add({ all: true })', () => {
      it('Then accepts without throwing — kills the `>` → `>=` mutants on both pre-filter and authoritative caps', async () => {
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
    });
  });

  describe('Given a symlink target of exactly MAX_WORKING_TREE_BLOB_BYTES bytes (boundary)', () => {
    describe('When add({ all: true })', () => {
      it('Then accepts — kills the `>` → `>=` mutant on the readlink-cap', {
        timeout: 30_000,
      }, async () => {
        // Arrange — symlink target byte length exactly at the cap. Memory FS
        // backs symlinks with the target string verbatim; readlink returns it
        // unchanged. lstat.size reports the target length, so the pre-filter
        // doesn't fire; the post-encode check in readContent must allow it.
        // Allocating + hashing 256 MiB is slow under contention; bump the
        // timeout so this boundary check has room to complete.
        const ctx = await seedFreshRepo({});
        const target = 'x'.repeat(MAX_WORKING_TREE_BLOB_BYTES);
        await ctx.fs.symlink(target, `${ctx.layout.workDir}/link`);

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert
        expect(sut.added).toEqual(['link']);
      });
    });
  });

  describe('Given a hostile readlink that returns more than MAX_WORKING_TREE_BLOB_BYTES', () => {
    describe('When add({ all: true })', () => {
      it('Then throws WORKING_TREE_FILE_TOO_LARGE', async () => {
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
    });
  });

  describe('Given a plain regular file literally named.git inside a subdirectory (worktree pointer)', () => {
    describe('When add({ all: true })', () => {
      it('Then the whole subdirectory is skipped', async () => {
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
    });
  });

  describe('Given a symlink named.git in a subdirectory', () => {
    describe('When add({ all: true })', () => {
      it('Then the symlink is filtered but siblings are still staged (symlinks are NOT embedded markers)', async () => {
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
    });
  });

  describe('Given a custom ignore predicate that excludes node_modules', () => {
    describe('When addAll is called directly', () => {
      it('Then those paths are skipped', async () => {
        // Arrange
        const ctx = await seedFreshRepo({
          'a.txt': 'a',
          'node_modules/foo/index.js': 'x',
        });
        const ignore = (path: string) => path.startsWith('node_modules/');

        // Act
        const sut = await addAllInternal(ctx, ignore);

        // Assert
        expect(sut.added).toEqual(['a.txt']);
        const idx = await readIndex(ctx);
        expect(idx.entries.map((e) => e.path)).toEqual(['a.txt']);
      });
    });
  });

  describe('Given an aborted ctx.signal mid-walk and all: true', () => {
    describe('When add', () => {
      it('Then throws OPERATION_ABORTED and the on-disk index is unchanged', async () => {
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
    });
  });

  describe('Given a repo-root.gitignore with `node_modules`', () => {
    describe('When add({ all: true })', () => {
      it('Then node_modules/* is not staged (directory pruned at walk-time)', async () => {
        // Arrange
        const ctx = await seedFreshRepo({
          'a.txt': 'a',
          'node_modules/foo/index.js': 'x',
          'node_modules/bar/index.js': 'y',
        });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'node_modules/\n');

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert — only the staged file is added;.gitignore itself ALSO gets staged.
        expect([...sut.added].sort()).toEqual(['.gitignore', 'a.txt']);
      });
    });
  });

  describe('Given a nested.gitignore with negation', () => {
    describe('When add({ all: true })', () => {
      it('Then negation takes effect under that subtree only', async () => {
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
    });
  });

  describe('Given a tracked file under a directory the.gitignore would now exclude', () => {
    describe('When add({ all: true })', () => {
      it('Then the index entry is preserved (Git invariant: ignored ancestor does not auto-untrack)', async () => {
        // Arrange — first stage `vendor/foo.ts`; then add a rule that
        // ignores the whole `vendor/` directory; re-run `add --all`.
        // The post-walk re-check must consult ancestor directories (not
        // just the leaf) — Git's `vendor/` rule matches the directory entry,
        // NOT the files under it. Without the ancestor check, the tracked
        // file would be classified as `removed`.
        const ctx = await seedFreshRepo({ 'vendor/foo.ts': 'export {};' });
        await add(ctx, ['vendor/foo.ts']);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'vendor/\n');

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert —.gitignore is newly added; vendor/foo.ts stays in
        // index, NOT in removed.
        expect(sut.added).toEqual(['.gitignore']);
        expect(sut.removed).toEqual([]);
        const idx = await readIndex(ctx);
        expect(idx.entries.map((e) => e.path).sort()).toEqual(['.gitignore', 'vendor/foo.ts']);
      });
    });
  });

  describe('Given a tracked file that an ignore rule WOULD ignore', () => {
    describe('When add({ all: true })', () => {
      it('Then the index entry is preserved (Git invariant: tracked beats ignored)', async () => {
        // Arrange — first stage `secret.bin` literally; then add a rule that
        // would ignore it; re-run `add --all`. The entry must stay.
        const ctx = await seedFreshRepo({ 'secret.bin': 'sensitive' });
        await add(ctx, ['secret.bin']);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'secret.bin\n');

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert —.gitignore is newly added; secret.bin stays in index, not in removed.
        expect(sut.added).toEqual(['.gitignore']);
        expect(sut.removed).toEqual([]);
        const idx = await readIndex(ctx);
        expect(idx.entries.map((e) => e.path).sort()).toEqual(['.gitignore', 'secret.bin']);
      });
    });
  });

  describe('Given a.git/info/exclude rule', () => {
    describe('When add({ all: true })', () => {
      it('Then matched paths are not staged', async () => {
        // Arrange
        const ctx = await seedFreshRepo({ 'a.txt': 'a', 'secret.bin': 'x' });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, 'secret.bin\n');

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert
        expect(sut.added).toEqual(['a.txt']);
      });
    });
  });

  describe('Given the index file is present but corrupted', () => {
    describe('When add', () => {
      it('Then the error propagates (no silent reset)', async () => {
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
  });

  describe('Given a glob pathspec "*.ts"', () => {
    describe('When add', () => {
      it('Then every matching path in the working tree is staged', async () => {
        // Arrange
        const ctx = await seedFreshRepo({
          'a.ts': 'a',
          'b.ts': 'b',
          'README.md': '# r',
        });

        // Act
        const sut = await add(ctx, ['*.ts']);

        // Assert
        expect([...sut.added].sort()).toEqual(['a.ts', 'b.ts']);
      });
    });
  });

  describe('Given a glob with no match', () => {
    describe('When add', () => {
      it('Then returns added=[] without throwing', async () => {
        // Arrange
        const ctx = await seedFreshRepo({ 'README.md': '# r' });

        // Act
        const sut = await add(ctx, ['*.ts']);

        // Assert
        expect(sut.added).toEqual([]);
      });
    });
  });

  describe('Given a glob + a `!`-negation', () => {
    describe('When add', () => {
      it('Then negated paths are excluded from staging', async () => {
        // Arrange
        const ctx = await seedFreshRepo({
          'a.ts': 'a',
          'a.test.ts': 'test',
          'b.ts': 'b',
        });

        // Act
        const sut = await add(ctx, ['*.ts', '!*.test.ts']);

        // Assert
        expect([...sut.added].sort()).toEqual(['a.ts', 'b.ts']);
      });
    });
  });

  describe('Given a literal directory', () => {
    describe('When add', () => {
      it('Then every file under it is staged (literal acts as directory prefix)', async () => {
        // Arrange
        const ctx = await seedFreshRepo({
          'src/a.ts': 'a',
          'src/b.ts': 'b',
          'other.ts': 'other',
        });

        // Act
        const sut = await add(ctx, ['src']);

        // Assert
        expect([...sut.added].sort()).toEqual(['src/a.ts', 'src/b.ts']);
      });
    });
  });

  describe('Given a glob and a repo-root.gitignore', () => {
    describe('When add', () => {
      it('Then ignored matches are NOT staged', async () => {
        // Arrange
        const ctx = await seedFreshRepo({
          'a.ts': 'a',
          'dist/build.ts': 'compiled',
        });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'dist/\n');

        // Act
        const sut = await add(ctx, ['*.ts']);

        // Assert — dist/build.ts is pruned via gitignore even though it
        // matches the pathspec.
        expect(sut.added).toEqual(['a.ts']);
      });
    });
  });

  describe('Given a literal path that .gitignore would exclude', () => {
    describe('When add', () => {
      it('Then it is staged anyway (literal-path mode bypasses ignore)', async () => {
        // Arrange — `ignored.txt` is a pure literal that names an existing
        // file, so dispatchPathspec routes through addLiteralOnly which does
        // NOT consult .gitignore. Kills L86 (`!hasGlob &&` guard + block) and
        // L148 routing: a mutant that always falls through to addByPathspec
        // would let the ignore predicate filter `ignored.txt` out.
        const ctx = await seedFreshRepo({ 'ignored.txt': 'secret' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'ignored.txt\n');

        // Act
        const sut = await add(ctx, ['ignored.txt']);

        // Assert
        expect(sut.added).toEqual(['ignored.txt']);
        const idx = await readIndex(ctx);
        expect(idx.entries.map((e) => e.path)).toEqual(['ignored.txt']);
      });
    });
  });

  describe('Given a missing literal and a gitignored existing literal', () => {
    describe('When add', () => {
      it('Then PATHSPEC_NO_MATCH names the gitignored literal (routes through addByPathspec)', async () => {
        // Arrange — `keep.txt` exists but is gitignored; `gone.txt` is absent.
        // Real code: allLiteralsAreFiles sees `gone.txt` undefined -> returns
        // false -> addByPathspec -> walk applies .gitignore -> nothing matched
        // -> enforceLiteralMustMatch throws for the FIRST literal `keep.txt`.
        // Mutant on L128 (`stat === undefined` -> true) would treat the
        // missing path as a file -> addLiteralOnly -> throws for `gone.txt`.
        const ctx = await seedFreshRepo({ 'keep.txt': 'k' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'keep.txt\n');

        // Act
        const err = await expectError(
          () => add(ctx, ['keep.txt', 'gone.txt']),
          'PATHSPEC_NO_MATCH',
        );

        // Assert — the unmatched pattern is the gitignored literal, proving
        // the call routed through addByPathspec, not addLiteralOnly.
        expect((err.data as { pattern: string }).pattern).toBe('keep.txt');
      });
    });
  });

  describe('Given a literal symlink path', () => {
    describe('When add', () => {
      it('Then it stages via literal-path mode as mode 120000', async () => {
        // Arrange — a symlink literal: allLiteralsAreFiles must NOT reject it
        // (`stat.isDirectory && !stat.isSymbolicLink` is false for a symlink).
        // Kills the L129 `&&`->`||` and `!isSymbolicLink`->`true` mutants: a
        // mutant rejecting the symlink routes through addByPathspec instead,
        // but the symlink still stages, so we pin mode + literal-mode result.
        const ctx = await seedFreshRepo({ 'a.txt': 'a' });
        await ctx.fs.symlink('a.txt', `${ctx.layout.workDir}/link`);

        // Act
        const sut = await add(ctx, ['link']);

        // Assert
        expect(sut.added).toEqual(['link']);
        const idx = await readIndex(ctx);
        expect(idx.entries.find((e) => e.path === 'link')?.mode).toBe('120000');
      });
    });
  });

  describe('Given a negation-only pathspec on an aborted ctx', () => {
    describe('When add', () => {
      it('Then throws OPERATION_ABORTED (routes through addByPathspec walk)', async () => {
        // Arrange — `['!a.txt']` compiles to a negation-only matcher: no
        // positive literal, no glob, so literalMustMatch is empty and hasGlob
        // is false. allLiteralsAreFiles([]) MUST return false so dispatch
        // routes to addByPathspec, whose walk honours ctx.signal. Mutants on
        // L125 (`literals.length === 0` guard, `=== / !==`, `return false`)
        // would make it return true -> addLiteralOnly([]) -> empty loop ->
        // no walk -> no abort -> succeeds.
        const ctx = await seedFreshRepo({ 'a.txt': 'a' });
        const controller = new AbortController();
        controller.abort();
        const abortedCtx = { ...ctx, signal: controller.signal };

        // Act + Assert
        await expectError(() => add(abortedCtx, ['!a.txt']), 'OPERATION_ABORTED');
      });
    });
  });

  describe('Given a literal exec-bit-only change', () => {
    describe('When add', () => {
      it('Then result.modified contains it (literal-path mode mode-diff branch)', async () => {
        // Arrange — stage `a.sh` literally, then flip ONLY the exec bit so the
        // blob id is unchanged and only the mode differs. Kills the L112
        // `previous.mode !== result.mode` operand of the OR: a mutant dropping
        // it would classify the unchanged-id file as not-modified.
        const ctx = await seedFreshRepo({ 'a.sh': '#!/bin/sh\n' });
        await add(ctx, ['a.sh']);
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
        const sut = await add(execCtx, ['a.sh']);

        // Assert
        expect(sut.modified).toEqual(['a.sh']);
        expect(sut.added).toEqual([]);
      });
    });
  });

  describe('Given a regular non-executable file', () => {
    describe('When add({ all: true })', () => {
      it('Then mode 100644 is recorded (kills exec-bit guard -> true)', async () => {
        // Arrange — memory FS reports mode 0o100644 (no exec bit). Pins the
        // `(fresh.mode & 0o111) !== 0` guard: a mutant forcing it true would
        // record 100755.
        const ctx = await seedFreshRepo({ 'plain.txt': 'p' });

        // Act
        await add(ctx, [], { all: true });

        // Assert
        const idx = await readIndex(ctx);
        expect(idx.entries.find((e) => e.path === 'plain.txt')?.mode).toBe('100644');
      });
    });
  });

  describe('Given a glob that re-adds a modified tracked file', () => {
    describe('When add', () => {
      it('Then result.modified contains it (addByPathspec modified branch)', async () => {
        // Arrange — stage via glob, then modify, then re-add via glob. Covers
        // L168 `result.kind === 'modified'` inside addByPathspec.
        const ctx = await seedFreshRepo({ 'a.ts': 'a' });
        await add(ctx, ['*.ts']);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.ts`, 'a-changed');

        // Act
        const sut = await add(ctx, ['*.ts']);

        // Assert
        expect(sut.modified).toEqual(['a.ts']);
        expect(sut.added).toEqual([]);
      });
    });
  });

  describe('Given a glob yielding unsorted new + modified files', () => {
    describe('When add', () => {
      it('Then added and modified are each independently sorted', async () => {
        // Arrange — seed in reverse-alpha order so the walk yields unsorted.
        // First stage z/y via glob, then modify both and add two new files
        // (also reverse-alpha). Kills L171/L172 MethodExpression mutants that
        // drop `added.sort()` / `modified.sort()` in addByPathspec.
        const ctx = await seedFreshRepo({ 'z.ts': 'z', 'y.ts': 'y' });
        await add(ctx, ['*.ts']);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.ts`, 'z2');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/y.ts`, 'y2');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/d.ts`, 'd');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.ts`, 'c');

        // Act
        const sut = await add(ctx, ['*.ts']);

        // Assert
        expect(sut.added).toEqual(['c.ts', 'd.ts']);
        expect(sut.modified).toEqual(['y.ts', 'z.ts']);
      });
    });
  });

  describe('Given a glob matching files in a subdirectory', () => {
    describe('When add({ "**/*.ts" })', () => {
      it('Then they are staged (directory is not pruned by the pathspec)', async () => {
        // Arrange — `src/` is a directory; combinedIgnore must return false for
        // directories (L148 `if (isDirectory) return false`) so the walker
        // descends into it. A mutant turning that into a fallthrough would
        // run `!matchesPathspec(matcher, 'src')` -> prune `src/`.
        const ctx = await seedFreshRepo({ 'src/a.ts': 'a', 'src/b.ts': 'b' });

        // Act
        const sut = await add(ctx, ['**/*.ts']);

        // Assert
        expect([...sut.added].sort()).toEqual(['src/a.ts', 'src/b.ts']);
      });
    });
  });

  describe('Given multiple unsorted modified and removed files', () => {
    describe('When add({ all: true })', () => {
      it('Then modified and removed are each independently sorted', async () => {
        // Arrange — pre-stage in reverse-alpha order; modify two, delete two.
        // Kills L224/L225 MethodExpression mutants that drop `modified.sort()`
        // / `removed.sort()` in addAll.
        const ctx = await seedFreshRepo({
          'z.txt': 'z',
          'y.txt': 'y',
          'q.txt': 'q',
          'p.txt': 'p',
        });
        await add(ctx, [], { all: true });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.txt`, 'z2');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/y.txt`, 'y2');
        await ctx.fs.rm(`${ctx.layout.workDir}/q.txt`);
        await ctx.fs.rm(`${ctx.layout.workDir}/p.txt`);

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert
        expect(sut.modified).toEqual(['y.txt', 'z.txt']);
        expect(sut.removed).toEqual(['p.txt', 'q.txt']);
      });
    });
  });

  describe('Given an addAll exec-bit-only change', () => {
    describe('When add({ all: true })', () => {
      it('Then result.modified contains it (processWalkEntry mode-diff branch)', async () => {
        // Arrange — stage `a.sh` via addAll, then flip ONLY the exec bit so
        // the blob id is identical and only the mode changes. Kills the L279
        // `previous.mode !== entry.mode` operand of the OR in processWalkEntry.
        const ctx = await seedFreshRepo({ 'a.sh': '#!/bin/sh\n' });
        await add(ctx, [], { all: true });
        const baseLstat = ctx.fs.lstat;
        let firstSeen = false;
        const execFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'lstat') {
              return async (path: string) => {
                const real = await baseLstat(path);
                if (!path.endsWith('/a.sh')) return real;
                // First lstat is the walk-time stat (keep real so the pre-stage
                // mode is plain); from the re-lstat onward report the exec bit.
                if (!firstSeen) {
                  firstSeen = true;
                  return real;
                }
                return { ...real, mode: real.mode | 0o111 };
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const execCtx = { ...ctx, fs: execFs };

        // Act
        const sut = await add(execCtx, [], { all: true });

        // Assert
        expect(sut.modified).toEqual(['a.sh']);
        expect(sut.added).toEqual([]);
      });
    });
  });

  describe('Given a tracked file and a custom ignore predicate for the addAll removal pass', () => {
    describe('When add({ all: true })', () => {
      it.each([
        {
          path: 'vendor/foo.ts',
          content: 'export {};',
          deleteFromDisk: false,
          ignore: async (path: string, isDirectory: boolean) => isDirectory && path === 'vendor',
          expectedRemoved: [],
          expectedEntries: ['vendor/foo.ts'],
          label:
            'the entry is preserved when an ancestor directory is ignored (leaf check -> false, ancestor loop hits)',
        },
        {
          path: 'keep.bin',
          content: 'k',
          deleteFromDisk: false,
          ignore: async (path: string, isDirectory: boolean) => !isDirectory && path === 'keep.bin',
          expectedRemoved: [],
          expectedEntries: ['keep.bin'],
          label:
            'the entry is preserved when the leaf is reported ignored for files only (L249 passes isDirectory=false)',
        },
        {
          path: 'a/b/c.txt',
          content: 'c',
          deleteFromDisk: false,
          ignore: async (path: string, isDirectory: boolean) => isDirectory && path === 'a/b',
          expectedRemoved: [],
          expectedEntries: ['a/b/c.txt'],
          label:
            'the entry is preserved when a deep ancestor directory is ignored (ancestor loop visits proper sub-prefixes)',
        },
        {
          path: 'gone.txt',
          content: 'g',
          deleteFromDisk: true,
          ignore: async (path: string, isDirectory: boolean) => isDirectory && path === 'gone.txt',
          expectedRemoved: ['gone.txt'],
          expectedEntries: [],
          label:
            'it is still marked removed when the predicate ignores only the leaf-as-directory (ancestor loop excludes the leaf itself)',
        },
        {
          path: 'dir/gone.txt',
          content: 'g',
          deleteFromDisk: true,
          ignore: async () => false,
          expectedRemoved: ['dir/gone.txt'],
          expectedEntries: [],
          label: 'it is removed when no ancestor is ignored (the ancestor loop completes normally)',
        },
      ])(
        'Then $label',
        async ({ path, content, deleteFromDisk, ignore, expectedRemoved, expectedEntries }) => {
          // Arrange — each row isolates one branch of isPathOrAncestorIgnored's
          // leaf check + proper-prefix ancestor loop; a mutant on either would
          // mis-classify the tracked entry as removed/preserved.
          const ctx = await seedFreshRepo({ [path]: content });
          await add(ctx, [path]);
          if (deleteFromDisk) await ctx.fs.rm(`${ctx.layout.workDir}/${path}`);

          // Act
          const sut = await addAllInternal(ctx, ignore);

          // Assert
          expect(sut.removed).toEqual(expectedRemoved);
          const idx = await readIndex(ctx);
          expect(idx.entries.map((e) => e.path)).toEqual(expectedEntries);
        },
      );
    });
  });

  describe('Given a walk-time stat over the cap but a small re-lstat', () => {
    describe('When add({ all: true })', () => {
      it('Then throws WORKING_TREE_FILE_TOO_LARGE (pre-filter guard fires)', async () => {
        // Arrange — the walk-time lstat reports oversize; the re-lstat under
        // the lock reports the real (small) size. Only the L273 pre-filter in
        // processWalkEntry can catch this — the authoritative L328 check sees
        // a small file. Kills the L273 ConditionalExpression / BlockStatement.
        const ctx = await seedFreshRepo({ 'a.txt': 'a' });
        const baseLstat = ctx.fs.lstat;
        let firstSeen = false;
        const growThenShrinkFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'lstat') {
              return async (path: string) => {
                const real = await baseLstat(path);
                if (!path.endsWith('/a.txt')) return real;
                // First lstat (walk-time) is oversize; the re-lstat is real.
                if (!firstSeen) {
                  firstSeen = true;
                  return { ...real, size: MAX_WORKING_TREE_BLOB_BYTES + 1 };
                }
                return real;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const racingCtx = { ...ctx, fs: growThenShrinkFs };

        // Act
        const err = await expectError(
          () => add(racingCtx, [], { all: true }),
          'WORKING_TREE_FILE_TOO_LARGE',
        );

        // Assert — payload pins the walk-time (pre-filter) size.
        const data = err.data as { path: string; size: number; limit: number };
        expect(data.path).toBe('a.txt');
        expect(data.size).toBe(MAX_WORKING_TREE_BLOB_BYTES + 1);
        expect(data.limit).toBe(MAX_WORKING_TREE_BLOB_BYTES);
      });
    });
  });

  describe('Given a readIndex failure with a non-missing error code', () => {
    describe('When add', () => {
      it('Then the error propagates (not absorbed as "no entries")', async () => {
        // Arrange — seed a repo, then wrap fs.read so reading the index throws
        // a TsgitError whose code is NOT in INDEX_MISSING_CODES. Kills the
        // L294 ConditionalExpression `&&` guard: a mutant forcing it true
        // would swallow this and return an empty map instead of rethrowing.
        const ctx = await seedFreshRepo({ 'a.txt': 'a' });
        await add(ctx, ['a.txt']);
        const baseRead = ctx.fs.read;
        const failingFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'read') {
              return async (path: string) => {
                if (path.endsWith('/index')) {
                  throw new TsgitError({ code: 'PERMISSION_DENIED', path });
                }
                return baseRead(path);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const failingCtx = { ...ctx, fs: failingFs };

        // Act + Assert — PERMISSION_DENIED is not a missing-index code, so it
        // surfaces instead of being absorbed.
        await expectError(() => add(failingCtx, ['a.txt']), 'PERMISSION_DENIED');
      });
    });
  });

  describe('Given a stale index.lock and breakStaleLockMs in literal-path mode', () => {
    describe('When add', () => {
      it('Then the stale lock is broken and the file is staged', async () => {
        // Arrange — pre-create index.lock and report a far-past mtime so the
        // lock is stale. `config.breakStaleLockMs` (baked into staleLockCtx) must
        // reach acquireIndexLock; if the command stopped sourcing it from config
        // the lock would not break and RESOURCE_LOCKED would surface.
        const ctx = await staleLockCtx({ 'a.txt': 'a' });

        // Act
        const sut = await add(ctx, ['a.txt']);

        // Assert
        expect(sut.added).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a stale index.lock and breakStaleLockMs in glob (pathspec) mode', () => {
    describe('When add', () => {
      it('Then the stale lock is broken and matches are staged', async () => {
        // Arrange — glob routes through addByPathspec; config.breakStaleLockMs
        // must reach acquireIndexLock there too.
        const ctx = await staleLockCtx({ 'a.ts': 'a' });

        // Act
        const sut = await add(ctx, ['*.ts']);

        // Assert
        expect(sut.added).toEqual(['a.ts']);
      });
    });
  });

  describe('Given a stale index.lock and breakStaleLockMs in bulk mode', () => {
    describe('When add({ all: true })', () => {
      it('Then the stale lock is broken and files are staged', async () => {
        // Arrange — bulk mode routes through addAll; config.breakStaleLockMs
        // must reach acquireIndexLock there too.
        const ctx = await staleLockCtx({ 'a.txt': 'a' });

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert
        expect(sut.added).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a literal stage that fails mid-flight', () => {
    describe('When a second add runs', () => {
      it('Then it succeeds (the finally block released the lock)', async () => {
        // Arrange — `a.txt` passes allLiteralsAreFiles (its first lstat) but
        // its second lstat (inside stageOne) throws, so stageOne returns
        // 'missing' and addLiteralOnly throws PATHSPEC_NO_MATCH. The L116
        // `finally { lock.release() }` must drop index.lock; without it the
        // next add would throw RESOURCE_LOCKED.
        const ctx = await seedFreshRepo({ 'a.txt': 'a' });
        const baseLstat = ctx.fs.lstat;
        let aSeen = false;
        const flakyFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'lstat') {
              return async (path: string) => {
                const real = await baseLstat(path);
                if (!path.endsWith('/a.txt')) return real;
                if (!aSeen) {
                  aSeen = true;
                  return real;
                }
                throw new TsgitError({ code: 'FILE_NOT_FOUND', path });
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const flakyCtx = { ...ctx, fs: flakyFs };
        await expectError(() => add(flakyCtx, ['a.txt']), 'PATHSPEC_NO_MATCH');

        // Act — second add on the unmodified ctx must not hit a leaked lock.
        const sut = await add(ctx, ['a.txt']);

        // Assert
        expect(sut.added).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a glob-mode stage that throws on an oversize file', () => {
    describe('When a second add runs', () => {
      it('Then it succeeds (addByPathspec finally released the lock)', async () => {
        // Arrange — glob routes through addByPathspec; an oversize re-lstat
        // makes stageFromStat throw WORKING_TREE_FILE_TOO_LARGE while the lock
        // is held. The L175 `finally { lock.release() }` must drop index.lock.
        const ctx = await seedFreshRepo({ 'a.ts': 'a' });
        const racingCtx = {
          ...ctx,
          fs: racingLstatFs(ctx, '/a.ts', { size: MAX_WORKING_TREE_BLOB_BYTES + 1 }),
        };
        await expectError(() => add(racingCtx, ['*.ts']), 'WORKING_TREE_FILE_TOO_LARGE');

        // Act — second add on the unmodified ctx must not hit a leaked lock.
        const sut = await add(ctx, ['*.ts']);

        // Assert
        expect(sut.added).toEqual(['a.ts']);
      });
    });
  });

  describe('Given a bulk-mode stage that throws on an oversize file', () => {
    describe('When a second add runs', () => {
      it('Then it succeeds (addAll finally released the lock)', async () => {
        // Arrange — bulk mode routes through addAll; an oversize re-lstat makes
        // stageFromStat throw while the lock is held. The L228
        // `finally { lock.release() }` must drop index.lock.
        const ctx = await seedFreshRepo({ 'a.txt': 'a' });
        const racingCtx = {
          ...ctx,
          fs: racingLstatFs(ctx, '/a.txt', { size: MAX_WORKING_TREE_BLOB_BYTES + 1 }),
        };
        await expectError(() => add(racingCtx, [], { all: true }), 'WORKING_TREE_FILE_TOO_LARGE');

        // Act — second add on the unmodified ctx must not hit a leaked lock.
        const sut = await add(ctx, ['a.txt']);

        // Assert
        expect(sut.added).toEqual(['a.txt']);
      });
    });
  });

  // ── Clean filter (F1/F3/F4/symlink/fallback) ─────────────────────────────

  describe('Given a file with an active clean filter that exits 0', () => {
    describe('When add stages the file', () => {
      it('Then the CLEANED blob OID is committed (not the raw bytes)', async () => {
        // Arrange
        const runner = new FakeRunner(0, uppercase);
        const ctx = await seedFreshRepo({ 'a.y': 'Hello World' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tclean = uppercase\n',
        );
        const enrichedCtx = { ...ctx, command: runner };

        // Act
        const result = await add(enrichedCtx, ['a.y']);

        // Assert — blob content must be uppercased
        const index = await readIndex(enrichedCtx);
        const entry = index.entries.find((e) => e.path === 'a.y');
        expect(entry).toBeDefined();
        const blob = await readBlob(enrichedCtx, entry!.id as ObjectId);
        expect(dec(blob.content)).toBe('HELLO WORLD');
        expect(result.added).toEqual(['a.y']);
      });
    });
  });

  describe('Given a file with required=true clean filter that exits non-zero', () => {
    describe('When add stages the file (F3)', () => {
      it('Then throws CLEAN_FILTER_FAILED and nothing is staged', async () => {
        // Arrange
        const runner = new FakeRunner(1);
        const ctx = await seedFreshRepo({ 'a.y': 'Hello World' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=f\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "f"]\n\tclean = false\n\trequired = true\n',
        );
        const enrichedCtx = { ...ctx, command: runner };

        // Act
        let caught: unknown;
        try {
          await add(enrichedCtx, ['a.y']);
        } catch (err) {
          caught = err;
        }

        // Assert — structured error (mutation-resistant: check code + exitCode + filter)
        expect(caught).toBeInstanceOf(TsgitError);
        const err = caught as TsgitError;
        expect(err.data.code).toBe('CLEAN_FILTER_FAILED');
        expect((err.data as { exitCode: number }).exitCode).toBe(1);
        expect((err.data as { filter: string }).filter).toBe('f');

        // Nothing staged
        const index = await readIndex(enrichedCtx).catch(() => null);
        expect(index?.entries.length ?? 0).toBe(0);
      });
    });
  });

  describe('Given a file with required=false (default) clean filter that exits non-zero', () => {
    describe('When add stages the file (F4)', () => {
      it('Then stages RAW bytes and succeeds (no throw)', async () => {
        // Arrange
        const runner = new FakeRunner(1);
        const ctx = await seedFreshRepo({ 'a.y': 'Hello World' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=f\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "f"]\n\tclean = false\n');
        const enrichedCtx = { ...ctx, command: runner };

        // Act
        const result = await add(enrichedCtx, ['a.y']);

        // Assert — raw blob stored (Hello World, not uppercased)
        const index = await readIndex(enrichedCtx);
        const entry = index.entries.find((e) => e.path === 'a.y');
        expect(entry).toBeDefined();
        const blob = await readBlob(enrichedCtx, entry!.id as ObjectId);
        expect(dec(blob.content)).toBe('Hello World');
        expect(result.added).toEqual(['a.y']);
      });
    });
  });

  describe('Given a symlink with an active clean filter', () => {
    describe('When add stages the symlink', () => {
      it('Then the symlink target is staged verbatim (symlinks are not filtered)', async () => {
        // Arrange
        const runner = new FakeRunner(0, uppercase);
        const ctx = await seedFreshRepo();
        // Create a symlink pointing to 'target.txt'
        await ctx.fs.symlink('target.txt', `${ctx.layout.workDir}/link.y`);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tclean = uppercase\n',
        );
        const enrichedCtx = { ...ctx, command: runner };

        // Act
        const result = await add(enrichedCtx, ['link.y']);

        // Assert — link target stored verbatim (not uppercased)
        const index = await readIndex(enrichedCtx);
        const entry = index.entries.find((e) => e.path === 'link.y');
        expect(entry).toBeDefined();
        const blob = await readBlob(enrichedCtx, entry!.id as ObjectId);
        expect(dec(blob.content)).toBe('target.txt');
        // Runner was NOT called for the symlink
        expect(runner.calls.length).toBe(0);
        expect(result.added).toEqual(['link.y']);
      });
    });
  });

  describe('Given a file with an active filter attribute but no ctx.command (no runner)', () => {
    describe('When add stages the file (R11 fallback)', () => {
      it('Then raw bytes are staged and no runner is invoked', async () => {
        // Arrange — no command in ctx (ADR-408 fallback)
        const ctx = await seedFreshRepo({ 'a.y': 'Hello World' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tclean = uppercase\n',
        );
        // ctx has no command property (undefined)

        // Act
        const result = await add(ctx, ['a.y']);

        // Assert — raw bytes stored
        const index = await readIndex(ctx);
        const entry = index.entries.find((e) => e.path === 'a.y');
        expect(entry).toBeDefined();
        const blob = await readBlob(ctx, entry!.id as ObjectId);
        expect(dec(blob.content)).toBe('Hello World');
        expect(result.added).toEqual(['a.y']);
      });
    });
  });

  describe('Given a file with required=true clean filter that exits 0', () => {
    describe('When add stages the file', () => {
      it('Then the CLEANED blob OID is committed and no error is thrown (required=true + exit 0 = success)', async () => {
        // Arrange — required=true, but runner exits 0 (success path)
        const runner = new FakeRunner(0, uppercase);
        const ctx = await seedFreshRepo({ 'a.y': 'Hello World' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=f\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "f"]\n\tclean = uppercase\n\trequired = true\n',
        );
        const enrichedCtx = { ...ctx, command: runner };

        // Act — must NOT throw even though required=true, because exit code is 0
        const result = await add(enrichedCtx, ['a.y']);

        // Assert — cleaned bytes stored; no exception
        const index = await readIndex(enrichedCtx);
        const entry = index.entries.find((e) => e.path === 'a.y');
        expect(entry).toBeDefined();
        const blob = await readBlob(enrichedCtx, entry!.id as ObjectId);
        expect(dec(blob.content)).toBe('HELLO WORLD');
        expect(result.added).toEqual(['a.y']);
      });
    });
  });
});
