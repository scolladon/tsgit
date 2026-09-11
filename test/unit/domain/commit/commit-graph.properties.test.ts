import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  commitDataAt,
  parseCommitGraphLayer,
  positionOf,
} from '../../../../src/domain/commit/commit-graph.js';
import {
  arbCommitGraphLayerModel,
  buildCommitGraphBytes,
  type CommitGraphCommitModel,
} from './arbitraries.js';

interface ExpectedParents {
  readonly parent1Pos: number | undefined;
  readonly parent2Pos: number | undefined;
  readonly additionalParentPositions: readonly number[];
}

function expectedParents(commit: CommitGraphCommitModel): ExpectedParents {
  const [parent1Pos, parent2Pos, ...additionalParentPositions] = commit.parentPositions;
  return { parent1Pos, parent2Pos, additionalParentPositions };
}

describe('commit-graph parser properties', () => {
  describe('Given an arbitrary commit-graph layer model', () => {
    describe('When parseCommitGraphLayer(buildCommitGraphBytes(model)) decodes the built bytes', () => {
      it('Then it recovers the header fields, oid positions, parents, dates, and the generation each option selects', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCommitGraphLayerModel(), (model) => {
            const layer = parseCommitGraphLayer(buildCommitGraphBytes(model));

            expect(layer.hashVersion).toBe(model.hashVersion);
            expect(layer.numBaseGraphs).toBe(model.numBaseGraphs);
            expect(layer.baseGraphHashes).toEqual(model.baseGraphHashes);
            expect(layer.commitCount).toBe(model.commits.length);

            model.commits.forEach((commit, i) => {
              expect(positionOf(layer, commit.oid)).toBe(i);

              const result = commitDataAt(layer, i, { correctedCommitDates: true });
              const expected = expectedParents(commit);
              const expectedGeneration = model.includeGenerationData
                ? commit.committerDate + commit.generationV2Offset
                : commit.generationV1;

              expect(result.rootTree).toBe(commit.rootTree);
              expect(result.committerDate).toBe(commit.committerDate);
              expect(result.parent1Pos).toBe(expected.parent1Pos);
              expect(result.parent2Pos).toBe(expected.parent2Pos);
              expect(result.additionalParentPositions).toEqual(expected.additionalParentPositions);
              expect(result.generation).toBe(expectedGeneration);
              // A caller that asks for topological levels gets the stored V1
              // value even from a layer that carries a GDA2 chunk.
              const topoLevels = commitDataAt(layer, i, { correctedCommitDates: false });
              expect(topoLevels.generation).toBe(commit.generationV1);
            });
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary commit-graph layer model within the safe subset', () => {
    describe('When parsing the bytes it builds', () => {
      it('Then parseCommitGraphLayer never throws (total function over the safe subset)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCommitGraphLayerModel(), (model) => {
            expect(() => parseCommitGraphLayer(buildCommitGraphBytes(model))).not.toThrow();
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
