import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  commitDataAt,
  parseCommitGraphLayer,
  positionOf,
} from '../../../../src/domain/commit/commit-graph.js';
import {
  type CommitGraphWriterCommit,
  serializeCommitGraph,
} from '../../../../src/domain/commit/commit-graph-writer.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
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

/**
 * Independent "corrected commit date" fold, computed straight from the
 * generated DAG's own `committerDate`/`parents` fields — never through the
 * writer's `computeGenerations`, so it cannot share a bug with the SUT it
 * checks. git's rule: a commit's corrected date is the max of its own
 * committer date and one more than every parent's corrected date. The DAG
 * is acyclic by construction (`arbCommitGraphWriterDag` only lets a commit
 * name an EARLIER-positioned commit as a parent), so the memoised recursion
 * always terminates.
 */
function correctedDateFold(
  commits: readonly CommitGraphWriterCommit[],
): ReadonlyMap<ObjectId, number> {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const memo = new Map<ObjectId, number>();
  const foldOne = (id: ObjectId): number => {
    const memoized = memo.get(id);
    if (memoized !== undefined) return memoized;
    const commit = byId.get(id);
    if (commit === undefined) throw new Error(`arbitrary DAG referenced unknown parent: ${id}`);
    let corrected = commit.committerDate;
    for (const parentId of commit.parents) {
      corrected = Math.max(corrected, foldOne(parentId) + 1);
    }
    memo.set(id, corrected);
    return corrected;
  };
  for (const commit of commits) foldOne(commit.id);
  return memo;
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
            const expectedGeneration = correctedDateFold(commits);

            expect(result.hashVersion).toBe(hashVersion);
            expect(result.commitCount).toBe(commits.length);
            expect(result.numBaseGraphs).toBe(0);

            for (const commit of commits) {
              const localPos = positionOf(result, commit.id);
              expect(localPos).not.toBeUndefined();
              const data = commitDataAt(result, localPos!);

              expect(data.rootTree).toBe(commit.rootTree);
              expect(data.committerDate).toBe(commit.committerDate);
              // GDA2/GDO2 round-trip: the only field carrying the corrected
              // date git's own commit-graph generation number is built from.
              expect(data.generation).toBe(expectedGeneration.get(commit.id));

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
