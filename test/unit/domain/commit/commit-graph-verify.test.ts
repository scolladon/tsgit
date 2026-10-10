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

const SIDE_SIBLING = `11${'33'.repeat(19)}` as ObjectId;
const SIDE_LAST_SIBLING = `11${'44'.repeat(19)}` as ObjectId;

const mergeGraphBytes = () =>
  serializeCommitGraph(
    [
      { id: FIRST_BUCKET, rootTree: TREE, parents: [], committerDate: 1 },
      { id: SIDE, rootTree: TREE, parents: [], committerDate: 1 },
      { id: MERGE, rootTree: TREE, parents: [FIRST_BUCKET, SIDE], committerDate: 2 },
    ],
    SHA1_CONFIG,
  );

const mergeGraph = () => parseCommitGraphLayer(mergeGraphBytes());

/** The merge graph with fanout `bucket` recording `count` commits. */
function mergeGraphWithFanout(bucket: number, count: number) {
  const bytes = mergeGraphBytes();
  const { _fanoutOffset } = parseCommitGraphLayer(bytes);
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(_fanoutOffset + bucket * 4, count);
  return parseCommitGraphLayer(bytes);
}

/** The merge graph with the OID stored at `position` overwritten by `id`. */
function mergeGraphWithOid(position: number, id: ObjectId) {
  const bytes = mergeGraphBytes();
  const { _oidLookupOffset, _hashLength } = parseCommitGraphLayer(bytes);
  bytes.set(hexToBytes(id), _oidLookupOffset + position * _hashLength);
  return parseCommitGraphLayer(bytes);
}

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

  describe('Given a graph whose fanout records a wrong count past its last OID', () => {
    describe('When its structure is verified', () => {
      it('Then the trailing bucket is reported', () => {
        // Arrange
        const layer = mergeGraphWithFanout(0x80, 2);
        const sut = verifyGraphStructure;

        // Act
        const result = sut(layer, layer.commitCount);

        // Assert
        expect(result).toEqual({
          verdicts: [{ check: 'fanout', bucket: 0x80, recordedCount: 2, expectedCount: 3 }],
          fatal: false,
        });
      });
    });
  });

  describe('Given a graph storing the same OID twice in a row', () => {
    describe('When its structure is verified', () => {
      it('Then the repeat is reported out of order', () => {
        // Arrange
        const layer = mergeGraphWithOid(2, SIDE);
        const sut = verifyGraphStructure;

        // Act
        const result = sut(layer, layer.commitCount);

        // Assert
        expect(result.verdicts.filter((verdict) => verdict.check === 'oid-order')).toEqual([
          { check: 'oid-order', previous: SIDE, id: SIDE },
        ]);
      });
    });
  });

  describe('Given a graph whose previous fanout bucket overstates its count', () => {
    describe('When an OID of the next bucket is searched', () => {
      it('Then it is not found, the search staying between the recorded bounds', () => {
        // Arrange
        const layer = mergeGraphWithFanout(0x21, 3);
        const sut = findGraphPosition;

        // Act
        const result = sut(layer, hexToBytes(MERGE));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given three OIDs sharing a fanout bucket', () => {
    describe('When the greatest one is searched', () => {
      it('Then it is found at its position', () => {
        // Arrange
        const layer = parseCommitGraphLayer(
          serializeCommitGraph(
            [
              { id: SIDE, rootTree: TREE, parents: [], committerDate: 1 },
              { id: SIDE_SIBLING, rootTree: TREE, parents: [], committerDate: 1 },
              { id: SIDE_LAST_SIBLING, rootTree: TREE, parents: [], committerDate: 1 },
            ],
            SHA1_CONFIG,
          ),
        );
        const sut = findGraphPosition;

        // Act
        const result = sut(layer, hexToBytes(SIDE_LAST_SIBLING));

        // Assert
        expect(result).toBe(2);
      });
    });
  });
});
