import { describe, expect, it } from 'vitest';

import {
  diffTreesPruned,
  isBelowShared,
} from '../../../../../src/application/primitives/internal/pruned-tree-diff.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { indexPathKey, keyOfPath } from '../../../../../src/domain/git-index/index-path-key.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId, TreeEntry } from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import { buildSeededContext } from '../fixtures.js';

type Ctx = Awaited<ReturnType<typeof buildSeededContext>>;

const blob = (ctx: Ctx, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const file = (name: string, id: ObjectId, mode: string = FILE_MODE.REGULAR): TreeEntry =>
  treeEntry(mode as typeof FILE_MODE.REGULAR, name as FilePath, id);

const dir = (name: string, id: ObjectId): TreeEntry =>
  treeEntry(FILE_MODE.DIRECTORY, name as FilePath, id);

const pathsOf = (diff: Awaited<ReturnType<typeof diffTreesPruned>>): string[] =>
  diff.oldFiles.map((f) => f.path);

describe('diffTreesPruned', () => {
  describe('Given two trees with the same root object', () => {
    describe('When they are compared', () => {
      it('Then nothing is read and the whole tree is shared', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const root = await writeTree(ctx, [file('a', await blob(ctx, 'a'))]);

        // Act
        const sut = diffTreesPruned;
        const result = await sut(ctx, root, root);

        // Assert
        expect(result.oldFiles).toEqual([]);
        expect(isBelowShared(result.sharedDirs, keyOfPath('a/b' as FilePath))).toBe(true);
      });
    });
  });

  describe('Given trees sharing d, and differing in b, in x/y and in the mode of m', () => {
    describe('When they are compared', () => {
      it('Then the old files of the differing paths are listed and d is shared', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [one, two, three] = [
          await blob(ctx, '1'),
          await blob(ctx, '2'),
          await blob(ctx, '3'),
        ];
        const shared = await writeTree(ctx, [file('f', one)]);
        const rootOf = async (b: ObjectId, y: ObjectId, mode: string) =>
          writeTree(ctx, [
            file('b', b),
            file('m', one, mode),
            dir('d', shared),
            dir('x', await writeTree(ctx, [file('y', y), file('same', one)])),
          ]);
        const oldRoot = await rootOf(one, one, FILE_MODE.REGULAR);
        const newRoot = await rootOf(two, three, FILE_MODE.EXECUTABLE);

        // Act
        const sut = diffTreesPruned;
        const result = await sut(ctx, oldRoot, newRoot);

        // Assert
        expect(pathsOf(result).sort()).toEqual(['b', 'm', 'x/same', 'x/y']);
        expect([...result.sharedDirs]).toEqual(['d/']);
        expect(result.oldFiles.find((f) => f.path === ('m' as FilePath))?.mode).toBe(
          FILE_MODE.REGULAR,
        );
      });
    });
  });

  describe('Given a directory in the old tree that is a file in the new one', () => {
    describe('When they are compared', () => {
      it('Then the files below the old directory are listed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const one = await blob(ctx, '1');
        const oldRoot = await writeTree(ctx, [dir('p', await writeTree(ctx, [file('q', one)]))]);
        const newRoot = await writeTree(ctx, [file('p', one)]);

        // Act
        const sut = diffTreesPruned;
        const result = await sut(ctx, oldRoot, newRoot);

        // Assert
        expect(pathsOf(result)).toEqual(['p/q']);
        expect(result.sharedDirs.size).toBe(0);
      });
    });
  });

  describe('Given a file in the old tree that is a directory in the new one', () => {
    describe('When they are compared', () => {
      it('Then the old file is listed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const one = await blob(ctx, '1');
        const oldRoot = await writeTree(ctx, [file('p', one)]);
        const newRoot = await writeTree(ctx, [dir('p', await writeTree(ctx, [file('q', one)]))]);

        // Act
        const sut = diffTreesPruned;
        const result = await sut(ctx, oldRoot, newRoot);

        // Assert
        expect(pathsOf(result)).toEqual(['p']);
      });
    });
  });

  describe('Given a gitlink in the old tree', () => {
    describe('When the new tree drops it', () => {
      it('Then the gitlink is listed as an old file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const one = await blob(ctx, '1');
        const oldRoot = await writeTree(ctx, [file('sub', one, FILE_MODE.GITLINK), file('k', one)]);
        const newRoot = await writeTree(ctx, [file('k', one)]);

        // Act
        const sut = diffTreesPruned;
        const result = await sut(ctx, oldRoot, newRoot);

        // Assert
        expect(result.oldFiles.map((f) => [f.path, f.mode])).toContainEqual([
          'sub',
          FILE_MODE.GITLINK,
        ]);
      });
    });
  });

  describe('Given a directory whose name is not valid UTF-8', () => {
    describe('When the old file below it differs', () => {
      it('Then its key matches the escaped index path', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [one, two] = [await blob(ctx, '1'), await blob(ctx, '2')];
        const invalid = new Uint8Array([0x64, 0xff]);
        const rootOf = async (id: ObjectId) =>
          writeTree(ctx, [
            { ...dir('d�', await writeTree(ctx, [file('f', id)])), nameBytes: invalid },
          ]);

        // Act
        const sut = diffTreesPruned;
        const result = await sut(ctx, await rootOf(one), await rootOf(two));

        // Assert
        const [only] = result.oldFiles;
        expect(only?.pathBytes).toEqual(new Uint8Array([0x64, 0xff, 0x2f, 0x66]));
        expect(indexPathKey(only as NonNullable<typeof only>)).toBe('d\uDCFF/f');
      });
    });
  });

  describe('Given trees nested deeper than core.maxTreeDepth', () => {
    describe('When they are compared', () => {
      it('Then it refuses with TREE_DEPTH_EXCEEDED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 1\n');
        const [one, two] = [await blob(ctx, '1'), await blob(ctx, '2')];
        const nested = async (id: ObjectId) =>
          writeTree(ctx, [
            dir('a', await writeTree(ctx, [dir('b', await writeTree(ctx, [file('f', id)]))])),
          ]);

        // Act
        const attempt = diffTreesPruned(ctx, await nested(one), await nested(two));

        // Assert
        await expect(attempt).rejects.toMatchObject({ data: { code: 'TREE_DEPTH_EXCEEDED' } });
      });
    });
  });

  describe('Given an aborted signal', () => {
    describe('When two different trees are compared', () => {
      it('Then it refuses with OPERATION_ABORTED', async () => {
        // Arrange
        const controller = new AbortController();
        const ctx = await buildSeededContext({ signal: controller.signal });
        const [one, two] = [await blob(ctx, '1'), await blob(ctx, '2')];
        const [oldRoot, newRoot] = [
          await writeTree(ctx, [file('a', one)]),
          await writeTree(ctx, [file('a', two)]),
        ];
        controller.abort();

        // Act
        const attempt = diffTreesPruned(ctx, oldRoot, newRoot);

        // Assert
        await expect(attempt).rejects.toMatchObject({ data: { code: 'OPERATION_ABORTED' } });
      });
    });
  });
});

describe('isBelowShared', () => {
  describe.each([
    ['a/b', ['a/'], true],
    ['a/b/c', ['a/b/'], true],
    ['a', ['a/'], false],
    ['ab/c', ['a/'], false],
    ['a/b', ['b/'], false],
    ['top', [], false],
  ] as const)('Given the key %s and shared dirs %j', (key, dirs, expected) => {
    describe('When it is tested', () => {
      it(`Then it is ${expected}`, () => {
        // Arrange
        const sharedDirs = new Set<string>(dirs);

        // Act
        const sut = isBelowShared;
        const result = sut(sharedDirs, keyOfPath(key as FilePath));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
