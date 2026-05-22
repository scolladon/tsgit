import { describe, expect, it } from 'vitest';
import { submodules } from '../../../../src/application/commands/submodules.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId, TreeEntry } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from '../primitives/fixtures.js';

const FAKE_COMMIT = '1111111111111111111111111111111111111111' as ObjectId;
const FAKE_COMMIT_NESTED = '2222222222222222222222222222222222222222' as ObjectId;

const writeBlobText = async (ctx: Context, text: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(text),
    id: '' as ObjectId,
  } satisfies Blob);

const writeRoot = async (
  ctx: Context,
  gitmodulesText: string | undefined,
  gitlinks: ReadonlyArray<{ readonly name: string; readonly id: ObjectId }>,
): Promise<ObjectId> => {
  const entries: TreeEntry[] = [];
  if (gitmodulesText !== undefined) {
    const blobId = await writeBlobText(ctx, gitmodulesText);
    entries.push({ name: '.gitmodules', mode: FILE_MODE.REGULAR, id: blobId });
  }
  for (const g of gitlinks) {
    entries.push({ name: g.name, mode: FILE_MODE.GITLINK, id: g.id });
  }
  return writeTree(ctx, entries);
};

const writeCommit = async (ctx: Context, treeId: ObjectId): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: treeId,
      parents: [],
      author: {
        name: 'Ada',
        email: 'ada@example.com',
        timestamp: 1_700_000_000,
        timezoneOffset: '+0000',
      },
      committer: {
        name: 'Ada',
        email: 'ada@example.com',
        timestamp: 1_700_000_000,
        timezoneOffset: '+0000',
      },
      message: 'seed',
      extraHeaders: [],
    },
  });

const seedRepoWithHead = async (
  gitmodulesText: string | undefined,
  gitlinks: ReadonlyArray<{ readonly name: string; readonly id: ObjectId }>,
): Promise<{ readonly ctx: Context; readonly commit: ObjectId; readonly tree: ObjectId }> => {
  __resetConfigCacheForTests();
  const ctx = await buildSeededContext();
  const tree = await writeRoot(ctx, gitmodulesText, gitlinks);
  const commit = await writeCommit(ctx, tree);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${commit}\n`);
  return { ctx, commit, tree };
};

describe('commands/submodules', () => {
  it('Given a repo with one submodule, When submodules(), Then returns kind=list with the entry', async () => {
    // Arrange
    const text = '[submodule "foo"]\n\tpath = foo\n\turl = https://e/foo.git\n';
    const { ctx } = await seedRepoWithHead(text, [{ name: 'foo', id: FAKE_COMMIT }]);

    // Act
    const sut = await submodules(ctx);

    // Assert
    expect(sut.kind).toBe('list');
    expect(sut.entries).toEqual([
      {
        name: 'foo',
        path: 'foo',
        url: 'https://e/foo.git',
        commit: FAKE_COMMIT,
        depth: 0,
      },
    ]);
  });

  it('Given a non-repository context (no HEAD), When submodules(), Then throws NOT_A_REPOSITORY', async () => {
    // Arrange
    __resetConfigCacheForTests();
    const ctx = await buildSeededContext();
    // No HEAD seeded — assertRepository must reject.

    // Act & Assert
    try {
      await submodules(ctx);
      expect.fail('submodules did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      expect((err as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
    }
  });

  it('Given recursive=true, When submodules(), Then walkSubmodules is invoked recursively', async () => {
    // Arrange — set up an absorbed nested submodule.
    __resetConfigCacheForTests();
    const ctx = await buildSeededContext();
    const childGitDir = `${ctx.layout.gitDir}/modules/foo`;
    const childCtx: Context = Object.freeze({
      ...ctx,
      layout: Object.freeze({ ...ctx.layout, gitDir: childGitDir }),
    });
    const childTreeId = await writeRoot(childCtx, undefined, [
      { name: 'inner', id: FAKE_COMMIT_NESTED },
    ]);
    const childCommit = await writeCommit(childCtx, childTreeId);
    await ctx.fs.writeUtf8(`${childGitDir}/HEAD`, `${childCommit}\n`);

    const text = '[submodule "foo"]\n\tpath = foo\n\turl = https://e/foo.git\n';
    const parentTree = await writeRoot(ctx, text, [{ name: 'foo', id: childCommit }]);
    const parentCommit = await writeCommit(ctx, parentTree);
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${parentCommit}\n`);

    // Act
    const sut = await submodules(ctx, { recursive: true });

    // Assert
    expect(sut.entries.map((e) => e.depth)).toEqual([0, 1]);
    expect(sut.entries[1]?.parent).toBe('foo');
  });

  it('Given recursive omitted, When submodules(), Then only depth-0 entries yield', async () => {
    // Arrange
    __resetConfigCacheForTests();
    const ctx = await buildSeededContext();
    const childGitDir = `${ctx.layout.gitDir}/modules/foo`;
    const childCtx: Context = Object.freeze({
      ...ctx,
      layout: Object.freeze({ ...ctx.layout, gitDir: childGitDir }),
    });
    const childTreeId = await writeRoot(childCtx, undefined, [
      { name: 'inner', id: FAKE_COMMIT_NESTED },
    ]);
    const childCommit = await writeCommit(childCtx, childTreeId);
    await ctx.fs.writeUtf8(`${childGitDir}/HEAD`, `${childCommit}\n`);

    const text = '[submodule "foo"]\n\tpath = foo\n\turl = https://e/foo.git\n';
    const parentTree = await writeRoot(ctx, text, [{ name: 'foo', id: childCommit }]);
    const parentCommit = await writeCommit(ctx, parentTree);
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${parentCommit}\n`);

    // Act
    const sut = await submodules(ctx);

    // Assert
    expect(sut.entries.map((e) => e.depth)).toEqual([0]);
  });

  it('Given an explicit ref name, When submodules({ ref: "refs/heads/feature" }), Then walks that ref', async () => {
    // Arrange
    const { ctx, commit } = await seedRepoWithHead(undefined, [{ name: 'foo', id: FAKE_COMMIT }]);
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/feature`, `${commit}\n`);

    // Act
    const sut = await submodules(ctx, { ref: 'refs/heads/feature' });

    // Assert
    expect(sut.entries).toHaveLength(1);
    expect(sut.entries[0]?.path).toBe('foo');
  });

  it('Given a ref that is an object-id-shaped string, When submodules, Then coerceRef takes the ObjectId branch', async () => {
    // Arrange
    const { ctx, tree } = await seedRepoWithHead(undefined, [{ name: 'foo', id: FAKE_COMMIT }]);

    // Act — `tree` is the root tree OID directly; coerceRef must recognise it as an oid.
    const sut = await submodules(ctx, { ref: tree });

    // Assert
    expect(sut.entries).toHaveLength(1);
    expect(sut.entries[0]?.path).toBe('foo');
  });

  it('Given a malformed ref name, When submodules, Then validateRefName rejects it', async () => {
    // Arrange
    const { ctx } = await seedRepoWithHead(undefined, []);

    // Act & Assert — refs with a literal ".." path-segment are invalid by validateRefName.
    try {
      await submodules(ctx, { ref: 'refs/../escape' });
      expect.fail('submodules did not reject the bad ref');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      expect((err as TsgitError).data.code).toBe('INVALID_REF');
    }
  });
});
