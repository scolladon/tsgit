import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { diffTrees } from '../../../../src/domain/diff/tree-diff.js';
import { SHA1_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Tree, TreeEntry } from '../../../../src/domain/objects/tree.js';
import {
  parseTreeContent,
  serializeTreeContent,
  sortTreeEntries,
  treeEntryCompare,
} from '../../../../src/domain/objects/tree.js';
import {
  arbTreeEntryAnyMode,
  arbTreeEntryRawName,
  dedupeTreeEntriesByName,
} from './arbitraries.js';

const DUMMY_ID = ObjectId.from('a'.repeat(40));

function buildTree(entries: ReadonlyArray<TreeEntry>): Tree {
  return { type: 'tree', id: DUMMY_ID, entries };
}

function parseBuilt(entries: ReadonlyArray<TreeEntry>): Tree {
  const content = serializeTreeContent(buildTree(entries), SHA1_CONFIG);
  return parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);
}

describe('tree — property-based tests', () => {
  describe('Given the sort idempotence property "sort(sort(entries)) equals sort(entries)"', () => {
    describe('When checked', () => {
      it('Then it holds', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(fc.array(arbTreeEntryAnyMode()), (entries) => {
            const sorted = sortTreeEntries(entries);
            const resorted = sortTreeEntries([...sorted]);
            expect(resorted).toEqual(sorted);
          }),
        );
      });
    });
  });

  describe('Given the sort byte-consistency property "for adjacent sorted entries, treeEntryCompare(a, b) <= 0"', () => {
    describe('When checked', () => {
      it('Then it holds', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(fc.array(arbTreeEntryAnyMode(), { minLength: 2 }), (entries) => {
            const sorted = sortTreeEntries(entries);
            for (let i = 1; i < sorted.length; i++) {
              expect(treeEntryCompare(sorted[i - 1]!, sorted[i]!)).toBeLessThanOrEqual(0);
            }
          }),
        );
      });
    });
  });

  describe('Given the byte-name tree roundtrip property "parseTreeContent(id, serializeTreeContent(tree, hash), hash) preserves every entry\'s raw name bytes"', () => {
    describe('When checked', () => {
      it('Then it holds', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(fc.array(arbTreeEntryRawName()), (entries) => {
            const result = parseBuilt(entries);
            const sorted = sortTreeEntries(entries);
            const project = (list: ReadonlyArray<TreeEntry>) =>
              list.map(({ mode, nameBytes, id }) => ({ mode, nameBytes, id }));
            expect(project(result.entries)).toEqual(project(sorted));
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given the entry-count invariant "parseTreeContent(serializeTreeContent(t)).entries.length equals the input length" (duplicates included)', () => {
    describe('When checked', () => {
      it('Then it holds', () => {
        // Arrange + Assert — no dedupe: a duplicate name is no longer
        // refused, so the count comes straight from the arbitrary's own
        // generation rather than re-implementing the parse loop.
        fc.assert(
          fc.property(fc.array(arbTreeEntryRawName()), (entries) => {
            const result = parseBuilt(entries);
            expect(result.entries.length).toBe(entries.length);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given the property "diffTrees(parseTreeContent(x), parseTreeContent(x)) is empty" through the trusted fromRaw parse path', () => {
    describe('When checked', () => {
      it('Then it holds', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(fc.array(arbTreeEntryAnyMode()), (rawEntries) => {
            const entries = dedupeTreeEntriesByName(rawEntries);
            const parsed = parseBuilt(entries);

            const result = diffTrees(parsed, parsed);

            expect(result.changes).toEqual([]);
          }),
        );
      });
    });
  });

  describe('Given the property "removing one parsed entry surfaces exactly one delete for it"', () => {
    describe('When checked', () => {
      it('Then it holds', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(
            fc.array(arbTreeEntryAnyMode(), { minLength: 1 }),
            fc.nat(),
            (rawEntries, pickIndex) => {
              const entries = dedupeTreeEntriesByName(rawEntries);
              fc.pre(entries.length > 0);
              const removeAt = pickIndex % entries.length;
              const removed = entries[removeAt]!;
              const fewer = entries.filter((_, i) => i !== removeAt);

              const fullTree = parseBuilt(entries);
              const fewerTree = parseBuilt(fewer);

              const result = diffTrees(fullTree, fewerTree);

              expect(result.changes).toEqual([
                { type: 'delete', oldPath: removed.name, oldId: removed.id, oldMode: removed.mode },
              ]);
            },
          ),
        );
      });
    });
  });
});
