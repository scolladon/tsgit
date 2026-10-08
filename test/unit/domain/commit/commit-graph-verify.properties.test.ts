import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCommitGraphLayer } from '../../../../src/domain/commit/commit-graph.js';
import {
  findGraphPosition,
  graphOidBytesAt,
  graphParentPositions,
  verifyGraphStructure,
} from '../../../../src/domain/commit/commit-graph-verify.js';
import { serializeCommitGraph } from '../../../../src/domain/commit/commit-graph-writer.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import { arbCommitGraphWriterDag } from './arbitraries.js';

describe('commit-graph verify structure properties', () => {
  describe('Given any graph the writer serializes', () => {
    describe('When its structure is verified', () => {
      it('Then no verdict is reported and every commit is found where it is stored', () => {
        // Arrange
        const sut = verifyGraphStructure;

        fc.assert(
          fc.property(arbCommitGraphWriterDag(), ({ hashVersion, commits }) => {
            const hashConfig = hashVersion === 1 ? SHA1_CONFIG : SHA256_CONFIG;
            const layer = parseCommitGraphLayer(serializeCommitGraph(commits, hashConfig));

            // Act
            const result = sut(layer, layer.commitCount);

            // Assert
            expect(result).toEqual({ verdicts: [], fatal: false });
            for (let position = 0; position < layer.commitCount; position += 1) {
              expect(findGraphPosition(layer, graphOidBytesAt(layer, position))).toBe(position);
              const parents = graphParentPositions(layer, position, { correctedCommitDates: true });
              expect(parents.every((parent) => parent < layer.commitCount)).toBe(true);
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
