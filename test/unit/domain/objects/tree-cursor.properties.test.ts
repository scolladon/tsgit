import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SHA1_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Tree, TreeEntry } from '../../../../src/domain/objects/tree.js';
import {
  parseTreeContent,
  serializeTreeContent,
  treeEntryCompare,
} from '../../../../src/domain/objects/tree.js';
import {
  advanceCursor,
  compareCursorNames,
  cursorMode,
  cursorName,
  cursorOid,
  openTreeCursor,
} from '../../../../src/domain/objects/tree-cursor.js';
import { arbTreeEntryAnyMode, dedupeTreeEntriesByName } from './arbitraries.js';

const DUMMY_ID = ObjectId.from('a'.repeat(40));

function buildTree(entries: ReadonlyArray<TreeEntry>): Tree {
  return { type: 'tree', id: DUMMY_ID, entries };
}

interface WalkedEntry {
  readonly mode: TreeEntry['mode'];
  readonly name: string;
  readonly id: TreeEntry['id'];
}

function walkAll(content: Uint8Array): WalkedEntry[] {
  const walked: WalkedEntry[] = [];
  const cursor = openTreeCursor(content, SHA1_CONFIG);
  while (!cursor.done) {
    walked.push({ mode: cursorMode(cursor), name: cursorName(cursor), id: cursorOid(cursor) });
    advanceCursor(cursor);
  }
  return walked;
}

describe('tree-cursor — property-based tests', () => {
  describe('Given an arbitrary deduped tree serialized to canonical bytes', () => {
    describe('When walking the raw cursor over its content', () => {
      it('Then it yields the same (mode, name, oid) sequence as parseTreeContent', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(fc.array(arbTreeEntryAnyMode()), (rawEntries) => {
            const entries = dedupeTreeEntriesByName(rawEntries);
            const content = serializeTreeContent(buildTree(entries), SHA1_CONFIG);
            const parsed = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

            const sut = walkAll;
            const result = sut(content);

            expect(result).toEqual(
              parsed.entries.map(({ mode, name, id }) => ({ mode, name, id })),
            );
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given two arbitrary single-entry trees', () => {
    describe('When comparing their cursors and their parsed entries', () => {
      it('Then the sign of compareCursorNames matches the sign of treeEntryCompare', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(arbTreeEntryAnyMode(), arbTreeEntryAnyMode(), (entryA, entryB) => {
            const contentA = serializeTreeContent(buildTree([entryA]), SHA1_CONFIG);
            const contentB = serializeTreeContent(buildTree([entryB]), SHA1_CONFIG);
            const cursorA = openTreeCursor(contentA, SHA1_CONFIG);
            const cursorB = openTreeCursor(contentB, SHA1_CONFIG);

            const sut = compareCursorNames;
            const result = sut(cursorA, cursorB);

            expect(Math.sign(result)).toBe(Math.sign(treeEntryCompare(entryA, entryB)));
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary deduped tree serialized to canonical bytes', () => {
    describe('When walking the raw cursor to completion', () => {
      it('Then it never throws', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(fc.array(arbTreeEntryAnyMode()), (rawEntries) => {
            const entries = dedupeTreeEntriesByName(rawEntries);
            const content = serializeTreeContent(buildTree(entries), SHA1_CONFIG);

            const sut = walkAll;

            expect(() => sut(content)).not.toThrow();
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
