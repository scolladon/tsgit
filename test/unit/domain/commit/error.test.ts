import { describe, expect, it } from 'vitest';
import {
  invalidCommitGraphChunk,
  invalidCommitGraphHeader,
} from '../../../../src/domain/commit/error.js';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

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
