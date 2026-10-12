import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { reportAmbiguousOid } from '../../../../../src/application/commands/internal/ambiguous-oid-report.js';
import { ambiguousOidPrefix } from '../../../../../src/domain/commands/error.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const BAD = `abcd${'f'.repeat(36)}` as ObjectId;
const BLOB = `abcd${'1'.repeat(36)}` as ObjectId;

type Logged = readonly [level: string, message: string, context?: unknown];

const loggingContext = (): { readonly ctx: Context; readonly logged: Logged[] } => {
  const logged: Logged[] = [];
  const logger = {
    error: (message: string, context?: unknown) => logged.push(['error', message, context]),
    warn: (message: string, context?: unknown) => logged.push(['warn', message, context]),
  };
  return { ctx: { ...createMemoryContext(), logger }, logged };
};

describe('Given an ambiguous prefix whose listing read an unreadable candidate twice', () => {
  describe('When the failure is reported', () => {
    it('Then each failed read logs its inflate and unpack lines between the error and the hint on warn', () => {
      // Arrange
      const { ctx, logged } = loggingContext();
      const fault = { id: BAD, reason: 'incorrect header check' };
      const candidates = [
        { id: BAD, type: 'bad-object' as const },
        { id: BLOB, type: 'blob' as const },
      ];
      const sut = reportAmbiguousOid;

      // Act
      sut(ctx, ambiguousOidPrefix('abcd', candidates, [fault, fault]));

      // Assert
      const inflate = ['error', 'inflate: data stream error (incorrect header check)', fault];
      const unpack = ['error', `unable to unpack ${BAD} header`, { id: BAD }];
      expect(logged).toEqual([
        ['error', 'short object ID abcd is ambiguous', { prefix: 'abcd' }],
        inflate,
        unpack,
        inflate,
        unpack,
        ['warn', 'The candidates are:', { prefix: 'abcd', candidates }],
      ]);
    });
  });
});

describe('Given an ambiguous prefix whose listing read a never-ending header', () => {
  describe('When the failure is reported', () => {
    it("Then the read logs git's header-too-long line between the error and the hint", () => {
      // Arrange
      const { ctx, logged } = loggingContext();
      const fault = { id: BAD, headerLimit: 32 };
      const candidates = [
        { id: BAD, type: 'bad-object' as const },
        { id: BLOB, type: 'blob' as const },
      ];
      const sut = reportAmbiguousOid;

      // Act
      sut(ctx, ambiguousOidPrefix('abcd', candidates, [fault]));

      // Assert
      expect(logged).toEqual([
        ['error', 'short object ID abcd is ambiguous', { prefix: 'abcd' }],
        ['error', `header for ${BAD} too long, exceeds 32 bytes`, fault],
        ['warn', 'The candidates are:', { prefix: 'abcd', candidates }],
      ]);
    });
  });
});

describe('Given an ambiguous prefix whose candidates all read', () => {
  describe('When the failure is reported', () => {
    it('Then only the error and the hint are logged', () => {
      // Arrange
      const { ctx, logged } = loggingContext();
      const candidates = [{ id: BLOB, type: 'blob' as const }];
      const sut = reportAmbiguousOid;

      // Act
      sut(ctx, ambiguousOidPrefix('abcd', candidates));

      // Assert
      expect(logged).toEqual([
        ['error', 'short object ID abcd is ambiguous', { prefix: 'abcd' }],
        ['warn', 'The candidates are:', { prefix: 'abcd', candidates }],
      ]);
    });
  });
});

describe('Given a failure other than an ambiguous prefix', () => {
  describe('When the failure is reported', () => {
    it('Then nothing is logged', () => {
      // Arrange
      const { ctx, logged } = loggingContext();
      const sut = reportAmbiguousOid;

      // Act
      sut(ctx, new Error('other'));

      // Assert
      expect(logged).toEqual([]);
    });
  });
});
