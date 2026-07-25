import { describe, expect, it } from 'vitest';
import type { TsgitError, TsgitErrorData } from '../../../../src/domain/error.js';
import type { RefName } from '../../../../src/domain/objects/index.js';
import {
  invalidReflogEntry,
  reflogEntryOutOfRange,
  reflogNotFound,
} from '../../../../src/domain/reflog/error.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

const HEAD = 'HEAD' as RefName;

describe('reflog error', () => {
  describe('factory functions', () => {
    describe("Given invalidReflogEntry('missing tab')", () => {
      describe('When checking error.data', () => {
        it('Then code is INVALID_REFLOG_ENTRY and reason matches', () => {
          // Arrange & Act
          const result = invalidReflogEntry('missing tab');

          // Assert
          expect(result.data).toEqual({ code: 'INVALID_REFLOG_ENTRY', reason: 'missing tab' });
        });
      });
    });

    describe('Given reflogNotFound(HEAD)', () => {
      describe('When checking error.data', () => {
        it('Then code is REFLOG_NOT_FOUND and ref matches', () => {
          // Arrange & Act
          const result = reflogNotFound(HEAD);

          // Assert
          expect(result.data).toEqual({ code: 'REFLOG_NOT_FOUND', ref: HEAD });
        });
      });
    });

    describe('Given reflogEntryOutOfRange(HEAD, 5, 2)', () => {
      describe('When checking error.data', () => {
        it('Then code, ref, requested, available match', () => {
          // Arrange & Act
          const result = reflogEntryOutOfRange(HEAD, 5, 2);

          // Assert
          expect(result.data).toEqual({
            code: 'REFLOG_ENTRY_OUT_OF_RANGE',
            ref: HEAD,
            requested: 5,
            available: 2,
          });
        });
      });
    });
  });

  describe('TsgitError class', () => {
    describe('Given a reflog TsgitError', () => {
      describe('When checking instanceof Error', () => {
        it('Then returns true', () => {
          // Arrange & Act
          const result = invalidReflogEntry('bad');

          // Assert
          expect(result).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const result = invalidReflogEntry('bad');

          // Assert
          expect(result.name).toBe('TsgitError');
        });
      });
    });
  });

  describe('extractDetail rendering', () => {
    describe('Given INVALID_REFLOG_ENTRY', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with reason', () => {
          // Arrange & Act
          const result = invalidReflogEntry('missing tab separator');

          // Assert
          expect(result.message).toBe(
            'INVALID_REFLOG_ENTRY: invalid reflog entry: missing tab separator',
          );
        });
      });
    });

    describe('Given REFLOG_NOT_FOUND', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with ref', () => {
          // Arrange & Act
          const result = reflogNotFound(HEAD);

          // Assert
          expect(result.message).toBe('REFLOG_NOT_FOUND: reflog not found: HEAD');
        });
      });
    });

    describe('Given REFLOG_ENTRY_OUT_OF_RANGE', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with ref, requested and available', () => {
          // Arrange & Act
          const result = reflogEntryOutOfRange(HEAD, 5, 2);

          // Assert
          expect(result.message).toBe(
            'REFLOG_ENTRY_OUT_OF_RANGE: reflog entry out of range: ref=HEAD requested=5 available=2',
          );
        });
      });
    });
  });

  describe('exhaustiveness', () => {
    describe('Given a reflog TsgitError', () => {
      describe('When switching on data.code in exhaustive switch', () => {
        it('Then it is handleable', () => {
          // Arrange
          const result = invalidReflogEntry('test');

          // Act & Assert
          const data: TsgitErrorData = result.data;
          // Assert
          assertExhaustiveSwitch(data);
        });
      });
    });

    describe('Given each reflog error code', () => {
      describe('When constructing a TsgitError', () => {
        it('Then the message renders without falling to default', () => {
          // Arrange
          const cases: ReadonlyArray<TsgitError> = [
            invalidReflogEntry('r'),
            reflogNotFound(HEAD),
            reflogEntryOutOfRange(HEAD, 1, 0),
          ];

          // Act & Assert
          for (const result of cases) {
            // Assert
            expect(result.message).not.toContain('[object Object]');
          }
        });
      });
    });
  });
});
