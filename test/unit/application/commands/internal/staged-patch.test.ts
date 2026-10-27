import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import { judgeStagedPatch } from '../../../../../src/application/commands/internal/staged-patch.js';
import { flattenTree } from '../../../../../src/application/primitives/flatten-tree.js';
import { hashBlob } from '../../../../../src/application/primitives/hash-blob.js';
import { stage0Entry } from '../../../../../src/application/primitives/internal/synthetic-index-entry.js';
import { readBlob } from '../../../../../src/application/primitives/read-blob.js';
import { readObject } from '../../../../../src/application/primitives/read-object.js';
import { synthesizeTreeFromIndex } from '../../../../../src/application/primitives/synthesize-tree-from-index.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../src/ports/context.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

interface Spec {
  readonly bytes?: Uint8Array;
  readonly gitlink?: string;
  readonly mode: FileMode;
}
const file = (content: string, mode: FileMode = FILE_MODE.REGULAR): Spec => ({
  bytes: text(content),
  mode,
});
const binary = (marker: number, mode: FileMode = FILE_MODE.REGULAR): Spec => ({
  bytes: new Uint8Array([0, 1, 2, marker]),
  mode,
});
const symlink = (target: string): Spec => ({ bytes: text(target), mode: FILE_MODE.SYMLINK });
const gitlink = (char: string): Spec => ({ gitlink: char.repeat(40), mode: FILE_MODE.GITLINK });

const treeOf = async (ctx: Context, specs: Record<string, Spec>): Promise<ObjectId> => {
  const entries = [];
  for (const [path, spec] of Object.entries(specs)) {
    const id =
      spec.bytes === undefined
        ? (spec.gitlink as ObjectId)
        : await hashBlob(ctx, spec.bytes, { write: true });
    entries.push(stage0Entry(path as FilePath, id, spec.mode));
  }
  return synthesizeTreeFromIndex(ctx, entries);
};

const blobAt = async (ctx: Context, tree: ObjectId, path: string): Promise<string> => {
  const entry = (await flattenTree(ctx, tree)).entries.get(path as FilePath);
  return decode((await readBlob(ctx, entry?.id as ObjectId)).content);
};

const modeAt = async (ctx: Context, tree: ObjectId, path: string): Promise<FileMode | undefined> =>
  (await flattenTree(ctx, tree)).entries.get(path as FilePath)?.mode;

const hostileTree = async (ctx: Context, dir: string, name: string): Promise<ObjectId> => {
  const blob = await hashBlob(ctx, text('x\n'), { write: true });
  const inner = await writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [treeEntry(FILE_MODE.REGULAR, name, blob)],
  });
  return writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [treeEntry(FILE_MODE.DIRECTORY, dir, inner)],
  });
};

const duplicateNameTree = async (ctx: Context, name: string): Promise<ObjectId> => {
  const blob = await hashBlob(ctx, text('x\n'), { write: true });
  const inner = await writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [treeEntry(FILE_MODE.REGULAR, 'x', blob)],
  });
  return writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [
      treeEntry(FILE_MODE.REGULAR, name, blob),
      treeEntry(FILE_MODE.DIRECTORY, name, inner),
    ],
  });
};

const lines = (n: number, edit?: { at: number; to: string }): string =>
  Array.from({ length: n }, (_, k) => (edit?.at === k + 1 ? edit.to : `l${k + 1}`))
    .map((l) => `${l}\n`)
    .join('');

const setup = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  return ctx;
};

