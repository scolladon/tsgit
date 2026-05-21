import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import { ObjectId as ObjectIdFactory } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seed = async (workingTree: Readonly<Record<string, string>> = { 'a.txt': 'a' }) => {
  const ctx = createMemoryContext();
  await init(ctx);
  for (const [path, content] of Object.entries(workingTree)) {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
  }
  await add(ctx, Object.keys(workingTree));
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

describe('commit', () => {
  it('Given a staged file + explicit author, When commit, Then returns id and updates HEAD branch', async () => {
    // Arrange
    const ctx = await seed();

    // Act
    const sut = await commit(ctx, { message: 'first', author });

    // Assert
    expect(sut.id).toMatch(/^[0-9a-f]{40}$/);
    expect(sut.parents).toEqual([]);
    expect(sut.branch).toBe('refs/heads/main');
    const refContent = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`);
    expect(refContent.trim()).toBe(sut.id);
  });

  it('Given a second commit with no index changes, When commit (allowEmpty=false), Then throws NOTHING_TO_COMMIT', async () => {
    // Arrange
    const ctx = await seed();
    await commit(ctx, { message: 'first', author });

    // Act
    await expectError(() => commit(ctx, { message: 'second', author }), 'NOTHING_TO_COMMIT');
  });

  it('Given an empty message + allowEmptyMessage=false, When commit, Then throws EMPTY_COMMIT_MESSAGE', async () => {
    const ctx = await seed();
    await expectError(() => commit(ctx, { message: '   \n   ', author }), 'EMPTY_COMMIT_MESSAGE');
  });

  it('Given no author and no config user, When commit, Then throws AUTHOR_UNCONFIGURED', async () => {
    const ctx = await seed();
    await expectError(() => commit(ctx, { message: 'x' }), 'AUTHOR_UNCONFIGURED');
  });

  it('Given a non-repo ctx, When commit, Then throws NOT_A_REPOSITORY', async () => {
    const ctx = createMemoryContext();
    await expectError(() => commit(ctx, { message: 'x', author }), 'NOT_A_REPOSITORY');
  });

  it('Given allowEmpty=true, When commit on unchanged tree, Then succeeds with the same tree', async () => {
    // Arrange
    const ctx = await seed();
    const first = await commit(ctx, { message: 'first', author });

    // Act — same tree, allowEmpty=true means the empty-commit guard is skipped.
    const sut = await commit(ctx, { message: 'second', author, allowEmpty: true });

    // Assert — both commits share the tree but produce distinct ids (different message).
    expect(sut.tree).toBe(first.tree);
    expect(sut.id).not.toBe(first.id);
    expect(sut.parents).toEqual([first.id]);
  });

  it('Given a bare repo, When commit, Then throws BARE_REPOSITORY tagged with operation "commit"', async () => {
    // Arrange — flip core.bare before any config read caches the empty config.
    const ctx = await seed();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');
    __resetConfigCacheForTests();

    // Act
    const err = await expectError(() => commit(ctx, { message: 'x', author }), 'BARE_REPOSITORY');

    // Assert — kills the StringLiteral mutant on assertNotBare(ctx, 'commit').
    expect(err.data).toMatchObject({ code: 'BARE_REPOSITORY', operation: 'commit' });
  });

  it('Given a present but empty MERGE_HEAD marker, When commit, Then throws OPERATION_IN_PROGRESS for merge', async () => {
    // Arrange — empty file: readMergeHead → undefined, yet the marker file
    // still exists, so assertNoPendingOperation must NOT except 'merge'.
    const ctx = await seed();
    await commit(ctx, { message: 'first', author });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, '');

    // Act
    const err = await expectError(
      () => commit(ctx, { message: 'second', author }),
      'OPERATION_IN_PROGRESS',
    );

    // Assert — kills the ConditionalExpression mutant that always excepts 'merge'.
    expect(err.data).toMatchObject({ code: 'OPERATION_IN_PROGRESS', operation: 'merge' });
  });

  it('Given a real merge resolution with an unchanged tree, When commit, Then succeeds as a two-parent commit', async () => {
    // Arrange — first commit, then a populated MERGE_HEAD; the index is unchanged
    // so the tree equals HEAD's tree.
    const ctx = await seed();
    const first = await commit(ctx, { message: 'first', author });
    const mergeHead = ObjectIdFactory.from('1'.repeat(40));
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${mergeHead}\n`);

    // Act — the tree-equality guard must be skipped during a merge resolution.
    const sut = await commit(ctx, { message: 'merge resolved', author });

    // Assert — kills the ConditionalExpression mutant flipping `mergeHead === undefined`
    // to `true` (which would re-enable the guard and throw NOTHING_TO_COMMIT).
    expect(sut.tree).toBe(first.tree);
    expect(sut.parents).toEqual([first.id, mergeHead]);
  });

  it('Given a non-empty user message during a merge resolution, When commit, Then the explicit message wins over MERGE_MSG', async () => {
    // Arrange — both an explicit message and a MERGE_MSG draft are available.
    const ctx = await seed();
    await commit(ctx, { message: 'first', author });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'1'.repeat(40)}\n`);
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_MSG`, 'draft from merge');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'changed');
    await add(ctx, ['a.txt']);

    // Act
    const sut = await commit(ctx, { message: 'explicit message', author });

    // Assert — kills the LogicalOperator mutant (`||` → `&&`) in resolveCommitMessage.
    const obj = await readObject(ctx, sut.id);
    if (obj.type !== 'commit') throw new Error('expected a commit object');
    expect(obj.data.message).toBe('explicit message');
  });

  it('Given an empty message with a stray MERGE_MSG but no merge in progress, When commit, Then throws EMPTY_COMMIT_MESSAGE', async () => {
    // Arrange — MERGE_MSG present, but MERGE_HEAD absent → mergeHead is undefined.
    const ctx = await seed();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_MSG`, 'should be ignored');

    // Act
    const err = await expectError(
      () => commit(ctx, { message: '', author }),
      'EMPTY_COMMIT_MESSAGE',
    );

    // Assert — kills the ConditionalExpression mutant on `mergeHead === undefined`
    // (false would route to the MERGE_MSG fallback and succeed instead).
    expect(err.data.code).toBe('EMPTY_COMMIT_MESSAGE');
  });

  it('Given a normal commit, When commit, Then the stored message is the user message', async () => {
    // Arrange
    const ctx = await seed();

    // Act
    const sut = await commit(ctx, { message: 'plain message', author });

    // Assert — kills the ConditionalExpression mutant flipping the
    // resolveCommitMessage guard to `false` (which would route to MERGE_MSG).
    const obj = await readObject(ctx, sut.id);
    if (obj.type !== 'commit') throw new Error('expected a commit object');
    expect(obj.data.message).toBe('plain message');
  });

  it('Given a detached HEAD, When commit, Then HEAD is rewritten in place to the new commit id', async () => {
    // Arrange — first commit, then detach HEAD onto that commit id.
    const ctx = await seed();
    const first = await commit(ctx, { message: 'first', author });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${first.id}\n`);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'changed');
    await add(ctx, ['a.txt']);

    // Act
    const sut = await commit(ctx, { message: 'detached', author });

    // Assert — kills the BlockStatement + StringLiteral mutants on the
    // detached-HEAD write: HEAD file content must be exactly `${id}\n`.
    expect(sut.branch).toBeUndefined();
    expect(sut.parents).toEqual([first.id]);
    const headContent = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
    expect(headContent).toBe(`${sut.id}\n`);
  });

  it('Given a config [user] and no explicit author, When commit, Then the author uses second-granularity timestamp and +0000 offset', async () => {
    // Arrange — only the config user identity is available.
    const ctx = await seed();
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/config`,
      '[user]\n  name = Grace\n  email = grace@example.com\n',
    );
    __resetConfigCacheForTests();
    const before = Math.floor(Date.now() / 1000);

    // Act
    const sut = await commit(ctx, { message: 'configured' });

    // Assert — kills the ArithmeticOperator (`/` → `*`) and StringLiteral
    // (`+0000` → ``) mutants in toAuthor.
    const obj = await readObject(ctx, sut.id);
    if (obj.type !== 'commit') throw new Error('expected a commit object');
    const after = Math.ceil(Date.now() / 1000);
    expect(obj.data.author.name).toBe('Grace');
    expect(obj.data.author.timestamp).toBeGreaterThanOrEqual(before);
    expect(obj.data.author.timestamp).toBeLessThanOrEqual(after);
    expect(obj.data.author.timezoneOffset).toBe('+0000');
  });

  it('Given a stray MERGE_MSG but no merge in progress, When commit succeeds, Then merge state is left untouched', async () => {
    // Arrange — a stray MERGE_MSG with no MERGE_HEAD: mergeHead resolves to
    // undefined, so the resolving commit must NOT clear merge state.
    const ctx = await seed();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_MSG`, 'leftover draft');

    // Act
    await commit(ctx, { message: 'normal commit', author });

    // Assert — kills the ConditionalExpression mutant flipping `mergeHead !==
    // undefined` to `true` (which would unconditionally clear merge state).
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(true);
  });

  it('Given a real merge resolution, When commit succeeds, Then MERGE_HEAD and MERGE_MSG are cleared', async () => {
    // Arrange
    const ctx = await seed();
    await commit(ctx, { message: 'first', author });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'1'.repeat(40)}\n`);
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_MSG`, 'merge draft');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'changed');
    await add(ctx, ['a.txt']);

    // Act
    await commit(ctx, { message: 'resolved', author });

    // Assert — the merge-state clear path actually runs and removes the markers.
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(false);
  });

  it('Given a detached HEAD pointing at a non-commit object, When commit, Then the parent-tree falls back to the zero oid and the commit succeeds', async () => {
    // Arrange — detach HEAD onto a blob; getParentTree must return a zero oid
    // for the non-commit parent rather than constructing an empty id.
    const ctx = await seed();
    await commit(ctx, { message: 'first', author });
    const blobId = (await writeObject(ctx, {
      type: 'blob',
      id: '' as ObjectId,
      content: new TextEncoder().encode('not a commit'),
    })) as ObjectId;
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${blobId}\n`);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'changed');
    await add(ctx, ['a.txt']);

    // Act
    const sut = await commit(ctx, { message: 'orphan parent', author });

    // Assert — kills the StringLiteral mutant `'0'.repeat(40)` → `''`, which
    // would make ObjectId.from throw INVALID_OBJECT_ID instead of returning.
    expect(sut.id).toMatch(/^[0-9a-f]{40}$/);
    expect(sut.parents).toEqual([blobId]);
  });
});

afterEach(() => __resetConfigCacheForTests());
