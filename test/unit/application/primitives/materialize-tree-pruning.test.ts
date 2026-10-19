import { describe, expect, it, vi } from 'vitest';

import { materializeTree } from '../../../../src/application/primitives/materialize-tree.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import { buildSeededContext } from './fixtures.js';

vi.mock('../../../../src/application/primitives/read-object.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/application/primitives/read-object.js')>();
  return { ...actual, readObject: vi.fn(actual.readObject) };
});

const blobOf = (ctx: Awaited<ReturnType<typeof buildSeededContext>>, content: string) =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const indexOf = (rows: ReadonlyArray<readonly [string, ObjectId, 0 | 1 | 2 | 3]>) => ({
  version: 2 as const,
  extensions: [],
  trailerSha: new Uint8Array(0),
  entries: rows.map(([path, id, stage]) => ({
    ctimeSeconds: 0,
    ctimeNanoseconds: 0,
    mtimeSeconds: 0,
    mtimeNanoseconds: 0,
    dev: 0,
    ino: 0,
    mode: FILE_MODE.REGULAR,
    uid: 0,
    gid: 0,
    fileSize: 0,
    id,
    flags: { ...STAGE0_FLAGS, stage },
    path: path as FilePath,
  })),
});

const refusalOf = async (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('materializeTree carrying head agreement', () => {
  describe('Given head and target sharing the directory d and differing in b', () => {
    describe('When the branch switch materialises', () => {
      it('Then the shared directory is read once, for the target only', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [oldB, newB, inD] = [
          await blobOf(ctx, 'old'),
          await blobOf(ctx, 'new'),
          await blobOf(ctx, 'd'),
        ];
        const shared = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, inD)]);
        const rootWith = (b: ObjectId) =>
          writeTree(ctx, [
            treeEntry(FILE_MODE.REGULAR, 'b' as FilePath, b),
            treeEntry(FILE_MODE.DIRECTORY, 'd' as FilePath, shared),
          ]);
        const [headTree, targetTree] = [await rootWith(oldB), await rootWith(newB)];
        const currentIndex = {
          version: 2 as const,
          extensions: [],
          trailerSha: new Uint8Array(0),
          entries: [
            ['b', oldB],
            ['d/f', inD],
          ].map(([path, id]) => ({
            ctimeSeconds: 0,
            ctimeNanoseconds: 0,
            mtimeSeconds: 0,
            mtimeNanoseconds: 0,
            dev: 0,
            ino: 0,
            mode: FILE_MODE.REGULAR,
            uid: 0,
            gid: 0,
            fileSize: 0,
            id: id as ObjectId,
            flags: { ...STAGE0_FLAGS },
            path: path as FilePath,
          })),
        };
        vi.mocked(readObject).mockClear();

        // Act
        const sut = materializeTree;
        await sut(ctx, { targetTree, currentIndex, headTree });

        // Assert
        const readIds = vi.mocked(readObject).mock.calls.map(([, id]) => id);
        expect(readIds.filter((id) => id === shared)).toHaveLength(1);
      });
    });
  });

  describe('Given staged changes to z and a that neither head nor the target carries', () => {
    describe('When the branch switch is refused', () => {
      it('Then the refused paths are listed in path order whatever order the trees hold them', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [headZ, targetZ, targetA, stagedZ, stagedA] = [
          await blobOf(ctx, 'head z'),
          await blobOf(ctx, 'target z'),
          await blobOf(ctx, 'target a'),
          await blobOf(ctx, 'staged z'),
          await blobOf(ctx, 'staged a'),
        ];
        const file = (name: string, id: ObjectId) =>
          treeEntry(FILE_MODE.REGULAR, name as FilePath, id);
        const headTree = await writeTree(ctx, [file('z', headZ)]);
        const targetTree = await writeTree(ctx, [file('a', targetA), file('z', targetZ)]);
        const currentIndex = indexOf([
          ['a', stagedA, 0],
          ['z', stagedZ, 0],
        ]);

        // Act
        const sut = materializeTree;
        const failure = await refusalOf(sut(ctx, { targetTree, currentIndex, headTree }));

        // Assert
        expect(failure).toMatchObject({
          data: { code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: ['a', 'z'], untracked: [] },
        });
      });
    });
  });

  describe('Given a path HEAD and the target differ on, held by the index only as conflict stages', () => {
    describe('When the branch switch materialises', () => {
      it('Then the conflict stages count as no staged version and the path is refused', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [headP, targetP] = [await blobOf(ctx, 'head p'), await blobOf(ctx, 'target p')];
        const file = (id: ObjectId) => treeEntry(FILE_MODE.REGULAR, 'p' as FilePath, id);
        const headTree = await writeTree(ctx, [file(headP)]);
        const targetTree = await writeTree(ctx, [file(targetP)]);
        const currentIndex = indexOf([
          ['p', headP, 1],
          ['p', headP, 2],
          ['p', headP, 3],
        ]);

        // Act
        const sut = materializeTree;
        const failure = await refusalOf(sut(ctx, { targetTree, currentIndex, headTree }));

        // Assert
        expect(failure).toMatchObject({
          data: { code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: ['p'], untracked: [] },
        });
      });
    });
  });
});
