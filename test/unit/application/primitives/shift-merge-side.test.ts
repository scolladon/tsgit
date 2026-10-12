import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { flattenTree } from '../../../../src/application/primitives/flatten-tree.js';
import * as readTreeModule from '../../../../src/application/primitives/read-tree.js';
import { shiftMergeSide } from '../../../../src/application/primitives/shift-merge-side.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  FILE_MODE,
  type ObjectId,
  type TreeEntry,
  treeEntry,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const blob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', content: enc(content), id: '' as ObjectId });
const tree = (ctx: Context, entries: ReadonlyArray<TreeEntry>): Promise<ObjectId> =>
  writeObject(ctx, { type: 'tree', entries, id: '' as ObjectId });

/** Host `{lib/sub/{a,b}, top}` and the bare subproject `{a', b}`. */
async function fixture(ctx: Context) {
  const [a, a2, b, t] = await Promise.all(['a\n', 'a2\n', 'b\n', 't\n'].map((c) => blob(ctx, c)));
  const project = await tree(ctx, [
    treeEntry(FILE_MODE.REGULAR, 'a', a!),
    treeEntry(FILE_MODE.REGULAR, 'b', b!),
  ]);
  const lib = await tree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', project)]);
  const host = await tree(ctx, [
    treeEntry(FILE_MODE.DIRECTORY, 'lib', lib),
    treeEntry(FILE_MODE.REGULAR, 'top', t!),
  ]);
  const side = await tree(ctx, [
    treeEntry(FILE_MODE.REGULAR, 'a', a2!),
    treeEntry(FILE_MODE.REGULAR, 'b', b!),
  ]);
  return { host, side };
}

const pathsOf = (flat: { readonly entries: ReadonlyMap<string, unknown> } | undefined) =>
  flat === undefined ? undefined : [...flat.entries.keys()].sort();

describe('shiftMergeSide', () => {
  describe.each([
    ['a guessed shift onto the subproject', 'host', 'side', '', ['lib/sub/a', 'lib/sub/b', 'top']],
    [
      'a named shift onto the subproject',
      'host',
      'side',
      'lib/sub/',
      ['lib/sub/a', 'lib/sub/b', 'top'],
    ],
    ['a named shift out of the host', 'side', 'host', 'lib/sub', ['a', 'b']],
    ['a named shift neither tree has', 'host', 'side', 'nope', ['a', 'b']],
  ] as const)('Given %s', (_label, ours, theirs, shift, expected) => {
    describe('When the side is shifted', () => {
      it('Then its paths are re-rooted as git reshapes the tree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const trees = await fixture(ctx);
        const sut = shiftMergeSide;
        const ourFlat = await flattenTree(ctx, trees[ours]);
        const sideFlat = await flattenTree(ctx, trees[theirs]);

        // Act
        const result = await sut(
          ctx,
          { tree: trees[ours], flat: ourFlat },
          { tree: trees[theirs], flat: sideFlat },
          shift,
        );

        // Assert
        expect(pathsOf(result)).toEqual(expected);
      });
    });
  });

  describe('Given no side tree', () => {
    describe('When a guessed shift splices the empty tree in', () => {
      it('Then the host loses the subproject’s paths', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { host } = await fixture(ctx);
        const sut = shiftMergeSide;

        // Act
        const result = await sut(
          ctx,
          { tree: host, flat: await flattenTree(ctx, host) },
          { tree: undefined, flat: undefined },
          '',
        );

        // Assert
        expect(pathsOf(result)).toEqual(['top']);
      });
    });

    describe('When a named shift removes a prefix from it', () => {
      it('Then the side stays empty', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { side } = await fixture(ctx);
        const sut = shiftMergeSide;
        const host = await tree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'x', side)]);

        // Act
        const result = await sut(
          ctx,
          { tree: side, flat: await flattenTree(ctx, side) },
          { tree: host, flat: undefined },
          'x',
        );

        // Assert
        expect(pathsOf(result)).toEqual([]);
      });
    });
  });

  describe('Given a host and a side whose trees are scored more than once', () => {
    describe('When a guessed shift lists them', () => {
      it('Then each tree object is read once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { host, side } = await fixture(ctx);
        const hostFlat = await flattenTree(ctx, host);
        const sideFlat = await flattenTree(ctx, side);
        const readTree = vi.spyOn(readTreeModule, 'readTree');
        const sut = shiftMergeSide;

        // Act
        await sut(ctx, { tree: host, flat: hostFlat }, { tree: side, flat: sideFlat }, '');

        // Assert
        const readIds = readTree.mock.calls.map(([, id]) => id);
        expect(readIds.length).toBeGreaterThan(0);
        expect(readIds).toEqual([...new Set(readIds)]);
      });
    });
  });
});
