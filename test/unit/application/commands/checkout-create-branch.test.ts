import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { acquireIndexLock } from '../../../../src/application/primitives/internal/index-lock.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index.js';
import type { TsgitError } from '../../../../src/domain/index.js';
import type {
  AuthorIdentity,
  FilePath,
  ObjectId,
  RefName,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

interface Seed {
  readonly ctx: Context;
  readonly first: ObjectId;
  readonly second: ObjectId;
}

/** `other` at the first commit, `main` one commit ahead with different content. */
const seed = async (): Promise<Seed> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'A');
  await add(ctx, ['a.txt']);
  const first = (await commit(ctx, { message: 'first', author })).id;
  await branchCreate(ctx, { name: 'other' });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'B');
  await add(ctx, ['a.txt']);
  const second = (await commit(ctx, { message: 'second', author })).id;
  return { ctx, first, second };
};

const readText = (ctx: Context, path: string): Promise<string> => ctx.fs.readUtf8(path);

describe('checkout createBranch', () => {
  describe('Given a start point naming another branch', () => {
    describe('When checkout creates a new branch there', () => {
      it('Then the branch is created at the start point, HEAD attaches to it and the tree switches', async () => {
        // Arrange
        const { ctx, first } = await seed();
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'other', createBranch: { name: 'topic' } });

        // Assert
        expect(result).toEqual({
          branch: 'refs/heads/topic',
          id: first,
          detached: false,
          changedPaths: 1,
        });
        expect(await readText(ctx, `${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/topic\n');
        expect(await readText(ctx, `${ctx.layout.gitDir}/refs/heads/topic`)).toBe(`${first}\n`);
        expect(await readText(ctx, `${ctx.layout.workDir}/a.txt`)).toBe('A');
        const headLog = await readText(ctx, `${ctx.layout.gitDir}/logs/HEAD`);
        expect(headLog.trimEnd().split('\n').at(-1)).toMatch(
          /\tcheckout: moving from main to topic$/,
        );
      });
    });
  });

  describe('Given a start point and an explicit track', () => {
    describe('When checkout creates a new branch tracking it', () => {
      it('Then branch.<new>.remote and merge record the local start branch', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        await sut(ctx, { rev: 'other', createBranch: { name: 't2', track: 'direct' } });

        // Assert
        const config = await readText(ctx, `${ctx.layout.gitDir}/config`);
        expect(config).toContain('[branch "t2"]\n\tremote = .\n\tmerge = refs/heads/other\n');
      });
    });
  });

  describe('Given a branch name already taken', () => {
    describe('When checkout tries to create it', () => {
      it('Then it refuses before touching the work tree', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { rev: 'other', createBranch: { name: 'main' } });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'BRANCH_EXISTS',
          name: 'refs/heads/main',
        });
        expect(await readText(ctx, `${ctx.layout.workDir}/a.txt`)).toBe('B');
        expect(await readText(ctx, `${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/main\n');
      });
    });
  });

  describe('Given detach alongside a new branch', () => {
    describe('When checkout runs', () => {
      it('Then it refuses the combination', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { rev: 'other', detach: true, createBranch: { name: 'topic' } });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_OPTION',
          option: 'createBranch',
          reason: 'cannot be combined with detach',
        });
      });
    });
  });

  describe('Given HEAD as the new branch name and detach', () => {
    describe('When checkout runs', () => {
      it('Then it refuses the name before the detach conflict', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { createBranch: { name: 'HEAD' }, detach: true });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'branch name must not be HEAD',
        });
      });
    });
  });

  describe('Given an existing branch name and detach', () => {
    describe('When checkout runs', () => {
      it('Then it refuses the existing branch before the detach conflict and HEAD stays', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { createBranch: { name: 'main' }, detach: true });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'BRANCH_EXISTS',
          name: 'refs/heads/main',
        });
        expect(await readText(ctx, `${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/main\n');
      });
    });
  });
});

describe('checkout createBranch with no start point on a born HEAD', () => {
  describe('Given a born HEAD, When checkout creates x with no start point', () => {
    it('Then x is created at HEAD from the start point HEAD', async () => {
      // Arrange
      const { ctx, second } = await seed();
      const sut = checkout;

      // Act
      await sut(ctx, { createBranch: { name: 'x' } });

      // Assert
      expect(await readText(ctx, `${ctx.layout.gitDir}/refs/heads/x`)).toBe(`${second}\n`);
      const branchLog = await readReflog(ctx, 'refs/heads/x' as RefName);
      expect(branchLog.at(-1)?.message).toBe('branch: Created from HEAD');
      const headLog = await readReflog(ctx, 'HEAD' as RefName);
      expect(headLog.at(-1)?.message).toBe('checkout: moving from main to x');
    });
  });
});

describe('checkout createBranch from an unborn HEAD', () => {
  const unbornBranchRefusal = async (ctx: Context, rev: string): Promise<unknown> => {
    try {
      await checkout(ctx, { rev, createBranch: { name: 'x' } });
    } catch (error) {
      return (error as TsgitError).data;
    }
    return undefined;
  };

  describe.each(['HEAD', '@', 'main'])('Given an unborn main and the start point %s', (rev) => {
    describe('When checkout creates x from it', () => {
      it('Then it refuses: no branch can come from that start point', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f`, 'a');
        await add(ctx, ['f']);

        // Act
        const result = await unbornBranchRefusal(ctx, rev);

        // Assert
        expect(result).toEqual({
          code: 'CHECKOUT_START_POINT_NOT_COMMIT',
          revision: rev,
          branch: 'x',
        });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/x`)).toBe(false);
      });
    });
  });

  describe('Given an orphan HEAD and a commit-backed main', () => {
    describe('When checkout creates x from main', () => {
      it('Then x is created at main and HEAD attaches to it', async () => {
        // Arrange
        const { ctx, second } = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/o\n');
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'main', createBranch: { name: 'x' } });

        // Assert
        expect(result).toEqual({
          branch: 'refs/heads/x',
          id: second,
          detached: false,
          changedPaths: 0,
        });
        expect(await readText(ctx, `${ctx.layout.gitDir}/refs/heads/x`)).toBe(`${second}\n`);
        expect(await readText(ctx, `${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/x\n');
        const branchLog = await readReflog(ctx, 'refs/heads/x' as RefName);
        expect(branchLog.at(-1)?.message).toBe('branch: Created from main');
        const headLog = await readReflog(ctx, 'HEAD' as RefName);
        expect(headLog.at(-1)?.message).toBe('checkout: moving from o to x');
      });
    });
  });
});

