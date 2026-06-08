import { describe, expect, it } from 'vitest';
import { submoduleList } from '../../../../src/application/commands/submodule.js';
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

describe('commands/submodule', () => {
  describe('Given a repo with one submodule', () => {
    describe('When submodules()', () => {
      it('Then returns the entry', async () => {
        // Arrange
        const text = '[submodule "foo"]\n\tpath = foo\n\turl = https://e/foo.git\n';
        const { ctx } = await seedRepoWithHead(text, [{ name: 'foo', id: FAKE_COMMIT }]);

        // Act
        const sut = await submoduleList(ctx);

        // Assert
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
    });
  });

  describe('Given a non-repository context (no HEAD)', () => {
    describe('When submodules()', () => {
      it('Then throws NOT_A_REPOSITORY', async () => {
        // Arrange
        __resetConfigCacheForTests();
        const ctx = await buildSeededContext();
        // No HEAD seeded — assertRepository must reject.

        // Act & Assert
        try {
          await submoduleList(ctx);
          // Assert
          expect.fail('submodules did not throw');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
        }
      });
    });
  });

  describe('Given recursive=true', () => {
    describe('When submodules()', () => {
      it('Then walkSubmodules is invoked recursively', async () => {
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
        const sut = await submoduleList(ctx, { recursive: true });

        // Assert
        expect(sut.entries.map((e) => e.depth)).toEqual([0, 1]);
        expect(sut.entries[1]?.parent).toBe('foo');
      });
    });
  });

  describe('Given recursive omitted', () => {
    describe('When submodules()', () => {
      it('Then only depth-0 entries yield', async () => {
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
        const sut = await submoduleList(ctx);

        // Assert
        expect(sut.entries.map((e) => e.depth)).toEqual([0]);
      });
    });
  });

  describe('Given recursive=true and maxDepth=0', () => {
    describe('When submodules()', () => {
      it('Then the depth cap is forwarded and only depth-0 entries yield', async () => {
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
        const sut = await submoduleList(ctx, { recursive: true, maxDepth: 0 });

        // Assert — the cap was forwarded; recursion entered then short-circuited.
        expect(sut.entries.map((e) => e.depth)).toEqual([0]);
      });
    });
  });

  describe('Given an explicit ref name', () => {
    describe('When submodules({ ref: "refs/heads/feature" })', () => {
      it('Then walks that ref', async () => {
        // Arrange
        const { ctx, commit } = await seedRepoWithHead(undefined, [
          { name: 'foo', id: FAKE_COMMIT },
        ]);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/feature`, `${commit}\n`);

        // Act
        const sut = await submoduleList(ctx, { ref: 'refs/heads/feature' });

        // Assert
        expect(sut.entries).toHaveLength(1);
        expect(sut.entries[0]?.path).toBe('foo');
      });
    });
  });

  describe('Given a ref that is an object-id-shaped string', () => {
    describe('When submodules', () => {
      it('Then coerceRef takes the ObjectId branch', async () => {
        // Arrange
        const { ctx, tree } = await seedRepoWithHead(undefined, [{ name: 'foo', id: FAKE_COMMIT }]);

        // Act — `tree` is the root tree OID directly; coerceRef must recognise it as an oid.
        const sut = await submoduleList(ctx, { ref: tree });

        // Assert
        expect(sut.entries).toHaveLength(1);
        expect(sut.entries[0]?.path).toBe('foo');
      });
    });
  });

  describe('Given a malformed ref name', () => {
    describe('When submodules', () => {
      it('Then validateRefName rejects it', async () => {
        // Arrange
        const { ctx } = await seedRepoWithHead(undefined, []);

        // Act & Assert — refs with a literal ".." path-segment are invalid by validateRefName.
        try {
          await submoduleList(ctx, { ref: 'refs/../escape' });
          // Assert
          expect.fail('submodules did not reject the bad ref');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data.code).toBe('INVALID_REF');
        }
      });
    });
  });
});
