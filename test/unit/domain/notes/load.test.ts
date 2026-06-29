import { describe, expect, it, vi } from 'vitest';
import type { InternalSlot } from '../../../../src/domain/notes/index.js';
import { loadTrieRoot, unpackSubtree } from '../../../../src/domain/notes/index.js';
import type { TreeEntry } from '../../../../src/domain/objects/index.js';
import { FILE_MODE, ObjectId } from '../../../../src/domain/objects/index.js';

const oid = (c: string) => ObjectId.from(c.repeat(40));

describe('Given a root notes tree to load', () => {
  describe('When it mixes a note blob, a fanout directory and non-note entries', () => {
    const noteName = `1${'0'.repeat(39)}`;
    const noteBlob = oid('a');
    const subtreeOid = oid('b');
    const readmeId = oid('c');
    const subdirId = oid('d');
    const entries: TreeEntry[] = [
      { mode: FILE_MODE.REGULAR, name: noteName, id: noteBlob },
      { mode: FILE_MODE.DIRECTORY, name: '2a', id: subtreeOid },
      { mode: FILE_MODE.REGULAR, name: 'README', id: readmeId },
      { mode: FILE_MODE.DIRECTORY, name: 'sub', id: subdirId },
    ];

    it('Then the blob becomes a note in its nibble slot', () => {
      // Arrange
      const sut = loadTrieRoot;
      // Act
      const result = sut(entries);
      // Assert
      expect(result.slots[1]).toEqual({
        kind: 'note',
        key: ObjectId.from(noteName),
        val: noteBlob,
      });
    });

    it('Then the two-hex directory becomes a lazy subtree placeholder', () => {
      // Arrange
      const sut = loadTrieRoot;
      // Act
      const result = sut(entries);
      // Assert
      expect(result.slots[2]).toEqual({ kind: 'subtree', prefix: '2a', oid: subtreeOid });
    });

    it('Then the non-note entries are preserved verbatim in order', () => {
      // Arrange
      const sut = loadTrieRoot;
      // Act
      const result = sut(entries);
      // Assert
      expect(result.preserved).toEqual([
        { mode: FILE_MODE.REGULAR, name: 'README', id: readmeId },
        { mode: FILE_MODE.DIRECTORY, name: 'sub', id: subdirId },
      ]);
    });
  });

  describe('When several fanout directories share a first nibble', () => {
    const o1 = oid('1');
    const o2 = oid('2');
    const o3 = oid('3');
    const entries: TreeEntry[] = [
      { mode: FILE_MODE.DIRECTORY, name: 'a1', id: o1 },
      { mode: FILE_MODE.DIRECTORY, name: 'a2', id: o2 },
      { mode: FILE_MODE.DIRECTORY, name: 'a3', id: o3 },
    ];

    it('Then they split into an internal node keyed by their second nibble', () => {
      // Arrange
      const sut = loadTrieRoot;
      // Act
      const result = sut(entries);
      // Assert
      const branch = result.slots[10] as InternalSlot;
      expect(branch.kind).toBe('internal');
      expect(branch.node.slots[1]).toEqual({ kind: 'subtree', prefix: 'a1', oid: o1 });
      expect(branch.node.slots[2]).toEqual({ kind: 'subtree', prefix: 'a2', oid: o2 });
      expect(branch.node.slots[3]).toEqual({ kind: 'subtree', prefix: 'a3', oid: o3 });
    });
  });
});

describe('Given a lazy subtree placeholder', () => {
  describe('When the root tree is loaded', () => {
    it('Then loading never reads the subtree contents', () => {
      // Arrange
      const sut = loadTrieRoot;
      const read = vi.fn();
      // Act
      sut([{ mode: FILE_MODE.DIRECTORY, name: '2a', id: oid('b') }]);
      // Assert
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('When it is unpacked on demand', () => {
    it('Then its entries are classified at the consumed prefix', async () => {
      // Arrange
      const sut = unpackSubtree;
      const subtreeOid = oid('f');
      const noteBlob = oid('a');
      const read = vi.fn(async () => [
        { mode: FILE_MODE.REGULAR, name: '0'.repeat(38), id: noteBlob },
      ]);
      // Act
      const result = await sut({ kind: 'subtree', prefix: 'ab', oid: subtreeOid }, read);
      // Assert
      expect(read).toHaveBeenCalledWith(subtreeOid);
      expect(result.slots[0]).toEqual({
        kind: 'note',
        key: ObjectId.from(`ab${'0'.repeat(38)}`),
        val: noteBlob,
      });
    });
  });
});
