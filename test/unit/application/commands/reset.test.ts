import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { reset } from '../../../../src/application/commands/reset.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedTwoCommits = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c1 = await commit(ctx, { message: 'first', author });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
  await add(ctx, ['b.txt']);
  const c2 = await commit(ctx, { message: 'second', author });
  return { ctx, c1: c1.id, c2: c2.id };
};

describe('reset', () => {
  it('Given a soft reset to HEAD~1 (parent), When reset, Then current branch points at parent', async () => {
    // Arrange
    const { ctx, c1, c2 } = await seedTwoCommits();

    // Act
    const sut = await reset(ctx, { mode: 'soft', target: c1 });

    // Assert
    expect(sut.id).toBe(c1);
    expect(sut.branch).toBe('refs/heads/main');
    const ref = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`);
    expect(ref.trim()).toBe(c1);
    expect(c2).not.toBe(c1);
  });

  it('Given mixed mode and target oid, When reset, Then HEAD branch updated', async () => {
    const { ctx, c1 } = await seedTwoCommits();
    const sut = await reset(ctx, { mode: 'mixed', target: c1 });
    expect(sut.mode).toBe('mixed');
    expect(sut.id).toBe(c1);
  });

  it('Given hard mode and target oid, When reset, Then result.mode=hard and HEAD branch updated', async () => {
    const { ctx, c1 } = await seedTwoCommits();
    const sut = await reset(ctx, { mode: 'hard', target: c1 });
    expect(sut.mode).toBe('hard');
    expect(sut.id).toBe(c1);
  });

  it('Given an unresolvable target, When reset, Then throws REVPARSE_UNRESOLVED', async () => {
    const { ctx } = await seedTwoCommits();
    let caught: unknown;
    try {
      await reset(ctx, { mode: 'soft', target: 'no-such-ref' });
    } catch (err) {
      caught = err;
    }
    expect((caught as { data?: { code?: string } })?.data?.code).toBe('REVPARSE_UNRESOLVED');
  });

  it('Given target as a branch name, When reset, Then resolves via refs/heads/<name>', async () => {
    const { ctx, c2 } = await seedTwoCommits();
    const sut = await reset(ctx, { mode: 'soft', target: 'main' });
    // Pin to the exact resolved oid so a mutation to the candidate list (e.g.
    // dropping the `refs/heads/${target}` prefix) is caught.
    expect(sut.id).toBe(c2);
  });

  it('Given target as HEAD, When reset, Then no-op (HEAD already points there)', async () => {
    const { ctx, c2 } = await seedTwoCommits();
    const sut = await reset(ctx, { mode: 'soft', target: 'HEAD' });
    expect(sut.id).toBe(c2);
  });

  it('Given a soft reset to parent, When reset, Then index is NOT rebuilt (b.txt still staged)', async () => {
    // Arrange — soft mode must not call rebuildIndexFromCommit. After resetting
    // soft to c1, the index must still reflect the c2 state (a.txt + b.txt).
    const { ctx, c1 } = await seedTwoCommits();

    // Act
    await reset(ctx, { mode: 'soft', target: c1 });

    // Assert
    const index = await readIndex(ctx);
    const paths = index.entries.filter((e) => e.flags.stage === 0).map((e) => e.path);
    expect(paths).toEqual(['a.txt', 'b.txt']);
  });

  it('Given a mixed reset target that resolves to a non-commit object, When reset, Then throws UNEXPECTED_OBJECT_TYPE expected=commit', async () => {
    // Arrange — write a standalone blob and pass its oid as `target`. The mixed
    // path will resolve it to a non-commit object and must reject.
    const { ctx } = await seedTwoCommits();
    const { writeObject } = await import('../../../../src/application/primitives/write-object.js');
    const blobId = await writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode('not-a-commit'),
      id: '' as ObjectId,
    });

    // Act
    let caught: unknown;
    try {
      await reset(ctx, { mode: 'mixed', target: blobId });
    } catch (err) {
      caught = err;
    }

    // Assert
    const data = (caught as { data?: { code?: string; expected?: string } })?.data;
    expect(data?.code).toBe('UNEXPECTED_OBJECT_TYPE');
    expect(data?.expected).toBe('commit');
  });

  it('Given a mixed reset to parent, When reset, Then index equals parent tree (later-commit entry dropped)', async () => {
    // Arrange — commit-2 adds b.txt; resetting --mixed to commit-1 must drop b.txt from the index.
    const { ctx, c1 } = await seedTwoCommits();

    // Act
    const sut = await reset(ctx, { mode: 'mixed', target: c1 });

    // Assert
    expect(sut.id).toBe(c1);
    const index = await readIndex(ctx);
    const paths = index.entries.filter((e) => e.flags.stage === 0).map((e) => e.path);
    expect(paths).toEqual(['a.txt']);
  });

  it('Given a mixed reset to parent, When reset, Then working tree is untouched', async () => {
    // Arrange
    const { ctx, c1 } = await seedTwoCommits();

    // Act
    await reset(ctx, { mode: 'mixed', target: c1 });

    // Assert — both files still present on disk; only the index changed.
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(true);
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/b.txt`)).toBe(true);
  });

  it('Given a mixed reset to current HEAD, When reset, Then stat-cache donor preserves mtime for unchanged paths', async () => {
    // Arrange — capture pre-reset stat fields for a.txt.
    const { ctx, c2 } = await seedTwoCommits();
    const before = await readIndex(ctx);
    const beforeA = before.entries.find((e) => e.path === 'a.txt');
    expect(beforeA?.mtimeSeconds).toBeGreaterThan(0); // sanity: add() recorded an mtime

    // Act
    await reset(ctx, { mode: 'mixed', target: c2 });

    // Assert — after reset to the same HEAD, donor entry's stat fields survive.
    const after = await readIndex(ctx);
    const afterA = after.entries.find((e) => e.path === 'a.txt');
    expect(afterA?.mtimeSeconds).toBe(beforeA?.mtimeSeconds);
    expect(afterA?.mtimeNanoseconds).toBe(beforeA?.mtimeNanoseconds);
    expect(afterA?.fileSize).toBe(beforeA?.fileSize);
    expect(afterA?.id).toBe(beforeA?.id);
  });

  it('Given a mixed reset to parent, When reset, Then changed path gets fresh zero stats', async () => {
    // Arrange — commit-2 modifies a.txt to new content (which changes its blob id).
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'v1');
    await add(ctx, ['a.txt']);
    const c1 = await commit(ctx, { message: 'v1', author });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'v2');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'v2', author });

    // Act — reset --mixed back to v1's commit; a.txt's blob id should revert,
    // and because the donor's id (v2) no longer matches the target tree's id (v1),
    // the donor is rejected and stat fields are zeroed.
    await reset(ctx, { mode: 'mixed', target: c1.id });

    // Assert
    const index = await readIndex(ctx);
    const entry = index.entries.find((e) => e.path === 'a.txt');
    expect(entry?.mtimeSeconds).toBe(0);
    expect(entry?.fileSize).toBe(0);
  });

  it('Given a mixed reset on a bare repo, When reset, Then succeeds (no BARE_REPOSITORY)', async () => {
    // Arrange — bare repo with two commits via a workdir-less ctx.
    // We reuse the seedTwoCommits helper then flip bare to true at config time.
    const { ctx, c1 } = await seedTwoCommits();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

    // Act
    const sut = await reset(ctx, { mode: 'mixed', target: c1 });

    // Assert
    expect(sut.mode).toBe('mixed');
    expect(sut.id).toBe(c1);
  });

  it('Given hard mode on a bare repo, When reset, Then throws BARE_REPOSITORY', async () => {
    // Arrange — fresh ctx with bare config seeded BEFORE any read.
    const ctx = createMemoryContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

    // Act
    let caught: unknown;
    try {
      await reset(ctx, { mode: 'hard', target: 'HEAD' });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as { data?: { code?: string } })?.data?.code).toBe('BARE_REPOSITORY');
  });
});