describe('checkout from an unborn HEAD with no start point', () => {
  interface UnbornSeed {
    readonly ctx: Context;
    readonly runner: MemoryHookRunner;
  }

  const seedUnborn = async (): Promise<UnbornSeed> => {
    const runner = new MemoryHookRunner();
    const ctx = createMemoryContext({ hooks: runner });
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f`, 'a');
    await add(ctx, ['f']);
    return { ctx, runner };
  };

  const dataOf = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (error) {
      return (error as TsgitError).data;
    }
    return undefined;
  };

  const headFile = (ctx: Context): Promise<string> => readText(ctx, `${ctx.layout.gitDir}/HEAD`);
  const indexFile = (ctx: Context): Promise<Uint8Array> =>
    ctx.fs.read(`${ctx.layout.gitDir}/index`);

  describe('Given an unborn HEAD', () => {
    describe('When checkout creates x with no start point', () => {
      it('Then only HEAD moves: no ref, no index change, no reflog, no hook', async () => {
        // Arrange
        const { ctx, runner } = await seedUnborn();
        const indexBefore = await indexFile(ctx);
        const sut = checkout;

        // Act
        const result = await sut(ctx, { createBranch: { name: 'x' } });

        // Assert
        expect(result).toEqual({
          branch: 'refs/heads/x',
          id: '0'.repeat(40),
          detached: false,
          changedPaths: 0,
        });
        expect(await headFile(ctx)).toBe('ref: refs/heads/x\n');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/x`)).toBe(false);
        expect(await indexFile(ctx)).toEqual(indexBefore);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/HEAD`)).toBe(false);
        expect(runner.calls.map((call) => call.name)).not.toContain('post-checkout');
        expect(await readText(ctx, `${ctx.layout.workDir}/f`)).toBe('a');
      });
    });

    describe('When checkout creates x with a track request', () => {
      it('Then no branch config is written', async () => {
        // Arrange
        const { ctx } = await seedUnborn();
        const sut = checkout;

        // Act
        await sut(ctx, { createBranch: { name: 'x', track: 'direct' } });

        // Assert
        const config = await readText(ctx, `${ctx.layout.gitDir}/config`);
        expect(config).not.toContain('[branch "x"]');
      });
    });

    describe('When checkout creates x forced', () => {
      it('Then it behaves as unforced', async () => {
        // Arrange
        const { ctx } = await seedUnborn();
        const sut = checkout;

        // Act
        const result = await sut(ctx, { force: true, createBranch: { name: 'x' } });

        // Assert
        expect(result.branch).toBe('refs/heads/x');
        expect(await headFile(ctx)).toBe('ref: refs/heads/x\n');
      });
    });

    describe('When checkout creates x with detach', () => {
      it('Then it refuses the combination and HEAD stays', async () => {
        // Arrange
        const { ctx } = await seedUnborn();
        const before = await headFile(ctx);
        const sut = checkout;

        // Act
        const result = await dataOf(() => sut(ctx, { detach: true, createBranch: { name: 'x' } }));

        // Assert
        expect(result).toEqual({
          code: 'INVALID_OPTION',
          option: 'createBranch',
          reason: 'cannot be combined with detach',
        });
        expect(await headFile(ctx)).toBe(before);
      });
    });

    describe('When checkout creates HEAD with detach', () => {
      it('Then it refuses the name before the detach conflict and HEAD stays', async () => {
        // Arrange
        const { ctx } = await seedUnborn();
        const before = await headFile(ctx);
        const sut = checkout;

        // Act
        const result = await dataOf(() =>
          sut(ctx, { detach: true, createBranch: { name: 'HEAD' } }),
        );

        // Assert
        expect(result).toEqual({ code: 'INVALID_REF', reason: 'branch name must not be HEAD' });
        expect(await headFile(ctx)).toBe(before);
      });
    });

    describe('When checkout creates a branch with an invalid name', () => {
      it('Then it refuses INVALID_REF and HEAD stays', async () => {
        // Arrange
        const { ctx } = await seedUnborn();
        const before = await headFile(ctx);
        const sut = checkout;

        // Act
        const result = await dataOf(() => sut(ctx, { createBranch: { name: 'x..y' } }));

        // Assert
        expect(result).toEqual({ code: 'INVALID_REF', reason: 'ref name must not contain ..' });
        expect(await headFile(ctx)).toBe(before);
      });
    });

    describe('When checkout creates the branch HEAD already names', () => {
      it('Then it succeeds and HEAD is unchanged', async () => {
        // Arrange
        const { ctx } = await seedUnborn();
        const before = await headFile(ctx);
        const sut = checkout;

        // Act
        const result = await sut(ctx, { createBranch: { name: 'main' } });

        // Assert
        expect(result.branch).toBe('refs/heads/main');
        expect(await headFile(ctx)).toBe(before);
      });
    });

    describe('When an index.lock is held', () => {
      it('Then it succeeds without touching the lock', async () => {
        // Arrange
        const { ctx } = await seedUnborn();
        const lockPath = `${ctx.layout.gitDir}/index.lock`;
        await ctx.fs.writeUtf8(lockPath, 'held');
        const sut = checkout;

        // Act
        await sut(ctx, { createBranch: { name: 'x' } });

        // Assert
        expect(await readText(ctx, lockPath)).toBe('held');
        expect(await headFile(ctx)).toBe('ref: refs/heads/x\n');
      });
    });

    describe('When the index is garbage', () => {
      it('Then it succeeds and the index stays garbage', async () => {
        // Arrange
        const { ctx } = await seedUnborn();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/index`, 'garbage');
        const sut = checkout;

        // Act
        await sut(ctx, { createBranch: { name: 'x' } });

        // Assert
        expect(await readText(ctx, `${ctx.layout.gitDir}/index`)).toBe('garbage');
        expect(await headFile(ctx)).toBe('ref: refs/heads/x\n');
      });
    });

    describe('When a MERGE_MSG exists', () => {
      it('Then it is kept', async () => {
        // Arrange
        const { ctx } = await seedUnborn();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_MSG`, 'm\n');
        const sut = checkout;

        // Act
        await sut(ctx, { createBranch: { name: 'x' } });

        // Assert
        expect(await readText(ctx, `${ctx.layout.gitDir}/MERGE_MSG`)).toBe('m\n');
      });
    });

    describe('When HEAD.lock is held', () => {
      it('Then it refuses REF_LOCKED and HEAD stays', async () => {
        // Arrange
        const { ctx } = await seedUnborn();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD.lock`, 'held');
        const before = await headFile(ctx);
        const sut = checkout;

        // Act
        const result = await dataOf(() => sut(ctx, { createBranch: { name: 'x' } }));

        // Assert
        expect(result).toMatchObject({ code: 'REF_LOCKED', name: 'HEAD' });
        expect(await headFile(ctx)).toBe(before);
      });
    });

    describe.each([
      ['no options', {}],
      ['detach', { detach: true }],
    ])('When checkout is called with %s', (_title, opts) => {
      it('Then it refuses NO_INITIAL_COMMIT with HEAD and index unchanged', async () => {
        // Arrange
        const { ctx } = await seedUnborn();
        const headBefore = await headFile(ctx);
        const indexBefore = await indexFile(ctx);
        const sut = checkout;

        // Act
        const result = await dataOf(() => sut(ctx, opts));

        // Assert
        expect(result).toEqual({ code: 'NO_INITIAL_COMMIT' });
        expect(await headFile(ctx)).toBe(headBefore);
        expect(await indexFile(ctx)).toEqual(indexBefore);
      });
    });
  });

  describe('Given an unborn HEAD and an orphan o with main committed', () => {
    describe('When checkout creates main with no start point', () => {
      it('Then it refuses BRANCH_EXISTS and HEAD stays', async () => {
        // Arrange
        const { ctx } = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/o\n');
        const sut = checkout;

        // Act
        const result = await dataOf(() => sut(ctx, { createBranch: { name: 'main' } }));

        // Assert
        expect(result).toEqual({ code: 'BRANCH_EXISTS', name: 'refs/heads/main' });
        expect(await headFile(ctx)).toBe('ref: refs/heads/o\n');
      });
    });
  });
});

