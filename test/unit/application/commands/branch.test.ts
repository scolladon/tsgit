import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branch } from '../../../../src/application/commands/branch.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
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
  it('Given a repo with main + one commit, When branch list, Then returns main as current', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();

    // Act
    const sut = await branch(ctx, { kind: 'list' });

    // Assert
    if (sut.kind !== 'list') throw new Error('expected list');
    expect(sut.branches.map((b) => b.name)).toContain('refs/heads/main');
    expect(sut.branches.find((b) => b.name === 'refs/heads/main')?.current).toBe(true);
  });

  it('Given a fresh branch name, When branch create, Then refs/heads/<name> exists', async () => {
    // Arrange
    const { ctx, commitId } = await seedWithCommit();

    // Act
    const sut = await branch(ctx, { kind: 'create', name: 'feature' });

    // Assert
    if (sut.kind !== 'create') throw new Error('expected create');
    expect(sut.id).toBe(commitId);
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/feature`)).toBe(true);
  });

  it('Given an existing branch name, When branch create without force, Then throws BRANCH_EXISTS', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();
    await branch(ctx, { kind: 'create', name: 'feature' });

    // Act
    await expectError(() => branch(ctx, { kind: 'create', name: 'feature' }), 'BRANCH_EXISTS');
  });

  it('Given a branch other than the current, When branch delete, Then it is removed', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();
    await branch(ctx, { kind: 'create', name: 'feature' });

    // Act
    await branch(ctx, { kind: 'delete', name: 'feature' });

    // Assert
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/feature`)).toBe(false);
  });

  it('Given the current branch, When branch delete, Then throws CANNOT_DELETE_CHECKED_OUT_BRANCH', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();

    // Act
    await expectError(
      () => branch(ctx, { kind: 'delete', name: 'main' }),
      'CANNOT_DELETE_CHECKED_OUT_BRANCH',
    );
  });

  it('Given a non-existent branch, When branch delete, Then throws BRANCH_NOT_FOUND', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();

    // Act
    await expectError(() => branch(ctx, { kind: 'delete', name: 'ghost' }), 'BRANCH_NOT_FOUND');
  });

  it('Given a branch, When branch rename, Then old gone + new exists, HEAD updated when current', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();

    // Act
    const sut = await branch(ctx, { kind: 'rename', from: 'main', to: 'trunk' });

    // Assert
    if (sut.kind !== 'rename') throw new Error('expected rename');
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/main`)).toBe(false);
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/trunk`)).toBe(true);
    const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
    expect(head).toBe('ref: refs/heads/trunk\n');
  });

  it('Given a non-current branch, When branch rename, Then HEAD is unchanged (only the renamed-current branch updates HEAD)', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();
    await branch(ctx, { kind: 'create', name: 'other' });

    // Act
    await branch(ctx, { kind: 'rename', from: 'other', to: 'renamed' });

    // Assert
    const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
    expect(head).toBe('ref: refs/heads/main\n');
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/renamed`)).toBe(true);
  });

  it('Given an existing branch + force=true, When branch create, Then it overwrites without throwing', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();
    await branch(ctx, { kind: 'create', name: 'feature' });

    // Act + Assert — must not throw with force.
    const sut = await branch(ctx, { kind: 'create', name: 'feature', force: true });
    if (sut.kind !== 'create') throw new Error('expected create');
    expect(sut.name).toBe('refs/heads/feature');
  });

  it('Given an explicit startPoint (oid), When branch create, Then the new ref points at that oid', async () => {
    // Arrange
    const { ctx, commitId } = await seedWithCommit();

    // Act
    const sut = await branch(ctx, { kind: 'create', name: 'pin', startPoint: commitId });

    // Assert
    if (sut.kind !== 'create') throw new Error('expected create');
    expect(sut.id).toBe(commitId);
  });

  it('Given an explicit startPoint as a branch name, When branch create, Then resolves and pins to that branch tip', async () => {
    // Arrange
    const { ctx, commitId } = await seedWithCommit();
    await branch(ctx, { kind: 'create', name: 'feature' });

    // Act
    const sut = await branch(ctx, { kind: 'create', name: 'pin', startPoint: 'feature' });

    // Assert
    if (sut.kind !== 'create') throw new Error('expected create');
    expect(sut.id).toBe(commitId);
  });

  it('Given an unresolvable startPoint, When branch create, Then throws BRANCH_NOT_FOUND', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();

    // Act
    await expectError(
      () => branch(ctx, { kind: 'create', name: 'pin', startPoint: 'no-such' }),
      'BRANCH_NOT_FOUND',
    );
  });

  it('Given branch list on a repo with no refs/heads dir, When branch list, Then returns an empty array', async () => {
    // Arrange — fresh ctx, no init.
    const ctx = createMemoryContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

    // Act
    const sut = await branch(ctx, { kind: 'list' });

    // Assert
    if (sut.kind !== 'list') throw new Error('expected list');
    expect(sut.branches).toEqual([]);
  });

  it('Given an existing target branch + force=true, When branch rename, Then force overrides the BRANCH_EXISTS guard', async () => {
    // Arrange — kills `force === true ? {} : { expected: 'absent' }` mutants on rename.
    const { ctx } = await seedWithCommit();
    await branch(ctx, { kind: 'create', name: 'a' });
    await branch(ctx, { kind: 'create', name: 'b' });

    // Act + Assert — without force this would BRANCH_EXISTS; with force it succeeds.
    await branch(ctx, { kind: 'rename', from: 'a', to: 'b', force: true });
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/a`)).toBe(false);
  });

  it('Given an existing target branch + force=false, When branch rename, Then throws BRANCH_EXISTS', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();
    await branch(ctx, { kind: 'create', name: 'a' });
    await branch(ctx, { kind: 'create', name: 'b' });

    // Act
    await expectError(() => branch(ctx, { kind: 'rename', from: 'a', to: 'b' }), 'BRANCH_EXISTS');
  });

  it('Given refs/heads holding a sub-directory + a file, When branch list, Then directory entries are skipped', async () => {
    // Arrange — `nested/leaf` creates a `nested` DIRECTORY entry under refs/heads;
    // resolveRef on that directory would throw if the `!entry.isFile` skip is removed.
    const { ctx } = await seedWithCommit();
    await branch(ctx, { kind: 'create', name: 'nested/leaf' });

    // Act
    const sut = await branch(ctx, { kind: 'list' });

    // Assert
    if (sut.kind !== 'list') throw new Error('expected list');
    expect(sut.branches.map((b) => b.name)).toEqual(['refs/heads/main']);
  });

  it('Given a non-current branch in the list, When branch list, Then that branch is current=false', async () => {
    // Arrange — kills `name === currentTarget -> true` (every branch flagged current).
    const { ctx } = await seedWithCommit();
    await branch(ctx, { kind: 'create', name: 'feature' });

    // Act
    const sut = await branch(ctx, { kind: 'list' });

    // Assert
    if (sut.kind !== 'list') throw new Error('expected list');
    expect(sut.branches.find((b) => b.name === 'refs/heads/feature')?.current).toBe(false);
  });

  it('Given branches created out of order, When branch list, Then branches are sorted ascending by name', async () => {
    // Arrange — exercises the `branches.sort` comparator (NoCoverage line).
    const { ctx } = await seedWithCommit();
    await branch(ctx, { kind: 'create', name: 'zeta' });
    await branch(ctx, { kind: 'create', name: 'alpha' });

    // Act
    const sut = await branch(ctx, { kind: 'list' });

    // Assert — alpha < main < zeta; insertion order was zeta, main, alpha.
    if (sut.kind !== 'list') throw new Error('expected list');
    expect(sut.branches.map((b) => b.name)).toEqual([
      'refs/heads/alpha',
      'refs/heads/main',
      'refs/heads/zeta',
    ]);
  });

  it('Given updateRef throws a non-TsgitError, When branch create, Then that exact error propagates unchanged', async () => {
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
      await branch(failingCtx, { kind: 'create', name: 'feature' });
    } catch (err) {
      caught = err;
    }

    // Assert — same instance, not wrapped, not a TsgitError-coded error.
    expect(caught).toBe(boom);
    expect(caught).not.toBeInstanceOf(TsgitError);
  });

  it('Given updateRef throws a non-conflict TsgitError, When branch create, Then it propagates as-is (not BRANCH_EXISTS)', async () => {
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
      () => branch(failingCtx, { kind: 'create', name: 'feature' }),
      'NETWORK_ERROR',
    );

    // Assert — original error, not remapped to BRANCH_EXISTS.
    expect(err).toBe(boom);
  });

  it('Given updateRef throws a non-TsgitError, When branch rename, Then that exact error propagates unchanged', async () => {
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
      await branch(failingCtx, { kind: 'rename', from: 'main', to: 'trunk' });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBe(boom);
    expect(caught).not.toBeInstanceOf(TsgitError);
  });

  it('Given updateRef throws a non-conflict TsgitError, When branch rename, Then it propagates as-is (not BRANCH_EXISTS)', async () => {
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
      () => branch(failingCtx, { kind: 'rename', from: 'main', to: 'trunk' }),
      'NETWORK_ERROR',
    );

    // Assert
    expect(err).toBe(boom);
  });

  it('Given a startPoint of 40 hex chars with a trailing extra char, When branch create, Then it is not treated as an oid', async () => {
    // Arrange — kills the `$` anchor of the oid regex; the value is not a real oid
    // and resolves as a ref name instead -> BRANCH_NOT_FOUND.
    const { ctx, commitId } = await seedWithCommit();

    // Act
    await expectError(
      () => branch(ctx, { kind: 'create', name: 'pin', startPoint: `${commitId}f` }),
      'BRANCH_NOT_FOUND',
    );
  });

  it('Given a startPoint of 40 hex chars with a leading extra char, When branch create, Then it is not treated as an oid', async () => {
    // Arrange — kills the `^` anchor of the oid regex.
    const { ctx, commitId } = await seedWithCommit();

    // Act
    await expectError(
      () => branch(ctx, { kind: 'create', name: 'pin', startPoint: `f${commitId}` }),
      'BRANCH_NOT_FOUND',
    );
  });

  it('Given a branch literally named HEAD pointing elsewhere, When branch create with default startPoint, Then it resolves the HEAD symref not refs/heads/HEAD', async () => {
    // Arrange — kills `startPoint === 'HEAD'` and its 'HEAD' string literal:
    // if candidates became [refs/heads/HEAD, HEAD], the wrong (older) commit would win.
    const { ctx, commitId: first } = await seedWithCommit();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'updated');
    await add(ctx, ['a.txt']);
    const second = await commit(ctx, { message: 'second', author });
    expect(second.id).not.toBe(first);
    await branch(ctx, { kind: 'create', name: 'HEAD', startPoint: first });

    // Act — default startPoint ('HEAD') must resolve the symbolic HEAD -> second.
    const sut = await branch(ctx, { kind: 'create', name: 'probe' });

    // Assert
    if (sut.kind !== 'create') throw new Error('expected create');
    expect(sut.id).toBe(second.id);
  });
});
