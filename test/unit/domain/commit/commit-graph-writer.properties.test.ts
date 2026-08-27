import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  commitDataAt,
  parseCommitGraphLayer,
  positionOf,
} from '../../../../src/domain/commit/commit-graph.js';
import { serializeCommitGraph } from '../../../../src/domain/commit/commit-graph-writer.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import { arbCommitGraphWriterDag } from './arbitraries.js';

/** `data.parent1Pos`/`parent2Pos`/`additionalParentPositions`, flattened back
 *  into the single ordered list the writer received. */
function readParentPositions(
  layer: ReturnType<typeof parseCommitGraphLayer>,
  localPos: number,
): readonly number[] {
  const data = commitDataAt(layer, localPos);
  return [
    ...(data.parent1Pos !== undefined ? [data.parent1Pos] : []),
    ...(data.parent2Pos !== undefined ? [data.parent2Pos] : []),
    ...data.additionalParentPositions,
  ];
}

describe('serializeCommitGraph properties', () => {
  describe('Given an arbitrary commit DAG', () => {
    describe('When serialized then parsed', () => {
      it('Then parseCommitGraphLayer round-trips it', () => {
        // Arrange & Act & Assert
        fc.assert(
          fc.property(arbCommitGraphWriterDag(), ({ hashVersion, commits }) => {
            const hashConfig = hashVersion === 1 ? SHA1_CONFIG : SHA256_CONFIG;

            const bytes = serializeCommitGraph(commits, hashConfig);
            const result = parseCommitGraphLayer(bytes);

            expect(result.hashVersion).toBe(hashVersion);
            expect(result.commitCount).toBe(commits.length);
            expect(result.numBaseGraphs).toBe(0);

            for (const commit of commits) {
              const localPos = positionOf(result, commit.id);
              expect(localPos).not.toBeUndefined();
              const data = commitDataAt(result, localPos!);

              expect(data.rootTree).toBe(commit.rootTree);
              expect(data.committerDate).toBe(commit.committerDate);

              const expectedParentPositions = commit.parents.map((id) => positionOf(result, id)!);
              expect(readParentPositions(result, localPos!)).toEqual(expectedParentPositions);
            }
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
