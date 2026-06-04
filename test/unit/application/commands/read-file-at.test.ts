import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../src/application/commands/init.js';
import { readFileAt } from '../../../../src/application/commands/read-file-at.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { AuthorIdentity, ObjectId, TreeEntry } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const writeBlob = (ctx: Context, text: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc(text) });

const writeTree = (ctx: Context, entries: ReadonlyArray<TreeEntry>): Promise<ObjectId> =>
  writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries });

const mkCommit = (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
): Promise<ObjectId> =>
  createCommit(ctx, { tree, parents, author, committer: author, message: 'm' });

const setRef = (ctx: Context, ref: string, id: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${ref}`, `${id}\n`);

interface Seed {
  readonly ctx: Context;
  readonly helloId: ObjectId;
}

/**
 * A two-commit repo. The parent tree carries `a.txt = 'old\n'`; the child (HEAD)
 * carries `a.txt = 'hello\n'`, a `dir/nested.txt`, an executable `run.sh`, a
 * `link` symlink (target `a.txt`), and a `sub` gitlink at the parent commit.
 * HEAD, `refs/heads/feature`, and `refs/tags/v1.0` all point at the child.
 */
const seed = async (): Promise<Seed> => {
  const ctx = createMemoryContext();
  await init(ctx);

  const parentTree = await writeTree(ctx, [
    { mode: FILE_MODE.REGULAR, name: 'a.txt', id: await writeBlob(ctx, 'old\n') },
  ]);
  const parent = await mkCommit(ctx, parentTree, []);

  const helloId = await writeBlob(ctx, 'hello\n');
  const dirTree = await writeTree(ctx, [
    { mode: FILE_MODE.REGULAR, name: 'nested.txt', id: await writeBlob(ctx, 'deep\n') },
  ]);
  const childTree = await writeTree(ctx, [
    { mode: FILE_MODE.REGULAR, name: 'a.txt', id: helloId },
    { mode: FILE_MODE.DIRECTORY, name: 'dir', id: dirTree },
    { mode: FILE_MODE.EXECUTABLE, name: 'run.sh', id: await writeBlob(ctx, '#!/bin/sh\n') },
    { mode: FILE_MODE.SYMLINK, name: 'link', id: await writeBlob(ctx, 'a.txt') },
    { mode: FILE_MODE.GITLINK, name: 'sub', id: parent },
  ]);
  const child = await mkCommit(ctx, childTree, [parent]);

  await setRef(ctx, 'refs/heads/main', child);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await setRef(ctx, 'refs/heads/feature', child);
  await setRef(ctx, 'refs/tags/v1.0', child);

  return { ctx, helloId };
};

const catchData = async (run: () => Promise<unknown>): Promise<TsgitError['data']> => {
  try {
    await run();
    return expect.unreachable() as never;
  } catch (error) {
    expect(error).toBeInstanceOf(TsgitError);
    return (error as TsgitError).data;
  }
};

describe('readFileAt', () => {
  describe('Given a committed file at HEAD', () => {
    describe('When readFileAt reads it', () => {
      it('Then returns the blob id, regular mode, and verbatim content', async () => {
        // Arrange
        const { ctx, helloId } = await seed();
        // Act
        const sut = await readFileAt(ctx, 'HEAD', 'a.txt');
        // Assert
        expect(sut.id).toBe(helloId);
        expect(sut.mode).toBe(FILE_MODE.REGULAR);
        expect(dec(sut.content)).toBe('hello\n');
      });
    });
  });

  describe('Given a nested committed file', () => {
    describe('When readFileAt reads the deep path', () => {
      it('Then returns the deep blob content', async () => {
        // Arrange
        const { ctx } = await seed();
        // Act
        const sut = await readFileAt(ctx, 'HEAD', 'dir/nested.txt');
        // Assert
        expect(dec(sut.content)).toBe('deep\n');
      });
    });
  });

  describe('Given a short branch name as rev', () => {
    describe('When readFileAt reads a file', () => {
      it('Then the full rev grammar resolves the branch', async () => {
        // Arrange
        const { ctx } = await seed();
        // Act
        const sut = await readFileAt(ctx, 'feature', 'a.txt');
        // Assert
        expect(dec(sut.content)).toBe('hello\n');
      });
    });
  });

  describe('Given a tag name as rev', () => {
    describe('When readFileAt reads a file', () => {
      it('Then the full rev grammar resolves the tag', async () => {
        // Arrange
        const { ctx } = await seed();
        // Act
        const sut = await readFileAt(ctx, 'v1.0', 'a.txt');
        // Assert
        expect(dec(sut.content)).toBe('hello\n');
      });
    });
  });

  describe('Given a parent-relative rev HEAD~1', () => {
    describe('When readFileAt reads a file', () => {
      it('Then returns the file as of the parent commit', async () => {
        // Arrange
        const { ctx } = await seed();
        // Act
        const sut = await readFileAt(ctx, 'HEAD~1', 'a.txt');
        // Assert
        expect(dec(sut.content)).toBe('old\n');
      });
    });
  });

  describe('Given a path addressing a directory', () => {
    describe('When readFileAt reads it', () => {
      it('Then refuses with UNEXPECTED_OBJECT_TYPE expecting a blob', async () => {
        // Arrange
        const { ctx } = await seed();
        // Act / Assert
        const data = await catchData(() => readFileAt(ctx, 'HEAD', 'dir'));
        expect(data.code).toBe('UNEXPECTED_OBJECT_TYPE');
        if (data.code === 'UNEXPECTED_OBJECT_TYPE') {
          expect(data.expected).toBe('blob');
          expect(data.actual).toBe('tree');
        }
      });
    });
  });

  describe('Given a gitlink (submodule) path', () => {
    describe('When readFileAt reads it', () => {
      it('Then refuses with UNEXPECTED_OBJECT_TYPE actual commit', async () => {
        // Arrange
        const { ctx } = await seed();
        // Act / Assert
        const data = await catchData(() => readFileAt(ctx, 'HEAD', 'sub'));
        expect(data.code).toBe('UNEXPECTED_OBJECT_TYPE');
        if (data.code === 'UNEXPECTED_OBJECT_TYPE') {
          expect(data.actual).toBe('commit');
        }
      });
    });
  });

  describe('Given a path absent from the tree', () => {
    describe('When readFileAt reads it', () => {
      it('Then refuses with PATH_NOT_IN_TREE carrying rev and path', async () => {
        // Arrange
        const { ctx } = await seed();
        // Act / Assert
        const data = await catchData(() => readFileAt(ctx, 'HEAD', 'missing'));
        expect(data.code).toBe('PATH_NOT_IN_TREE');
        if (data.code === 'PATH_NOT_IN_TREE') {
          expect(data.rev).toBe('HEAD');
          expect(data.path).toBe('missing');
        }
      });
    });
  });

  describe('Given a maxBytes cap below the file size', () => {
    describe('When readFileAt reads a larger file', () => {
      it('Then refuses with OBJECT_TOO_LARGE (forwarded to the blob read)', async () => {
        // Arrange
        const { ctx, helloId } = await seed();
        // Act / Assert
        const data = await catchData(() => readFileAt(ctx, 'HEAD', 'a.txt', { maxBytes: 2 }));
        expect(data.code).toBe('OBJECT_TOO_LARGE');
        if (data.code === 'OBJECT_TOO_LARGE') {
          expect(data.id).toBe(helloId);
          expect(data.limit).toBe(2);
        }
      });
    });
  });

  describe('Given an executable file', () => {
    describe('When readFileAt reads it', () => {
      it('Then reports the executable mode', async () => {
        // Arrange
        const { ctx } = await seed();
        // Act
        const sut = await readFileAt(ctx, 'HEAD', 'run.sh');
        // Assert
        expect(sut.mode).toBe(FILE_MODE.EXECUTABLE);
      });
    });
  });

  describe('Given a symlink entry', () => {
    describe('When readFileAt reads it', () => {
      it('Then reports the symlink mode and the link-target bytes', async () => {
        // Arrange
        const { ctx } = await seed();
        // Act
        const sut = await readFileAt(ctx, 'HEAD', 'link');
        // Assert
        expect(sut.mode).toBe(FILE_MODE.SYMLINK);
        expect(dec(sut.content)).toBe('a.txt');
      });
    });
  });
});
