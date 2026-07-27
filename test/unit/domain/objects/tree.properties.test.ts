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
import { arbObjectId } from './arbitraries.js';

const DUMMY_ID = ObjectId.from('a'.repeat(40));

const arbTreeEntry: fc.Arbitrary<TreeEntry> = fc
  .tuple(
    fc.constantFrom(
      '100644' as const,
      '100755' as const,
      '120000' as const,
      '40000' as const,
      '160000' as const,
    ),
    fc
      .string({ minLength: 1, maxLength: 50 })
      .filter((s) => !s.includes('\0') && !s.includes('/') && s !== '.' && s !== '..'),
    arbObjectId(40),
  )
  .map(([mode, name, id]) => ({ mode, name, id }));

// Git trees cannot contain duplicate entry names — dedupe by name (first wins)
// before building a tree so the arbitrary never generates a tree that is
// invalid by construction (which would look like a flaky test).
function dedupeByName(entries: ReadonlyArray<TreeEntry>): ReadonlyArray<TreeEntry> {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.name)) return false;
    seen.add(e.name);
    return true;
  });
}

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
          fc.property(fc.array(arbTreeEntry), (entries) => {
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
          fc.property(fc.array(arbTreeEntry, { minLength: 2 }), (entries) => {
            const sorted = sortTreeEntries(entries);
            for (let i = 1; i < sorted.length; i++) {
              expect(treeEntryCompare(sorted[i - 1]!, sorted[i]!)).toBeLessThanOrEqual(0);
            }
          }),
        );
      });
    });
  });

  describe('Given the tree roundtrip property "parseTreeContent(id, serializeTreeContent(tree, hash), hash) preserves all entries"', () => {
    describe('When checked', () => {
      it('Then it holds', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(fc.array(arbTreeEntry), (rawEntries) => {
            const entries = dedupeByName(rawEntries);
            const result = parseBuilt(entries);
            const sorted = sortTreeEntries(entries);
            expect(result.entries).toEqual(sorted);
          }),
        );
      });
    });
  });

  describe('Given the property "diffTrees(parseTreeContent(x), parseTreeContent(x)) is empty" through the trusted fromRaw parse path', () => {
    describe('When checked', () => {
      it('Then it holds', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(fc.array(arbTreeEntry), (rawEntries) => {
            const entries = dedupeByName(rawEntries);
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
            fc.array(arbTreeEntry, { minLength: 1 }),
            fc.nat(),
            (rawEntries, pickIndex) => {
              const entries = dedupeByName(rawEntries);
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
