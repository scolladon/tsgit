import { describe, expect, it } from 'vitest';
import type { NotesTrie, Slot } from '../../../../src/domain/notes/index.js';
import {
  constructPathWithFanout,
  constructSubtreePath,
  determineFanout,
  EMPTY_SLOT,
  parseFanoutPath,
} from '../../../../src/domain/notes/index.js';
import { ObjectId } from '../../../../src/domain/objects/index.js';

const anyOid = ObjectId.from('a'.repeat(40));
const subtreeSlot = (prefix: string): Slot => ({ kind: 'subtree', prefix, oid: anyOid });
const internalSlot = (node: NotesTrie): Slot => ({ kind: 'internal', node });
const noteSlot = (): Slot => ({ kind: 'note', key: anyOid, val: anyOid });

const emptyTrie = (): NotesTrie => ({
  slots: Array.from({ length: 16 }, () => EMPTY_SLOT),
  preserved: [],
});
const fill = (slot: Slot): NotesTrie => ({
  slots: Array.from({ length: 16 }, () => slot),
  preserved: [],
});
const withSlot = (base: NotesTrie, idx: number, slot: Slot): NotesTrie => ({
  ...base,
  slots: base.slots.map((s, i) => (i === idx ? slot : s)),
});

describe('Given the notes fanout heuristic', () => {
  describe('When n is odd and within depth and every slot is a branch', () => {
    it('Then it returns the unchanged fanout', () => {
      // Arrange
      const sut = determineFanout;
      // Act
      const result = sut(fill(subtreeSlot('00')), 1, 1);
      // Assert
      expect(result).toBe(1);
    });
  });

  describe('When n exceeds twice the fanout and every slot is a branch', () => {
    it('Then it returns the unchanged fanout', () => {
      // Arrange
      const sut = determineFanout;
      // Act
      const result = sut(fill(subtreeSlot('00')), 4, 1);
      // Assert
      expect(result).toBe(1);
    });
  });

  describe('When n equals twice the fanout and every slot is a subtree', () => {
    it('Then it deepens the fanout by one', () => {
      // Arrange
      const sut = determineFanout;
      // Act
      const result = sut(fill(subtreeSlot('0000')), 2, 1);
      // Assert
      expect(result).toBe(2);
    });
  });

  describe('When the flat root has every slot populated as a subtree', () => {
    it('Then it deepens the fanout to one', () => {
      // Arrange
      const sut = determineFanout;
      // Act
      const result = sut(fill(subtreeSlot('00')), 0, 0);
      // Assert
      expect(result).toBe(1);
    });
  });

  describe('When the flat root has every slot populated as an internal node', () => {
    it('Then it deepens the fanout to one', () => {
      // Arrange
      const sut = determineFanout;
      // Act
      const result = sut(fill(internalSlot(emptyTrie())), 0, 0);
      // Assert
      expect(result).toBe(1);
    });
  });

  describe('When every slot is a branch except one empty slot', () => {
    it('Then it returns the unchanged fanout', () => {
      // Arrange
      const sut = determineFanout;
      const node = withSlot(fill(subtreeSlot('00')), 5, EMPTY_SLOT);
      // Act
      const result = sut(node, 0, 0);
      // Assert
      expect(result).toBe(0);
    });
  });

  describe('When every slot is a branch except one note slot', () => {
    it('Then it returns the unchanged fanout', () => {
      // Arrange
      const sut = determineFanout;
      const node = withSlot(fill(subtreeSlot('00')), 5, noteSlot());
      // Act
      const result = sut(node, 0, 0);
      // Assert
      expect(result).toBe(0);
    });
  });
});

describe('Given an annotated oid path constructor', () => {
  const key = ObjectId.from(`abcd${'e'.repeat(36)}`);

  describe('When the fanout is zero', () => {
    it('Then it yields the flat full-hex name', () => {
      // Arrange
      const sut = constructPathWithFanout;
      // Act
      const result = sut(key, 0);
      // Assert
      expect(result).toBe(`abcd${'e'.repeat(36)}`);
    });
  });

  describe('When the fanout is one', () => {
    it('Then the first byte becomes a directory component', () => {
      // Arrange
      const sut = constructPathWithFanout;
      // Act
      const result = sut(key, 1);
      // Assert
      expect(result).toBe(`ab/cd${'e'.repeat(36)}`);
    });
  });

  describe('When the fanout is two', () => {
    it('Then the first two bytes become directory components', () => {
      // Arrange
      const sut = constructPathWithFanout;
      // Act
      const result = sut(key, 2);
      // Assert
      expect(result).toBe(`ab/cd/${'e'.repeat(36)}`);
    });
  });
});

describe('Given a fanout path parser', () => {
  describe('When the path carries directory components', () => {
    it('Then it strips the separators back to the full-hex oid', () => {
      // Arrange
      const sut = parseFanoutPath;
      // Act
      const result = sut(`ab/cd/${'e'.repeat(36)}`);
      // Assert
      expect(result).toBe(`abcd${'e'.repeat(36)}`);
    });
  });

  describe('When the path is already flat', () => {
    it('Then it returns the same oid', () => {
      // Arrange
      const sut = parseFanoutPath;
      // Act
      const result = sut('a'.repeat(40));
      // Assert
      expect(result).toBe('a'.repeat(40));
    });
  });
});

describe('Given a subtree prefix path constructor', () => {
  describe('When the prefix is one byte', () => {
    it('Then it returns the single two-hex component', () => {
      // Arrange
      const sut = constructSubtreePath;
      // Act
      const result = sut('ab');
      // Assert
      expect(result).toBe('ab');
    });
  });

  describe('When the prefix is two bytes', () => {
    it('Then it joins the two-hex components with a separator', () => {
      // Arrange
      const sut = constructSubtreePath;
      // Act
      const result = sut('abcd');
      // Assert
      expect(result).toBe('ab/cd');
    });
  });
});
