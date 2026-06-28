import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { NotesTrie, SubtreeReader } from '../../../../src/domain/notes/index.js';
import {
  constructPathWithFanout,
  createEmptyTrie,
  insert,
  loadTrieRoot,
  parseFanoutPath,
  planWrite,
} from '../../../../src/domain/notes/index.js';
import { arbDistinctOids, arbFanout, arbOid, arbRootEntries } from './arbitraries.js';

const countNotes = (trie: NotesTrie): number =>
  trie.slots.reduce(
    (total, slot) =>
      total + (slot.kind === 'note' ? 1 : slot.kind === 'internal' ? countNotes(slot.node) : 0),
    0,
  );

describe('Given the fanout path codec', () => {
  describe('When an oid is laid out at an arbitrary fanout', () => {
    it('Then parsing the constructed path recovers the oid', () => {
      // Arrange
      const sut = constructPathWithFanout;
      // Act / Assert
      fc.assert(
        fc.property(
          arbOid(),
          arbFanout(),
          (oid, fanout) => parseFanoutPath(sut(oid, fanout)) === oid,
        ),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given a well-formed root notes tree', () => {
  describe('When it is loaded', () => {
    it('Then loading is total, preserves non-note entries, and keeps every note', () => {
      // Arrange
      const sut = loadTrieRoot;
      // Act / Assert
      fc.assert(
        fc.property(arbRootEntries(), (spec) => {
          const trie = sut(spec.entries);
          expect(countNotes(trie)).toBe(spec.noteCount);
          expect(trie.preserved).toEqual(spec.preserved);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a sequence of distinct notes inserted into an empty trie', () => {
  describe('When the trie is planned for writing', () => {
    it('Then it emits exactly one entry per inserted note', () => {
      // Arrange
      const sut = planWrite;
      const read = vi.fn<SubtreeReader>();
      // Act / Assert
      return fc.assert(
        fc.asyncProperty(arbDistinctOids(), async (oids) => {
          let trie = createEmptyTrie();
          for (const oid of oids) {
            trie = await insert(trie, oid, oid, read);
          }
          const plan = await sut(trie, read);
          expect(read).not.toHaveBeenCalled();
          return plan.entries.length === oids.length;
        }),
        { numRuns: 100 },
      );
    });
  });
});