const T0 = 1_700_000_000_000;
const LATER_MS = 10_000;

afterEach(() => {
  vi.useRealTimers();
});

const entryA = async (ctx: Context): Promise<IndexEntry> => {
  const found = (await readIndex(ctx)).entries.find((e) => e.path === 'a.txt');
  if (found === undefined) throw new Error('a.txt is not tracked');
  return found;
};

/** The work file is touched after the index was written, so a refreshing write would re-stat it. */
const seedTouched = async (): Promise<Context> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const { ctx } = await seed();
  vi.setSystemTime(T0 + LATER_MS);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'B');
  vi.setSystemTime(T0 + 2 * LATER_MS);
  return ctx;
};

const markUnmerged = async (ctx: Context): Promise<void> => {
  const index = await readIndex(ctx);
  const [staged] = index.entries;
  if (staged === undefined) throw new Error('nothing staged');
  const conflict = (stage: 1 | 2 | 3): IndexEntry => ({
    ...staged,
    path: 'n' as FilePath,
    flags: { ...staged.flags, stage },
  });
  const lock = await acquireIndexLock(ctx);
  await lock.commit([...index.entries, conflict(1), conflict(2), conflict(3)], 'replace');
  await lock.release();
};

const stagesOf = async (ctx: Context): Promise<ReadonlyArray<number>> =>
  (await readIndex(ctx)).entries.filter((e) => e.path === 'n').map((e) => e.flags.stage);

