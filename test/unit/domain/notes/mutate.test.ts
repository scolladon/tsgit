import { describe, expect, it, vi } from 'vitest';
import type { InternalSlot, NoteSlot, SubtreeReader } from '../../../../src/domain/notes/index.js';
import {
  chainGap,
  createEmptyTrie,
  EMPTY_SLOT,
  insert,
  lookup,
  remove,
  setSlot,
} from '../../../../src/domain/notes/index.js';
import { FILE_MODE, ObjectId } from '../../../../src/domain/objects/index.js';

const oid = (s: string) => ObjectId.from(s);
const oid40 = (c: string) => ObjectId.from(c.repeat(40));
const val = oid40('e');
const never = (): SubtreeReader => vi.fn<SubtreeReader>();

const subtreeOid = oid40('f');
const noteBlob = oid40('a');
const insideKey = oid(`1a${'b'.repeat(38)}`);
const subtreeReader = (): SubtreeReader =>
  vi.fn<SubtreeReader>(async () => [
    { mode: FILE_MODE.REGULAR, name: 'b'.repeat(38), id: noteBlob },
  ]);
const lazyTrie = () =>
  setSlot(createEmptyTrie(), 1, { kind: 'subtree', prefix: '1a', oid: subtreeOid });

describe('Given an insert into the notes trie', () => {
  describe('When a note is added to an empty trie', () => {
    it('Then a later lookup returns its value', async () => {
      // Arrange
      const sut = insert;
      const key = oid40('1');
      // Act
      const trie = await sut(createEmptyTrie(), key, val, never());
      // Assert
      expect(await lookup(trie, key, never())).toBe(val);
    });
  });

  describe('When two keys share their leading nibbles', () => {
    const a = oid(`ab1${'0'.repeat(37)}`);
    const b = oid(`ab5${'0'.repeat(37)}`);

    it('Then both are found after the trie splits down to the first differing nibble', async () => {
      // Arrange
      const sut = insert;
      // Act
      const trie = await sut(await sut(createEmptyTrie(), a, val, never()), b, oid40('b'), never());
      // Assert
      expect(await lookup(trie, a, never())).toBe(val);
      expect(await lookup(trie, b, never())).toBe(oid40('b'));
    });
  });

  describe('When the same key is inserted twice', () => {
    it('Then the latest value overwrites the former', async () => {
      // Arrange
      const sut = insert;
      const key = oid40('2');
      // Act
      const trie = await sut(
        await sut(createEmptyTrie(), key, val, never()),
        key,
        oid40('c'),
        never(),
      );
      // Assert
      expect(await lookup(trie, key, never())).toBe(oid40('c'));
    });
  });

  describe('When the target slot holds a lazy subtree covering the key', () => {
    it('Then the subtree is read once and both notes are reachable', async () => {
      // Arrange
      const sut = insert;
      const read = subtreeReader();
      const newKey = oid(`1a${'c'.repeat(38)}`);
      // Act
      const trie = await sut(lazyTrie(), newKey, val, read);
      // Assert
      expect(read).toHaveBeenCalledWith(subtreeOid);
      expect(await lookup(trie, newKey, subtreeReader())).toBe(val);
      expect(await lookup(trie, insideKey, subtreeReader())).toBe(noteBlob);
    });
  });

  describe('When the target slot holds a lazy subtree not covering the key', () => {
    const outsideKey = oid(`1f${'0'.repeat(38)}`);

    it('Then the subtree is split lazily without being read', async () => {
      // Arrange
      const sut = insert;
      const read = subtreeReader();
      // Act
      const trie = await sut(lazyTrie(), outsideKey, val, read);
      // Assert
      expect(read).not.toHaveBeenCalled();
      expect(await lookup(trie, outsideKey, never())).toBe(val);
    });
  });
});

