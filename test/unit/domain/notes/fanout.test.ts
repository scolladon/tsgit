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
  describe('When determining the fanout for a node', () => {
    it.each([
      {
        label: 'n is odd and within depth and every slot is a branch returns the unchanged fanout',
        buildNode: () => fill(subtreeSlot('00')),
        n: 1,
        fanout: 1,
        expected: 1,
      },
      {
        label: 'n exceeds twice the fanout and every slot is a branch returns the unchanged fanout',
        buildNode: () => fill(subtreeSlot('00')),
        n: 4,
        fanout: 1,
        expected: 1,
      },
      {
        label: 'n equals twice the fanout and every slot is a subtree deepens the fanout by one',
        buildNode: () => fill(subtreeSlot('0000')),
        n: 2,
        fanout: 1,
        expected: 2,
      },
      {
        label: 'the flat root has every slot populated as a subtree deepens the fanout to one',
        buildNode: () => fill(subtreeSlot('00')),
        n: 0,
        fanout: 0,
        expected: 1,
      },
      {
        label:
          'the flat root has every slot populated as an internal node deepens the fanout to one',
        buildNode: () => fill(internalSlot(emptyTrie())),
        n: 0,
        fanout: 0,
        expected: 1,
      },
      {
        label: 'every slot is a branch except one empty slot returns the unchanged fanout',
        buildNode: () => withSlot(fill(subtreeSlot('00')), 5, EMPTY_SLOT),
        n: 0,
        fanout: 0,
        expected: 0,
      },
      {
        label: 'every slot is a branch except one note slot returns the unchanged fanout',
        buildNode: () => withSlot(fill(subtreeSlot('00')), 5, noteSlot()),
        n: 0,
        fanout: 0,
        expected: 0,
      },
      {
        label:
          'n equals twice a fanout of two and every slot is a branch deepens the fanout to three',
        buildNode: () => fill(subtreeSlot('00')),
        n: 2,
        fanout: 2,
        expected: 3,
      },
    ])('Then $label', ({ buildNode, n, fanout, expected }) => {
      // Arrange
      const sut = determineFanout;
      const node = buildNode();

      // Act
      const result = sut(node, n, fanout);

      // Assert
      expect(result).toBe(expected);
    });
  });
});

describe('Given an annotated oid path constructor', () => {
  const key = ObjectId.from(`abcd${'e'.repeat(36)}`);

  describe('When constructed at a given fanout', () => {
    it.each([
      {
        label: 'a fanout of zero yields the flat full-hex name',
        fanout: 0,
        expected: `abcd${'e'.repeat(36)}`,
      },
      {
        label: 'a fanout of one turns the first byte into a directory component',
        fanout: 1,
        expected: `ab/cd${'e'.repeat(36)}`,
      },
      {
        label: 'a fanout of two turns the first two bytes into directory components',
        fanout: 2,
        expected: `ab/cd/${'e'.repeat(36)}`,
      },
    ])('Then $label', ({ fanout, expected }) => {
      // Arrange
      const sut = constructPathWithFanout;

      // Act
      const result = sut(key, fanout);

      // Assert
      expect(result).toBe(expected);
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
