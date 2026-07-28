import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { diffRawTrees } from '../../../../src/domain/diff/raw-tree-diff.js';
import { diffTrees } from '../../../../src/domain/diff/tree-diff.js';
import { SHA1_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import type { Tree } from '../../../../src/domain/objects/tree.js';
import { serializeTreeContent } from '../../../../src/domain/objects/tree.js';
import { arbCanonicalTree } from './arbitraries.js';

function contentOf(tree: Tree): Uint8Array {
  return serializeTreeContent(tree, SHA1_CONFIG);
}

const sut = diffRawTrees;

describe('diffRawTrees — property-based tests', () => {
  describe('Given two arbitrary canonical trees', () => {
    describe('When diffed via the raw cursor walk and via the parsed-Tree walk', () => {
      it('Then the emitted changes deep-equal (diffTrees is the oracle)', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(arbCanonicalTree(), arbCanonicalTree(), (treeA, treeB) => {
            const result = sut(contentOf(treeA), contentOf(treeB), SHA1_CONFIG);

            expect(result.changes).toEqual(diffTrees(treeA, treeB).changes);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary canonical tree diffed against itself', () => {
    describe('When diffRawTrees is called', () => {
      it('Then the result is empty', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(arbCanonicalTree(), (t) => {
            const content = contentOf(t);

            const result = sut(content, content, SHA1_CONFIG);

            expect(result.changes).toEqual([]);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary non-empty canonical tree with exactly one entry removed', () => {
    describe('When diffRawTrees is called against the full tree', () => {
      it('Then exactly one delete surfaces for the removed entry', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(
            arbCanonicalTree().filter((t) => t.entries.length > 0),
            fc.nat(),
            (fullTree, pickIndex) => {
              const removeAt = pickIndex % fullTree.entries.length;
              const removed = fullTree.entries[removeAt]!;
              const fewerTree: Tree = {
                ...fullTree,
                entries: fullTree.entries.filter((_, i) => i !== removeAt),
              };

              const result = sut(contentOf(fullTree), contentOf(fewerTree), SHA1_CONFIG);

              expect(result.changes).toEqual([
                {
                  type: 'delete',
                  oldPath: removed.name,
                  oldId: removed.id,
                  oldMode: removed.mode,
                },
              ]);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