describe('checkout createBranch that stays on the current commit', () => {
  describe('Given a repository on main with a touched tracked file', () => {
    describe('When checkout creates a branch with no start point', () => {
      it('Then the index file is not rewritten and HEAD attaches to the branch', async () => {
        // Arrange
        const ctx = await seedTouched();
        const before = await entryA(ctx);
        const sut = checkout;

        // Act
        const result = await sut(ctx, { createBranch: { name: 'x' } });

        // Assert
        const after = await entryA(ctx);
        expect(after.mtimeSeconds).toBe(before.mtimeSeconds);
        expect(result).toMatchObject({ branch: 'refs/heads/x', detached: false, changedPaths: 0 });
        expect(await readText(ctx, `${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/x\n');
      });
    });

    describe.each([
      ['an explicit HEAD start point', { rev: 'HEAD', createBranch: { name: 'x' } }],
      ['noTrack', { createBranch: { name: 'x', noTrack: true } }],
      ['force', { force: true, createBranch: { name: 'x' } }],
      ['detach', { detach: true, rev: 'main' }],
      ['a plain rev', { rev: 'main' }],
    ] as const)('When checkout runs with %s', (_label, opts) => {
      it('Then the index is rewritten', async () => {
        // Arrange
        const ctx = await seedTouched();
        const before = await entryA(ctx);
        const sut = checkout;

        // Act
        await sut(ctx, opts);

        // Assert
        expect((await entryA(ctx)).mtimeSeconds).toBeGreaterThan(before.mtimeSeconds);
      });
    });
  });

  describe('Given an unmerged index', () => {
    describe('When checkout creates a branch with no start point', () => {
      it('Then HEAD moves to it and every stage stays', async () => {
        // Arrange
        const { ctx } = await seed();
        await markUnmerged(ctx);
        const sut = checkout;

        // Act
        await sut(ctx, { createBranch: { name: 'x' } });

        // Assert
        expect(await readText(ctx, `${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/x\n');
        expect(await stagesOf(ctx)).toEqual([1, 2, 3]);
      });
    });

    describe('When checkout creates a branch at an explicit HEAD', () => {
      it('Then it still refuses and HEAD stays', async () => {
        // Arrange
        const { ctx } = await seed();
        await markUnmerged(ctx);
        const sut = checkout;

        // Act
        const outcome = await sut(ctx, { rev: 'HEAD', createBranch: { name: 'x' } }).then(
          () => undefined,
          (error: TsgitError) => error,
        );

        // Assert
        expect(outcome).toBeDefined();
        expect(await readText(ctx, `${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/main\n');
      });
    });
  });
});