describe('Given a lookup in the notes trie', () => {
  describe('When the slot is empty', () => {
    it('Then it returns undefined', async () => {
      // Arrange
      const sut = lookup;
      // Act
      const result = await sut(createEmptyTrie(), oid40('1'), never());
      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('When the slot holds a different key', () => {
    it('Then it returns undefined', async () => {
      // Arrange
      const sut = lookup;
      const trie = await insert(createEmptyTrie(), oid(`a1${'0'.repeat(38)}`), val, never());
      // Act
      const result = await sut(trie, oid(`a5${'0'.repeat(38)}`), never());
      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('When the key lives inside a lazy subtree', () => {
    it('Then the subtree is read and the note value is returned', async () => {
      // Arrange
      const sut = lookup;
      const read = subtreeReader();
      // Act
      const result = await sut(lazyTrie(), insideKey, read);
      // Assert
      expect(read).toHaveBeenCalledWith(subtreeOid);
      expect(result).toBe(noteBlob);
    });
  });

  describe('When the key shares a slot with a subtree it is not under', () => {
    it('Then it returns undefined without reading the subtree', async () => {
      // Arrange
      const sut = lookup;
      const read = subtreeReader();
      // Act
      const result = await sut(lazyTrie(), oid(`1f${'0'.repeat(38)}`), read);
      // Assert
      expect(read).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });
});

describe('Given a removal from the notes trie', () => {
  describe('When the matching note is in its own slot', () => {
    it('Then the note becomes unreachable', async () => {
      // Arrange
      const sut = remove;
      const key = oid40('1');
      const trie = await insert(createEmptyTrie(), key, val, never());
      // Act
      const result = await sut(trie, key, never());
      // Assert
      expect(await lookup(result, key, never())).toBeUndefined();
    });
  });

  describe('When a different key occupies the slot', () => {
    it('Then the trie is returned unchanged', async () => {
      // Arrange
      const sut = remove;
      const trie = await insert(createEmptyTrie(), oid(`a1${'0'.repeat(38)}`), val, never());
      const read = never();
      // Act
      const result = await sut(trie, oid(`a5${'0'.repeat(38)}`), read);
      // Assert
      expect(result).toEqual(trie);
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('When the slot is empty', () => {
    it('Then the trie is returned unchanged', async () => {
      // Arrange
      const sut = remove;
      const trie = createEmptyTrie();
      // Act
      const result = await sut(trie, oid40('1'), never());
      // Assert
      expect(result).toEqual(trie);
    });
  });

  describe('When one member of a colliding pair is removed', () => {
    const a = oid(`a1${'0'.repeat(38)}`);
    const b = oid(`a5${'0'.repeat(38)}`);

    it('Then the surviving note consolidates back into the parent slot', async () => {
      // Arrange
      const sut = remove;
      const trie = await insert(
        await insert(createEmptyTrie(), a, val, never()),
        b,
        oid40('b'),
        never(),
      );
      // Act
      const result = await sut(trie, a, never());
      // Assert
      expect(result.slots[10]).toEqual<NoteSlot>({ kind: 'note', key: b, val: oid40('b') });
    });
  });

  describe('When a slot keeps more than one member after removal', () => {
    const a = oid(`a1${'0'.repeat(38)}`);
    const b = oid(`a5${'0'.repeat(38)}`);
    const c = oid(`a9${'0'.repeat(38)}`);

    it('Then the internal node is retained', async () => {
      // Arrange
      const sut = remove;
      let trie = await insert(createEmptyTrie(), a, val, never());
      trie = await insert(trie, b, oid40('b'), never());
      trie = await insert(trie, c, oid40('c'), never());
      // Act
      const result = await sut(trie, a, never());
      // Assert
      expect((result.slots[10] as InternalSlot).kind).toBe('internal');
      expect(await lookup(result, b, never())).toBe(oid40('b'));
      expect(await lookup(result, c, never())).toBe(oid40('c'));
      expect(await lookup(result, a, never())).toBeUndefined();
    });
  });

  describe('When a slot is left with a single internal child', () => {
    const a = oid(`a10${'0'.repeat(37)}`);
    const b = oid(`a15${'0'.repeat(37)}`);
    const c = oid(`a90${'0'.repeat(37)}`);

    it('Then the internal node is not lifted', async () => {
      // Arrange
      const sut = remove;
      let trie = await insert(createEmptyTrie(), a, val, never());
      trie = await insert(trie, b, oid40('b'), never());
      trie = await insert(trie, c, oid40('c'), never());
      // Act
      const result = await sut(trie, c, never());
      // Assert
      expect((result.slots[10] as InternalSlot).kind).toBe('internal');
      expect(await lookup(result, a, never())).toBe(val);
      expect(await lookup(result, b, never())).toBe(oid40('b'));
      expect(await lookup(result, c, never())).toBeUndefined();
    });
  });

  describe('When the only note inside a lazy subtree is removed', () => {
    it('Then the subtree is read and its slot empties', async () => {
      // Arrange
      const sut = remove;
      const read = subtreeReader();
      // Act
      const result = await sut(lazyTrie(), insideKey, read);
      // Assert
      expect(read).toHaveBeenCalledWith(subtreeOid);
      expect(await lookup(result, insideKey, subtreeReader())).toBeUndefined();
    });

    it('Then the emptied slot collapses to empty, not a hollow internal node', async () => {
      // Arrange
      const sut = remove;
      const read = subtreeReader();
      // Act
      const result = await sut(lazyTrie(), insideKey, read);
      // Assert
      expect(result.slots[1]).toEqual(EMPTY_SLOT);
    });
  });

  describe('When the key shares a slot with a subtree it is not under', () => {
    it('Then the trie is returned unchanged without reading the subtree', async () => {
      // Arrange
      const sut = remove;
      const trie = lazyTrie();
      const read = subtreeReader();
      // Act
      const result = await sut(trie, oid(`1f${'0'.repeat(38)}`), read);
      // Assert
      expect(result).toEqual(trie);
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('When the removed note shared its subtree with a preserved entry', () => {
    it('Then the subtree node is retained to keep the preserved entry', async () => {
      // Arrange
      const sut = remove;
      const read = vi.fn<SubtreeReader>(async () => [
        { mode: FILE_MODE.REGULAR, name: 'b'.repeat(38), id: noteBlob },
        { mode: FILE_MODE.REGULAR, name: 'README', id: oid40('d') },
      ]);
      // Act
      const result = await sut(lazyTrie(), insideKey, read);
      // Assert
      expect(read).toHaveBeenCalledWith(subtreeOid);
      expect((result.slots[1] as InternalSlot).kind).toBe('internal');
      expect(await lookup(result, insideKey, subtreeReader())).toBeUndefined();
    });
  });
});

describe('Given the subtree chain-gap builder', () => {
  describe('When the prefix spans more nibbles than the entry depth consumes', () => {
    it('Then it nests one single-child internal per consumed nibble down to the node', () => {
      // Arrange
      const sut = chainGap;
      // Act
      const result = sut(createEmptyTrie(), '1a2b', 0);
      // Assert
      expect(result.kind).toBe('internal');
      if (result.kind === 'internal') {
        expect(result.node.slots[10]?.kind).toBe('internal');
      }
    });
  });
});
