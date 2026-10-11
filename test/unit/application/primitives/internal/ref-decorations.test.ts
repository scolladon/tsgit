import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { loadRefDecorations } from '../../../../../src/application/primitives/internal/ref-decorations.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Decoration } from '../../../../../src/domain/pretty/decorations.js';
import type { Context } from '../../../../../src/ports/context.js';

const IDENTITY = { name: 'A', email: 'a@example.com', timestamp: 0, timezoneOffset: '+0000' };

const putCommit = (ctx: Context, message: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' as ObjectId,
      parents: [],
      author: IDENTITY,
      committer: IDENTITY,
      message,
      extraHeaders: [],
    },
  });

const putTag = (ctx: Context, target: ObjectId, tagName: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: {
      object: target,
      objectType: 'commit',
      tagName,
      tagger: IDENTITY,
      message: `${tagName}\n`,
      extraHeaders: [],
    },
  });

const writeRef = (ctx: Context, name: string, id: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `${id}\n`);

const writeHead = (ctx: Context, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${content}\n`);

interface Repo {
  readonly ctx: Context;
  readonly commit: ObjectId;
}

const repoWithRefs = async (): Promise<Repo> => {
  const ctx = createMemoryContext();
  const commit = await putCommit(ctx, 'one');
  await writeRef(ctx, 'refs/heads/main', commit);
  await writeRef(ctx, 'refs/heads/side', commit);
  await writeRef(ctx, 'refs/remotes/o/main', commit);
  await writeRef(ctx, 'refs/stash', commit);
  await writeRef(ctx, 'refs/custom/x', commit);
  await writeRef(ctx, 'refs/tags/lt2', commit);
  return { ctx, commit };
};

const decorationsOf = async (ctx: Context, id: ObjectId): Promise<ReadonlyArray<Decoration>> =>
  (await loadRefDecorations(ctx)).get(id) ?? [];

describe('loadRefDecorations', () => {
  describe('Given HEAD attached to a branch', () => {
    describe('When the decorations of the shared commit are loaded', () => {
      it("Then HEAD leads, then the refs in git's reverse ref order", async () => {
        // Arrange
        const { ctx, commit } = await repoWithRefs();
        await writeHead(ctx, 'ref: refs/heads/main');
        const sut = loadRefDecorations;

        // Act
        const result = (await sut(ctx)).get(commit);

        // Assert
        expect(result).toEqual([
          { kind: 'head', name: 'HEAD', attachedTo: 'refs/heads/main' },
          { kind: 'tag', name: 'refs/tags/lt2' },
          { kind: 'stash', name: 'refs/stash' },
          { kind: 'remote', name: 'refs/remotes/o/main' },
          { kind: 'branch', name: 'refs/heads/side' },
          { kind: 'branch', name: 'refs/heads/main' },
          { kind: 'other', name: 'refs/custom/x' },
        ]);
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When the decorations of the commit are loaded', () => {
      it('Then HEAD carries no attached branch', async () => {
        // Arrange
        const { ctx, commit } = await repoWithRefs();
        await writeHead(ctx, commit);

        // Act
        const result = await decorationsOf(ctx, commit);

        // Assert
        expect(result[0]).toEqual({ kind: 'head', name: 'HEAD' });
      });
    });
  });

  describe('Given an annotated tag', () => {
    describe('When the decorations are loaded', () => {
      it('Then the tag object and the peeled commit both carry the tag', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const commit = await putCommit(ctx, 'one');
        const tag = await putTag(ctx, commit, 'v1');
        await writeRef(ctx, 'refs/tags/v1', tag);

        // Act
        const result = await loadRefDecorations(ctx);

        // Assert
        expect(result.get(tag)).toEqual([{ kind: 'tag', name: 'refs/tags/v1' }]);
        expect(result.get(commit)).toEqual([{ kind: 'tag', name: 'refs/tags/v1' }]);
      });
    });
  });

  describe('Given a replace ref', () => {
    describe('When the decorations are loaded', () => {
      it('Then the replaced commit is decorated as replaced and the replace ref is not', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const original = await putCommit(ctx, 'original');
        const replacement = await putCommit(ctx, 'replacement');
        await writeRef(ctx, `refs/replace/${original}`, replacement);

        // Act
        const result = await loadRefDecorations(ctx);

        // Assert
        expect(result.get(original)).toEqual([{ kind: 'replaced', name: 'replaced' }]);
        expect(result.has(replacement)).toBe(false);
      });
    });
  });

  describe('Given a replace ref naming an object the repository does not hold', () => {
    describe('When the decorations are loaded', () => {
      it('Then no replaced decoration is made up for the absent object', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const replacement = await putCommit(ctx, 'replacement');
        await writeRef(ctx, `refs/replace/${'0'.repeat(39)}1`, replacement);
        const sut = loadRefDecorations;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.size).toBe(0);
      });
    });
  });

  describe('Given a shallow boundary', () => {
    describe('When the decorations are loaded', () => {
      it('Then the boundary commit is grafted, ahead of its refs', async () => {
        // Arrange
        const { ctx, commit } = await repoWithRefs();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${commit}\n`);

        // Act
        const result = await decorationsOf(ctx, commit);

        // Assert
        expect(result[0]).toEqual({ kind: 'grafted', name: 'grafted' });
      });
    });
  });

  describe('Given a ref to an object the repository does not hold', () => {
    describe('When the decorations are loaded', () => {
      it('Then it is left out', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const absent = 'e'.repeat(40) as ObjectId;
        await writeRef(ctx, 'refs/heads/gone', absent);

        // Act
        const result = await loadRefDecorations(ctx);

        // Assert
        expect(result.size).toBe(0);
      });
    });
  });
});
