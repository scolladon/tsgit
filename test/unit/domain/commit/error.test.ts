import { describe, expect, it } from 'vitest';
import {
  commitGraphDateTooLarge,
  commitGraphGenerationOverflow,
  invalidCommitGraphChunk,
  invalidCommitGraphHeader,
} from '../../../../src/domain/commit/error.js';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

const OID = 'a'.repeat(40) as ObjectId;

describe('commit-graph error', () => {
  describe('factory functions', () => {
    describe("Given invalidCommitGraphHeader('bad magic')", () => {
      describe('When checking error.data', () => {
        it("Then equals { code: 'INVALID_COMMIT_GRAPH_HEADER', reason: 'bad magic' }", () => {
          // Arrange & Act
          const result = invalidCommitGraphHeader('bad magic');

          // Assert
          expect(result.data).toEqual({ code: 'INVALID_COMMIT_GRAPH_HEADER', reason: 'bad magic' });
        });
      });
    });

    describe("Given invalidCommitGraphChunk('truncated OIDL')", () => {
      describe('When checking error.data', () => {
        it("Then equals { code: 'INVALID_COMMIT_GRAPH_CHUNK', reason: 'truncated OIDL' }", () => {
          // Arrange & Act
          const result = invalidCommitGraphChunk('truncated OIDL');

          // Assert
          expect(result.data).toEqual({
            code: 'INVALID_COMMIT_GRAPH_CHUNK',
            reason: 'truncated OIDL',
          });
        });
      });
    });

    describe('Given commitGraphDateTooLarge(OID, 2 ** 34, 2 ** 34)', () => {
      describe('When checking error.data', () => {
        it("Then equals { code: 'COMMIT_GRAPH_DATE_TOO_LARGE', id: OID, committerDate: 2 ** 34, limit: 2 ** 34 }", () => {
          // Arrange & Act
          const result = commitGraphDateTooLarge(OID, 2 ** 34, 2 ** 34);

          // Assert
          expect(result.data).toEqual({
            code: 'COMMIT_GRAPH_DATE_TOO_LARGE',
            id: OID,
            committerDate: 2 ** 34,
            limit: 2 ** 34,
          });
        });
      });
    });

    describe('Given commitGraphGenerationOverflow(OID, 0x80000000, 0x7fffffff)', () => {
      describe('When checking error.data', () => {
        it("Then equals { code: 'COMMIT_GRAPH_GENERATION_OVERFLOW', id: OID, offset: 0x80000000, limit: 0x7fffffff }", () => {
          // Arrange & Act
          const result = commitGraphGenerationOverflow(OID, 0x80000000, 0x7fffffff);

          // Assert
          expect(result.data).toEqual({
            code: 'COMMIT_GRAPH_GENERATION_OVERFLOW',
            id: OID,
            offset: 0x80000000,
            limit: 0x7fffffff,
          });
        });
      });
    });
  });

  describe('TsgitError class', () => {
    describe('Given a commit-graph TsgitError', () => {
      describe('When checking instanceof Error', () => {
        it('Then returns true', () => {
          // Arrange & Act
          const result = invalidCommitGraphHeader('bad');

          // Assert
          expect(result).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const result = invalidCommitGraphHeader('bad');

          // Assert
          expect(result.name).toBe('TsgitError');
        });
      });
      describe('When accessing .message', () => {
        it('Then contains the error code', () => {
          // Arrange & Act
          const result = invalidCommitGraphChunk('bad');

          // Assert
          expect(result.message).toContain('INVALID_COMMIT_GRAPH_CHUNK');
        });
      });
      describe('When switching on data.code in the shared exhaustive switch', () => {
        it('Then it is handleable', () => {
          // Arrange
          const result = invalidCommitGraphHeader('test');

          // Act
          const data: TsgitErrorData = result.data;

          // Assert
          assertExhaustiveSwitch(data);
        });
      });
    });
  });
});