describe('judgeStagedPatch', () => {
  describe('Given a text modification of f staged in I', () => {
    describe('When C carries one extra line above the hunk', () => {
      it('Then the verdict applies and f holds the patched bytes, other entries kept', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(lines(9)) });
        const iTree = await treeOf(ctx, { f: file(lines(9, { at: 5, to: 'L5' })) });
        const cTree = await treeOf(ctx, { f: file(`top\n${lines(9)}`), keep: file('k\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        expect(await blobAt(ctx, result.tree, 'f')).toBe(`top\n${lines(9, { at: 5, to: 'L5' })}`);
        expect(await blobAt(ctx, result.tree, 'keep')).toBe('k\n');
      });
    });

    describe('When C carries f as executable', () => {
      it('Then the result keeps mode 100755', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(lines(9)) });
        const iTree = await treeOf(ctx, { f: file(lines(9, { at: 5, to: 'L5' })) });
        const cTree = await treeOf(ctx, { f: file(`top\n${lines(9)}`, FILE_MODE.EXECUTABLE) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        expect(await modeAt(ctx, result.tree, 'f')).toBe(FILE_MODE.EXECUTABLE);
      });
    });
  });

  describe('Given a text modification of f staged in I that C cannot take', () => {
    const modified = { b: file(lines(9)), i: file(lines(9, { at: 5, to: 'L5' })) };

    describe('When C changed the same line differently', () => {
      it('Then f is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: modified.b });
        const iTree = await treeOf(ctx, { f: modified.i });
        const cTree = await treeOf(ctx, { f: file(lines(9, { at: 5, to: 'other' })) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['f'] });
      });
    });

    describe('When C lacks f', () => {
      it('Then f is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: modified.b });
        const iTree = await treeOf(ctx, { f: modified.i });
        const cTree = await treeOf(ctx, { keep: file('k\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['f'] });
      });
    });

    describe('When C holds f as a symlink', () => {
      it('Then f is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: modified.b });
        const iTree = await treeOf(ctx, { f: modified.i });
        const cTree = await treeOf(ctx, { f: symlink('elsewhere') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['f'] });
      });
    });
  });

  describe('Given a file n created in I', () => {
    describe('When C already holds n', () => {
      it('Then n is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { keep: file('k\n') });
        const iTree = await treeOf(ctx, { keep: file('k\n'), n: file('new\n') });
        const cTree = await treeOf(ctx, { keep: file('k\n'), n: file('mine\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['n'] });
      });
    });

    describe('When C holds the same n', () => {
      it('Then n is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, {});
        const iTree = await treeOf(ctx, { n: file('new\n') });
        const cTree = await treeOf(ctx, { n: file('new\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['n'] });
      });
    });

    describe('When C lacks n', () => {
      it('Then the result holds the entry of I', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, {});
        const iTree = await treeOf(ctx, { n: file('new\n') });
        const cTree = await treeOf(ctx, { keep: file('k\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        expect(await blobAt(ctx, result.tree, 'n')).toBe('new\n');
        expect(await blobAt(ctx, result.tree, 'keep')).toBe('k\n');
      });
    });
  });

  describe('Given n/x created in I', () => {
    describe('When C holds the file n', () => {
      it('Then n/x is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, {});
        const iTree = await treeOf(ctx, { 'n/x': file('x\n') });
        const cTree = await treeOf(ctx, { n: file('n\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['n/x'] });
      });
    });
  });

  describe('Given a file g created in I', () => {
    describe('When C holds g/x', () => {
      it('Then g is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, {});
        const iTree = await treeOf(ctx, { g: file('g\n') });
        const cTree = await treeOf(ctx, { 'g/x': file('x\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['g'] });
      });
    });
  });

  describe('Given f deleted in I', () => {
    describe('When C holds f with equal content and another mode', () => {
      it('Then f is removed', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(lines(3)), keep: file('k\n') });
        const iTree = await treeOf(ctx, { keep: file('k\n') });
        const cTree = await treeOf(ctx, {
          f: file(lines(3), FILE_MODE.EXECUTABLE),
          keep: file('k\n'),
        });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        expect(await modeAt(ctx, result.tree, 'f')).toBeUndefined();
        expect(await blobAt(ctx, result.tree, 'keep')).toBe('k\n');
      });
    });

    describe('When C holds f with other content', () => {
      it('Then f is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(lines(3)) });
        const iTree = await treeOf(ctx, {});
        const cTree = await treeOf(ctx, { f: file(lines(3, { at: 3, to: 'L3' })) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['f'] });
      });
    });

    describe('When C lacks f', () => {
      it('Then f is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(lines(3)), keep: file('k\n') });
        const iTree = await treeOf(ctx, { keep: file('k\n') });
        const cTree = await treeOf(ctx, { keep: file('k\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['f'] });
      });
    });

    describe('When C holds f as a symlink whose target is the base content', () => {
      it('Then f is refused as of the wrong type', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(lines(3)), keep: file('k\n') });
        const iTree = await treeOf(ctx, { keep: file('k\n') });
        const cTree = await treeOf(ctx, { f: symlink(lines(3)), keep: file('k\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['f'] });
      });
    });
  });

  describe('Given f turned into a symlink in I', () => {
    describe('When C holds f equal in content with another mode', () => {
      it('Then the result holds the symlink', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(lines(3)) });
        const iTree = await treeOf(ctx, { f: symlink('t') });
        const cTree = await treeOf(ctx, { f: file(lines(3), FILE_MODE.EXECUTABLE) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        expect(await modeAt(ctx, result.tree, 'f')).toBe(FILE_MODE.SYMLINK);
        expect(await blobAt(ctx, result.tree, 'f')).toBe('t');
      });
    });

    describe('When C holds f with other content', () => {
      it('Then f is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(lines(3)) });
        const iTree = await treeOf(ctx, { f: symlink('t') });
        const cTree = await treeOf(ctx, { f: file(lines(3, { at: 3, to: 'L3' })) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['f'] });
      });
    });
  });

  describe('Given f turned into a gitlink in I', () => {
    describe('When C holds f with other content', () => {
      it('Then f is refused without reading the gitlink as a blob', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(lines(3)) });
        const iTree = await treeOf(ctx, { f: gitlink('a') });
        const cTree = await treeOf(ctx, { f: file(lines(3, { at: 3, to: 'L3' })) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['f'] });
      });
    });
  });

  describe('Given a gitlink sub moved in I', () => {
    describe('When C holds the gitlink at the base oid', () => {
      it('Then the result holds the oid of I', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { sub: gitlink('1') });
        const iTree = await treeOf(ctx, { sub: gitlink('2') });
        const cTree = await treeOf(ctx, { sub: gitlink('1') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        const entry = (await flattenTree(ctx, result.tree)).entries.get('sub' as FilePath);
        expect(entry).toStrictEqual({ id: '2'.repeat(40), mode: FILE_MODE.GITLINK });
      });
    });

    describe('When C holds the gitlink at another oid', () => {
      it('Then sub is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { sub: gitlink('1') });
        const iTree = await treeOf(ctx, { sub: gitlink('2') });
        const cTree = await treeOf(ctx, { sub: gitlink('3') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['sub'] });
      });
    });
  });

  describe('Given a binary file changed in I', () => {
    describe('When C differs only by mode', () => {
      it('Then the result holds the blob of I with the mode of C', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { bin: binary(1) });
        const iTree = await treeOf(ctx, { bin: binary(2) });
        const cTree = await treeOf(ctx, { bin: binary(1, FILE_MODE.EXECUTABLE) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        const entry = (await flattenTree(ctx, result.tree)).entries.get('bin' as FilePath);
        expect(entry?.mode).toBe(FILE_MODE.EXECUTABLE);
        expect(entry?.id).toBe(await hashBlob(ctx, new Uint8Array([0, 1, 2, 2])));
      });
    });

    describe('When C changed its content otherwise', () => {
      it('Then bin is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { bin: binary(1) });
        const iTree = await treeOf(ctx, { bin: binary(2) });
        const cTree = await treeOf(ctx, { bin: binary(3) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['bin'] });
      });
    });
  });

  describe('Given a mode-only change of f in I', () => {
    describe('When C holds f with other content', () => {
      it('Then the result holds the blob of C with the mode of I', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(lines(3)) });
        const iTree = await treeOf(ctx, { f: file(lines(3), FILE_MODE.EXECUTABLE) });
        const cTree = await treeOf(ctx, { f: file(lines(3, { at: 3, to: 'L3' })) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        expect(await blobAt(ctx, result.tree, 'f')).toBe(lines(3, { at: 3, to: 'L3' }));
        expect(await modeAt(ctx, result.tree, 'f')).toBe(FILE_MODE.EXECUTABLE);
      });
    });

    describe('When C holds f as a symlink', () => {
      it('Then f is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(lines(3)) });
        const iTree = await treeOf(ctx, { f: file(lines(3), FILE_MODE.EXECUTABLE) });
        const cTree = await treeOf(ctx, { f: symlink('t') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['f'] });
      });
    });
  });

  describe('Given a file a created and a file b edited in I that C cannot take', () => {
    describe('When C staged a otherwise and removed b', () => {
      it('Then both are refused in index order, whatever order the trees list them', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { b: file('1\n') });
        const iTree = await treeOf(ctx, { a: file('A\n'), b: file('2\n') });
        const cTree = await treeOf(ctx, { a: file('other\n'), keep: file('k\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['a', 'b'] });
      });
    });
  });

  describe('Given a sibling that applies next to a path that C cannot take', () => {
    describe('When the judge refuses', () => {
      it('Then no patched blob of the sibling is written', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { ok: file(lines(9)), bad: file('1\n') });
        const iTree = await treeOf(ctx, {
          ok: file(lines(9, { at: 5, to: 'L5' })),
          bad: file('2\n'),
        });
        const cTree = await treeOf(ctx, { ok: file(`top\n${lines(9)}`) });
        const patched = text(`top\n${lines(9, { at: 5, to: 'L5' })}`);
        const patchedId = await hashBlob(ctx, patched);
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['bad'] });
        await expect(readObject(ctx, patchedId)).rejects.toMatchObject({
          data: { code: 'OBJECT_NOT_FOUND', id: patchedId },
        });
      });
    });
  });

  describe('Given f marked -diff and changed in both I and C', () => {
    describe('When the judge runs', () => {
      it('Then f is refused as a binary file C did not leave untouched', async () => {
        // Arrange
        const ctx = await setup();
        const attributes = { '.gitattributes': file('f -diff\n') };
        const bTree = await treeOf(ctx, { ...attributes, f: file(lines(9)) });
        const iTree = await treeOf(ctx, { ...attributes, f: file(lines(9, { at: 5, to: 'L5' })) });
        const cTree = await treeOf(ctx, { ...attributes, f: file(`top\n${lines(9)}`) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['f'] });
      });
    });
  });

  describe('Given f marked diff and changed in both I and C', () => {
    describe('When the judge runs', () => {
      it('Then f is merged as text', async () => {
        // Arrange
        const ctx = await setup();
        const attributes = { '.gitattributes': file('f diff\n') };
        const bTree = await treeOf(ctx, { ...attributes, f: file(lines(9)) });
        const iTree = await treeOf(ctx, { ...attributes, f: file(lines(9, { at: 5, to: 'L5' })) });
        const cTree = await treeOf(ctx, { ...attributes, f: file(`top\n${lines(9)}`) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        expect(await blobAt(ctx, result.tree, 'f')).toBe(`top\n${lines(9, { at: 5, to: 'L5' })}`);
      });
    });
  });

  describe('Given two files created in I that C blocks with files of the same name as their directories', () => {
    describe('When the judge runs', () => {
      it('Then only the first clash in index order is refused', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { keep: file('k\n') });
        const iTree = await treeOf(ctx, {
          keep: file('k\n'),
          'm/y': file('Y\n'),
          'n/x': file('X\n'),
        });
        const cTree = await treeOf(ctx, { keep: file('k\n'), m: file('M\n'), n: file('N\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['m/y'] });
      });
    });
  });

  describe('Given an I holding both a file n and a directory n', () => {
    describe('When C holds neither', () => {
      it('Then the placement under the directory is refused as the clash', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { keep: file('k\n') });
        const iTree = await duplicateNameTree(ctx, 'n');
        const cTree = await treeOf(ctx, { keep: file('k\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['n/x'] });
      });
    });
  });

  describe('Given a file created in I under a .git directory', () => {
    describe('When the judge runs', () => {
      it('Then the path is refused before anything is written', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { keep: file('k\n') });
        const iTree = await hostileTree(ctx, '.git', 'x');
        const cTree = await treeOf(ctx, { keep: file('k\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['.git/x'] });
      });
    });
  });

  describe('Given a file x\\y created in I', () => {
    describe('When the host runs under Windows path syntax', () => {
      it('Then the path is refused as the Windows rules do', async () => {
        // Arrange
        const ctx = { ...(await setup()), windowsPathSyntax: true };
        const bTree = await treeOf(ctx, { f: file('f\n') });
        const iTree = await treeOf(ctx, { f: file('f\n'), 'x\\y': file('Y\n') });
        const cTree = await treeOf(ctx, { f: file('f\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['x\\y'] });
      });
    });
  });

  describe('Given a file removed in I that only B holds under a .git directory', () => {
    describe('When the judge runs', () => {
      it('Then the path is refused as absent from C', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await hostileTree(ctx, '.git', 'x');
        const iTree = await treeOf(ctx, { z: file('z\n') });
        const cTree = await treeOf(ctx, { keep: file('k\n') });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['.git/x'] });
      });
    });
  });

  describe('Given f changed in I that C holds at the base content', () => {
    describe('When I carries a blob the store cannot read', () => {
      it('Then the entry of I is taken without reading any blob', async () => {
        // Arrange
        const ctx = await setup();
        const absent = '2'.repeat(40) as ObjectId;
        const bTree = await treeOf(ctx, { f: file(lines(9)), g: file('g0\n') });
        const cTree = await treeOf(ctx, { f: file(lines(9)), g: file('g1\n') });
        const iTree = await synthesizeTreeFromIndex(ctx, [
          stage0Entry('f' as FilePath, absent, FILE_MODE.REGULAR),
          stage0Entry(
            'g' as FilePath,
            await hashBlob(ctx, text('g0\n'), { write: true }),
            FILE_MODE.REGULAR,
          ),
        ]);
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        const entry = (await flattenTree(ctx, result.tree)).entries.get('f' as FilePath);
        expect(entry?.id).toBe(absent);
      });
    });
  });

  describe('Given a binary file with text lines edited in I', () => {
    describe('When C appended a line', () => {
      it('Then f is refused as binary', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(`\0\n${lines(10)}`) });
        const iTree = await treeOf(ctx, { f: file(`\0\n${lines(10, { at: 6, to: 'L6' })}`) });
        const cTree = await treeOf(ctx, { f: file(`\0\n${lines(10)}tail\n`) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        expect(result).toStrictEqual({ kind: 'refused', paths: ['f'] });
      });
    });
  });

  describe('Given f marked diff, holding a NUL byte and changed in both I and C', () => {
    describe('When the judge runs', () => {
      it('Then f is merged as text', async () => {
        // Arrange
        const ctx = await setup();
        const attributes = { '.gitattributes': file('f diff\n') };
        const bTree = await treeOf(ctx, { ...attributes, f: file(`\0\n${lines(10)}`) });
        const iTree = await treeOf(ctx, {
          ...attributes,
          f: file(`\0\n${lines(10, { at: 6, to: 'L6' })}`),
        });
        const cTree = await treeOf(ctx, { ...attributes, f: file(`\0\n${lines(10)}tail\n`) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        expect(await blobAt(ctx, result.tree, 'f')).toBe(
          `\0\n${lines(10, { at: 6, to: 'L6' })}tail\n`,
        );
      });
    });
  });

  describe('Given a mode-only change of a binary file in I', () => {
    describe('When C changed its content', () => {
      it('Then the result holds the blob of C with the mode of I', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { bin: binary(1) });
        const iTree = await treeOf(ctx, { bin: binary(1, FILE_MODE.EXECUTABLE) });
        const cTree = await treeOf(ctx, { bin: binary(3) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        const entry = (await flattenTree(ctx, result.tree)).entries.get('bin' as FilePath);
        expect(entry?.mode).toBe(FILE_MODE.EXECUTABLE);
        expect(entry?.id).toBe(await hashBlob(ctx, new Uint8Array([0, 1, 2, 3])));
      });
    });
  });

  describe('Given a text edit and a mode change of f in I', () => {
    describe('When C holds f at its base mode with a line added on top', () => {
      it('Then the patched f takes the mode of I', async () => {
        // Arrange
        const ctx = await setup();
        const bTree = await treeOf(ctx, { f: file(lines(9)) });
        const iTree = await treeOf(ctx, {
          f: file(lines(9, { at: 5, to: 'L5' }), FILE_MODE.EXECUTABLE),
        });
        const cTree = await treeOf(ctx, { f: file(`top\n${lines(9)}`) });
        const sut = judgeStagedPatch;

        // Act
        const result = await sut(ctx, { bTree, cTree, iTree });

        // Assert
        if (result.kind !== 'applies') throw new Error('expected applies');
        expect(await modeAt(ctx, result.tree, 'f')).toBe(FILE_MODE.EXECUTABLE);
        expect(await blobAt(ctx, result.tree, 'f')).toBe(`top\n${lines(9, { at: 5, to: 'L5' })}`);
      });
    });
  });
});
