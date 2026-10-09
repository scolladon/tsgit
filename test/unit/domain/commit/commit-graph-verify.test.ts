import { describe, expect, it } from 'vitest';
import { parseCommitGraphLayer } from '../../../../src/domain/commit/commit-graph.js';
import {
  findGraphPosition,
  graphParentPositions,
  verifyGraphStructure,
} from '../../../../src/domain/commit/commit-graph-verify.js';
import { serializeCommitGraph } from '../../../../src/domain/commit/commit-graph-writer.js';
import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { SHA1_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';

const TREE = 'f'.repeat(40) as ObjectId;
const FIRST_BUCKET = '00'.repeat(20) as ObjectId;
const SIDE = '11'.repeat(20) as ObjectId;
const MERGE = '22'.repeat(20) as ObjectId;

const mergeGraph = () =>
  parseCommitGraphLayer(
    serializeCommitGraph(
      [
        { id: FIRST_BUCKET, rootTree: TREE, parents: [], committerDate: 1 },
        { id: SIDE, rootTree: TREE, parents: [], committerDate: 1 },
        { id: MERGE, rootTree: TREE, parents: [FIRST_BUCKET, SIDE], committerDate: 2 },
      ],
      SHA1_CONFIG,
    ),
  );

describe('commit-graph verify structure', () => {
  describe('Given a well-formed graph whose first OID sits in fanout bucket zero', () => {
    describe('When its structure is verified', () => {
      it('Then no verdict is reported', () => {
        // Arrange
        const layer = mergeGraph();
        const sut = verifyGraphStructure;

        // Act
        const result = sut(layer, layer.commitCount);

        // Assert
        expect(result).toEqual({ verdicts: [], fatal: false });
      });
    });

    describe('When the bucket-zero OID is searched', () => {
      it('Then it is found at position zero', () => {
        // Arrange
        const layer = mergeGraph();
        const sut = findGraphPosition;

        // Act
        const result = sut(layer, hexToBytes(FIRST_BUCKET));

        // Assert
        expect(result).toBe(0);
      });
    });
  });

  describe('Given a merge commit in the graph', () => {
    describe('When its parent positions are read', () => {
      it('Then both parents come back in order', () => {
        // Arrange
        const layer = mergeGraph();
        const sut = graphParentPositions;

        // Act
        const result = sut(layer, 2);

        // Assert
        expect(result).toEqual([0, 1]);
      });
    });
  });
});
