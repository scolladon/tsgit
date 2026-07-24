import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import {
  branchCreate,
  branchDelete,
  branchList,
  branchRename,
  compareRefName,
} from '../../../../src/application/commands/branch.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { readReflog, reflogExists } from '../../../../src/application/primitives/reflog-store.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedWithCommit = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c = await commit(ctx, { message: 'first', author });
  return { ctx, commitId: c.id };
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

describe('branch', () => {
  describe('Given a repo with main + one commit', () => {
    describe('When branch list', () => {
      it('Then returns main as current', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act
        const sut = await branchList(ctx);

        // Assert
        expect(sut.branches.map((b) => b.name)).toContain('refs/heads/main');
        expect(sut.branches.find((b) => b.name === 'refs/heads/main')?.current).toBe(true);
      });
    });
  });

  describe('Given a fresh branch name', () => {
    describe('When branch create', () => {
      it('Then refs/heads/<name> exists', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const sut = await branchCreate(ctx, { name: 'feature' });

        // Assert
        expect(sut.id).toBe(commitId);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/feature`)).toBe(true);
      });
    });
  });

  describe('Given an existing branch name', () => {
    describe('When branch create without force', () => {
      it('Then throws BRANCH_EXISTS', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'feature' });

        // Assert
        await expectError(() => branchCreate(ctx, { name: 'feature' }), 'BRANCH_EXISTS');
      });
    });
  });

  describe('Given a branch other than the current', () => {
    describe('When branch delete', () => {
      it('Then it is removed', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'feature' });

        // Act
        await branchDelete(ctx, { name: 'feature' });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/feature`)).toBe(false);
      });
    });
  });

  describe('Given the current branch', () => {
    describe('When branch delete', () => {
      it('Then throws CANNOT_DELETE_CHECKED_OUT_BRANCH', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Assert
        await expectError(
          () => branchDelete(ctx, { name: 'main' }),
          'CANNOT_DELETE_CHECKED_OUT_BRANCH',
        );
      });
    });
  });

  describe('Given a non-existent branch', () => {
    describe('When branch delete', () => {
      it('Then throws BRANCH_NOT_FOUND', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Assert
        await expectError(() => branchDelete(ctx, { name: 'ghost' }), 'BRANCH_NOT_FOUND');
      });
    });
  });

  describe('Given a branch', () => {
    describe('When branch rename', () => {
      it('Then old gone + new exists, HEAD updated when current', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act
        const sut = await branchRename(ctx, { from: 'main', to: 'trunk' });

        // Assert
        expect(sut).toEqual({ from: 'refs/heads/main', to: 'refs/heads/trunk' });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/main`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/trunk`)).toBe(true);
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(head).toBe('ref: refs/heads/trunk\n');
      });
    });
  });

  describe('Given a branch with reflog history', () => {
    describe('When branch rename', () => {
      it('Then the new ref reflog is [...source-history, rename-entry] and the source reflog is gone', async () => {
        // Arrange — the seed commit logs one entry to refs/heads/main's reflog.
        const { ctx } = await seedWithCommit();
        const before = await readReflog(ctx, 'refs/heads/main' as RefName);
        expect(before).toHaveLength(1);

        // Act
        await branchRename(ctx, { from: 'main', to: 'trunk' });

        // Assert — the moved history precedes the rename entry on the new ref,
        // and the source reflog file no longer exists.
        const movedLog = await readReflog(ctx, 'refs/heads/trunk' as RefName);
        expect(movedLog).toHaveLength(2);
        expect(movedLog[0]).toEqual(before[0]);
        expect(movedLog[1]?.message).toBe('branch: renamed refs/heads/main to refs/heads/trunk');
        expect(await reflogExists(ctx, 'refs/heads/main' as RefName)).toBe(false);
      });
    });
  });

  describe('Given a source branch with no reflog', () => {
    describe('When branch rename', () => {
      it('Then the renamed branch gets no empty reflog file', async () => {
        // Arrange — logging is off before the seed commit, so refs/heads/main has
        // no reflog. The rename must not write an (empty) reflog for the target:
        // the moved-history write is guarded on a non-empty source log.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n  logallrefupdates = false\n',
        );
        __resetConfigCacheForTests();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        expect(await reflogExists(ctx, 'refs/heads/main' as RefName)).toBe(false);

        // Act
        await branchRename(ctx, { from: 'main', to: 'trunk' });

        // Assert — no source history to move, so the target has no reflog file.
        expect(await reflogExists(ctx, 'refs/heads/trunk' as RefName)).toBe(false);
        __resetConfigCacheForTests();
      });
    });
  });

  describe('Given a non-current branch', () => {
    describe('When branch rename', () => {
      it('Then HEAD is unchanged (only the renamed-current branch updates HEAD)', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'other' });

        // Act
        await branchRename(ctx, { from: 'other', to: 'renamed' });

        // Assert
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(head).toBe('ref: refs/heads/main\n');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/renamed`)).toBe(true);
      });
    });
  });

  describe('Given an existing branch + force=true', () => {
    describe('When branch create', () => {
      it('Then it overwrites without throwing', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'feature' });

        // Act + Assert — must not throw with force.
        const sut = await branchCreate(ctx, { name: 'feature', force: true });
        // Assert
        expect(sut.name).toBe('refs/heads/feature');
      });
    });
  });

  describe('Given an explicit startPoint (oid)', () => {
    describe('When branch create', () => {
      it('Then the new ref points at that oid', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const sut = await branchCreate(ctx, { name: 'pin', startPoint: commitId });

        // Assert
        expect(sut.id).toBe(commitId);
      });
    });
  });

  describe('Given an explicit startPoint as a branch name', () => {
    describe('When branch create', () => {
      it('Then resolves and pins to that branch tip', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        await branchCreate(ctx, { name: 'feature' });

        // Act
        const sut = await branchCreate(ctx, { name: 'pin', startPoint: 'feature' });

        // Assert
        expect(sut.id).toBe(commitId);
      });
    });
  });

  describe('Given branch list on a repo with no refs/heads dir', () => {
    describe('When branch list', () => {
      it('Then returns an empty array', async () => {
        // Arrange — fresh ctx, no init.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const sut = await branchList(ctx);

        // Assert
        expect(sut.branches).toEqual([]);
      });
    });
  });

  describe('Given an existing target branch + force=true', () => {
    describe('When branch rename', () => {
      it('Then force overrides the BRANCH_EXISTS guard', async () => {
        // Arrange — kills `force === true ? {} : { expected: 'absent' }` mutants on rename.
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'a' });
        await branchCreate(ctx, { name: 'b' });

        // Act + Assert — without force this would BRANCH_EXISTS; with force it succeeds.
        await branchRename(ctx, { from: 'a', to: 'b', force: true });
        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/a`)).toBe(false);
      });
    });
  });

  describe('Given an existing target branch + force=false', () => {
    describe('When branch rename', () => {
      it('Then throws BRANCH_EXISTS', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'a' });
        await branchCreate(ctx, { name: 'b' });

        // Assert
        await expectError(() => branchRename(ctx, { from: 'a', to: 'b' }), 'BRANCH_EXISTS');
      });
    });
  });

  describe('Given refs/heads holding a sub-directory + a file', () => {
    describe('When branch list', () => {
      it('Then directory entries are skipped', async () => {
        // Arrange — `nested/leaf` creates a `nested` DIRECTORY entry under refs/heads;
        // resolveRef on that directory would throw if the `!entry.isFile` skip is removed.
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'nested/leaf' });

        // Act
        const sut = await branchList(ctx);

        // Assert
        expect(sut.branches.map((b) => b.name)).toEqual(['refs/heads/main']);
      });
    });
  });

  describe('Given a non-current branch in the list', () => {
    describe('When branch list', () => {
      it('Then that branch is current=false', async () => {
        // Arrange — kills `name === currentTarget -> true` (every branch flagged current).
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'feature' });

        // Act
        const sut = await branchList(ctx);

        // Assert
        expect(sut.branches.find((b) => b.name === 'refs/heads/feature')?.current).toBe(false);
      });
    });
  });

  describe('Given branches created out of order', () => {
    describe('When branch list', () => {
      it('Then branches are sorted ascending by name', async () => {
        // Arrange — readdir yields entries by name, so the comparator's input is
        // already ['main','xray','beta'] in name order? No: memory-fs readdir
        // returns insertion order. Seeding xray then beta after the default `main`
        // gives walk order [main, xray, beta] — distinct from BOTH the sorted
        // result [beta, main, xray] AND its reverse [xray, main, beta]. A
        // comparator mutated to a constant -1 (reverse) or 1 (identity) therefore
        // produces a provably wrong order, killing both ConditionalExpression
        // mutants on the comparator.
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'xray' });
        await branchCreate(ctx, { name: 'beta' });

        // Act
        const sut = await branchList(ctx);

        // Assert — ascending: beta < main < xray.
        expect(sut.branches.map((b) => b.name)).toEqual([
          'refs/heads/beta',
          'refs/heads/main',
          'refs/heads/xray',
        ]);
      });
    });
  });

  describe('Given updateRef throws a non-TsgitError', () => {
    describe('When branch create', () => {
      it('Then that exact error propagates unchanged', async () => {
        // Arrange — kills the `err instanceof TsgitError` operand on createBranch.
        const { ctx } = await seedWithCommit();
        const boom = new Error('disk gone');
        const failingCtx: Context = {
          ...ctx,
          fs: new Proxy(ctx.fs, {
            get(target, prop, receiver) {
              if (prop === 'writeExclusive') return () => Promise.reject(boom);
              return Reflect.get(target, prop, receiver);
            },
          }),
        };

        // Act
        let caught: unknown;
        try {
          await branchCreate(failingCtx, { name: 'feature' });
        } catch (err) {
          caught = err;
        }

        // Assert — same instance, not wrapped, not a TsgitError-coded error.
        expect(caught).toBe(boom);
        expect(caught).not.toBeInstanceOf(TsgitError);
      });
    });
  });

  describe('Given updateRef throws a non-conflict TsgitError', () => {
    describe('When branch create', () => {
      it('Then it propagates as-is (not BRANCH_EXISTS)', async () => {
        // Arrange — kills the `code === REF_UPDATE_CONFLICT` operand on createBranch.
        const { ctx } = await seedWithCommit();
        const boom = new TsgitError({ code: 'NETWORK_ERROR', reason: 'transient' });
        const failingCtx: Context = {
          ...ctx,
          fs: new Proxy(ctx.fs, {
            get(target, prop, receiver) {
              if (prop === 'writeExclusive') return () => Promise.reject(boom);
              return Reflect.get(target, prop, receiver);
            },
          }),
        };

        // Act
        const err = await expectError(
          () => branchCreate(failingCtx, { name: 'feature' }),
          'NETWORK_ERROR',
        );

        // Assert — original error, not remapped to BRANCH_EXISTS.
        expect(err).toBe(boom);
      });
    });
  });

  describe('Given updateRef throws a non-TsgitError', () => {
    describe('When branch rename', () => {
      it('Then that exact error propagates unchanged', async () => {
        // Arrange — kills the `err instanceof TsgitError` operand on renameBranch.
        const { ctx } = await seedWithCommit();
        const boom = new Error('disk gone');
        const failingCtx: Context = {
          ...ctx,
          fs: new Proxy(ctx.fs, {
            get(target, prop, receiver) {
              if (prop === 'writeExclusive') return () => Promise.reject(boom);
              return Reflect.get(target, prop, receiver);
            },
          }),
        };

        // Act
        let caught: unknown;
        try {
          await branchRename(failingCtx, { from: 'main', to: 'trunk' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(boom);
        expect(caught).not.toBeInstanceOf(TsgitError);
      });
    });
  });

  describe('Given updateRef throws a non-conflict TsgitError', () => {
    describe('When branch rename', () => {
      it('Then it propagates as-is (not BRANCH_EXISTS)', async () => {
        // Arrange — kills the `code === REF_UPDATE_CONFLICT` operand on renameBranch.
        const { ctx } = await seedWithCommit();
        const boom = new TsgitError({ code: 'NETWORK_ERROR', reason: 'transient' });
        const failingCtx: Context = {
          ...ctx,
          fs: new Proxy(ctx.fs, {
            get(target, prop, receiver) {
              if (prop === 'writeExclusive') return () => Promise.reject(boom);
              return Reflect.get(target, prop, receiver);
            },
          }),
        };

        // Act
        const err = await expectError(
          () => branchRename(failingCtx, { from: 'main', to: 'trunk' }),
          'NETWORK_ERROR',
        );

        // Assert
        expect(err).toBe(boom);
      });
    });
  });

  describe('Given a startPoint that does not resolve to a commit', () => {
    describe('When branch create runs', () => {
      it.each([
        {
          label: 'an unresolvable ref name',
          buildStartPoint: (): string => 'no-such',
        },
        {
          label: '40 hex chars with a trailing extra char',
          buildStartPoint: (commitId: string): string => `${commitId}f`,
        },
        {
          label: '40 hex chars with a leading extra char',
          buildStartPoint: (commitId: string): string => `f${commitId}`,
        },
      ])('Then $label throws BRANCH_NOT_FOUND', async ({ buildStartPoint }) => {
        // Arrange — the trailing/leading extra char breaks the oid regex's `$`/`^`
        // anchor, so the value resolves as a ref name instead of an oid.
        const { ctx, commitId } = await seedWithCommit();
        const startPoint = buildStartPoint(commitId);
        let caught: unknown;

        // Act
        try {
          await branchCreate(ctx, { name: 'pin', startPoint });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('BRANCH_NOT_FOUND');
      });
    });
  });

  describe('Given two ref names to compare', () => {
    describe('When compareRefName runs', () => {
      it.each([
        {
          label: 'left lexically before right',
          left: 'refs/heads/alpha',
          right: 'refs/heads/beta',
          expected: -1,
        },
        {
          label: 'left lexically after right',
          left: 'refs/heads/zeta',
          right: 'refs/heads/main',
          expected: 1,
        },
        {
          label: 'equal ref names (unreachable via listBranches, whose dir entries are unique)',
          left: 'refs/heads/main',
          right: 'refs/heads/main',
          expected: 0,
        },
      ])('Then $label returns exactly $expected', ({ left, right, expected }) => {
        // Arrange — kills the `<`/`>` relational-operator mutants (`< -> >=`,
        // `> -> <=`, `<-><=`, `>->>=`) and the `if (lower)`/`if (higher)`
        // ConditionalExpression boolean-literal mutants on each branch.
        const l = left as RefName;
        const r = right as RefName;

        // Act
        const sut = compareRefName(l, r);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });

  describe('Given a branch literally named HEAD pointing elsewhere', () => {
    describe('When branch create with default startPoint', () => {
      it('Then it resolves the HEAD symref not refs/heads/HEAD', async () => {
        // Arrange — kills `startPoint === 'HEAD'` and its 'HEAD' string literal:
        // if candidates became [refs/heads/HEAD, HEAD], the wrong (older) commit would win.
        const { ctx, commitId: first } = await seedWithCommit();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'updated');
        await add(ctx, ['a.txt']);
        const second = await commit(ctx, { message: 'second', author });
        expect(second.id).not.toBe(first);
        await branchCreate(ctx, { name: 'HEAD', startPoint: first });

        // Act — default startPoint ('HEAD') must resolve the symbolic HEAD -> second.
        const sut = await branchCreate(ctx, { name: 'probe' });

        // Assert
        expect(sut.id).toBe(second.id);
      });
    });
  });
});
