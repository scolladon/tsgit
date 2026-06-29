import { describe, expect, it, vi } from 'vitest';
import type { NotesTrie, Slot, SubtreeReader } from '../../../../src/domain/notes/index.js';
import {
  createEmptyTrie,
  insert,
  loadTrieRoot,
  planWrite,
  setSlot,
} from '../../../../src/domain/notes/index.js';
import { FILE_MODE, ObjectId } from '../../../../src/domain/objects/index.js';

const oid = (s: string) => ObjectId.from(s);
const oid40 = (c: string) => ObjectId.from(c.repeat(40));
const val = oid40('e');
const never = (): SubtreeReader => vi.fn<SubtreeReader>();

describe('Given a flat notes trie to write', () => {
  describe('When the keys land in distinct slots', () => {
    const a = oid40('1');
    const b = oid40('2');

    it('Then each note is emitted with its full-hex name and never reads a subtree', async () => {
      // Arrange
      const sut = planWrite;
      const read = never();
      const trie = await insert(await insert(createEmptyTrie(), a, val, read), b, oid40('b'), read);
      // Act
      const result = await sut(trie, read);
      // Assert
      expect(read).not.toHaveBeenCalled();
      expect(result.entries).toEqual([
        { name: a, mode: FILE_MODE.REGULAR, oid: val },
        { name: b, mode: FILE_MODE.REGULAR, oid: oid40('b') },
      ]);
    });
  });

  describe('When colliding keys produce an internal node but the tree stays flat', () => {
    const a = oid(`ab1${'0'.repeat(37)}`);
    const b = oid(`ab5${'0'.repeat(37)}`);

    it('Then the notes are still emitted with their full-hex names', async () => {
      // Arrange
      const sut = planWrite;
      const trie = await insert(
        await insert(createEmptyTrie(), a, val, never()),
        b,
        oid40('b'),
        never(),
      );
      // Act
      const result = await sut(trie, never());
      // Assert
      const names = result.entries.map((entry) => entry.name).sort();
      expect(names).toEqual([a, b].sort());
      expect(result.entries.every((entry) => entry.mode === FILE_MODE.REGULAR)).toBe(true);
    });
  });
});

describe('Given a sticky fanned notes trie', () => {
  const stickyTrie = (): NotesTrie => {
    const subtrees: Slot[] = Array.from({ length: 15 }, (_, i) => ({
      kind: 'subtree',
      prefix: `${i.toString(16)}0`,
      oid: oid40(i.toString(16)),
    }));
    const noteKey = oid(`f0${'0'.repeat(38)}`);
    const internalNode = setSlot(createEmptyTrie(), 0, { kind: 'note', key: noteKey, val });
    const slots: Slot[] = [...subtrees, { kind: 'internal', node: internalNode }];
    return { slots, preserved: [] };
  };

  describe('When the trie is written', () => {
    it('Then the untouched subtrees are reused without being read', async () => {
      // Arrange
      const sut = planWrite;
      const read = never();
      // Act
      const result = await sut(stickyTrie(), read);
      // Assert
      expect(read).not.toHaveBeenCalled();
      const dirs = result.entries.filter((entry) => entry.mode === FILE_MODE.DIRECTORY);
      expect(dirs).toHaveLength(15);
      expect(dirs[0]).toEqual({ name: '00', mode: FILE_MODE.DIRECTORY, oid: oid40('0') });
    });

    it('Then the loaded internal note is emitted at one-byte fanout', async () => {
      // Arrange
      const sut = planWrite;
      // Act
      const result = await sut(stickyTrie(), never());
      // Assert
      const notes = result.entries.filter((entry) => entry.mode === FILE_MODE.REGULAR);
      expect(notes).toEqual([{ name: `f0/${'0'.repeat(38)}`, mode: FILE_MODE.REGULAR, oid: val }]);
    });
  });
});

describe('Given a flat trie carrying a stray subtree', () => {
  const subtreeOid = oid40('f');
  const innerBlob = oid40('a');
  const buildTrie = () =>
    loadTrieRoot([
      { mode: FILE_MODE.DIRECTORY, name: '00', id: subtreeOid },
      { mode: FILE_MODE.REGULAR, name: `1${'0'.repeat(39)}`, id: oid40('c') },
    ]);

  describe('When it is written below the fanout threshold', () => {
    it('Then the stray subtree is unpacked and its note flattened to the top level', async () => {
      // Arrange
      const sut = planWrite;
      const read = vi.fn<SubtreeReader>(async () => [
        { mode: FILE_MODE.REGULAR, name: '0'.repeat(38), id: innerBlob },
      ]);
      // Act
      const result = await sut(buildTrie(), read);
      // Assert
      expect(read).toHaveBeenCalledWith(subtreeOid);
      const names = result.entries.map((entry) => entry.name).sort();
      expect(names).toEqual([`00${'0'.repeat(38)}`, `1${'0'.repeat(39)}`].sort());
    });
  });

  describe('When the unpacked subtree carries a preserved entry', () => {
    it('Then the preserved entry keeps its directory-qualified name', async () => {
      // Arrange
      const sut = planWrite;
      const readmeId = oid40('d');
      const read = vi.fn<SubtreeReader>(async () => [
        { mode: FILE_MODE.REGULAR, name: '0'.repeat(38), id: innerBlob },
        { mode: FILE_MODE.REGULAR, name: 'README', id: readmeId },
      ]);
      // Act
      const result = await sut(buildTrie(), read);
      // Assert
      expect(result.entries).toContainEqual({
        name: '00/README',
        mode: FILE_MODE.REGULAR,
        oid: readmeId,
      });
    });
  });
});

describe('Given a notes trie with a preserved non-note entry', () => {
  describe('When it is written', () => {
    it('Then the preserved entry is emitted verbatim at the root level', async () => {
      // Arrange
      const sut = planWrite;
      const readmeId = oid40('d');
      const trie = loadTrieRoot([{ mode: FILE_MODE.REGULAR, name: 'README', id: readmeId }]);
      // Act
      const result = await sut(trie, never());
      // Assert
      expect(result.entries).toContainEqual({
        name: 'README',
        mode: FILE_MODE.REGULAR,
        oid: readmeId,
      });
    });
  });
});

describe('Given an internal node wrapping a stray subtree', () => {
  describe('When the writer recurses into the internal slot', () => {
    it('Then it threads the deeper child depth so the nested subtree is unpacked', async () => {
      // Arrange
      const sut = planWrite;
      const subtreeOid = oid40('f');
      const innerBlob = oid40('a');
      const innerNode = setSlot(createEmptyTrie(), 0, {
        kind: 'subtree',
        prefix: '00',
        oid: subtreeOid,
      });
      const trie = setSlot(createEmptyTrie(), 0, { kind: 'internal', node: innerNode });
      const read = vi.fn<SubtreeReader>(async () => [
        { mode: FILE_MODE.REGULAR, name: '0'.repeat(38), id: innerBlob },
      ]);
      // Act
      await sut(trie, read);
      // Assert
      expect(read).toHaveBeenCalledWith(subtreeOid);
    });
  });
});
