import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { commitGraphLoadFailure } from '../../../../src/domain/commit/commit-graph-load.js';
import {
  hashLengthFor,
  serializeCommitGraph,
} from '../../../../src/domain/commit/commit-graph-writer.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import { arbCommitGraphWriterDag } from './arbitraries.js';

const graphOf = (dag: {
  hashVersion: 1 | 2;
  commits: Parameters<typeof serializeCommitGraph>[0];
}) => serializeCommitGraph(dag.commits, dag.hashVersion === 1 ? SHA1_CONFIG : SHA256_CONFIG);

describe('commitGraphLoadFailure properties', () => {
  describe('Given any graph the writer serialises, When classified under its own hash', () => {
    it('Then git loads it', () => {
      // Arrange
      const sut = commitGraphLoadFailure;

      // Act / Assert
      fc.assert(
        fc.property(arbCommitGraphWriterDag(), (dag) => {
          expect(sut(graphOf(dag), hashLengthFor(dag.hashVersion))).toBeUndefined();
        }),
      );
    });
  });

  describe('Given any graph cut below the smallest file git maps, When classified', () => {
    it('Then it is too small', () => {
      // Arrange
      const sut = commitGraphLoadFailure;

      // Act / Assert
      fc.assert(
        fc.property(arbCommitGraphWriterDag(), fc.nat(1099), (dag, length) => {
          const hashLength = hashLengthFor(dag.hashVersion);
          const short = graphOf(dag).subarray(0, Math.min(length, 8 + 48 + 1024 + hashLength - 1));
          expect(sut(short, hashLength)).toEqual({ kind: 'too-small' });
        }),
      );
    });
  });
});
