import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import { runContentValidationPass } from '../../../../../../src/application/commands/internal/fsck/content-validation.js';
import type { ObjectId } from '../../../../../../src/domain/objects/index.js';

const sut = runContentValidationPass;

describe('Given a universe containing an object that is neither loose nor readable from a pack', () => {
  describe('When runContentValidationPass validates that object', () => {
    it('Then emits a bad-object finding with msgId badType and sets the corrupt exit bit', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const unreadableId = '0000000000000000000000000000000000000001' as ObjectId;

      // Act
      const result = await sut(ctx, new Set([unreadableId]), false, new Map());

      // Assert
      expect(result.findings).toEqual([
        {
          type: 'bad-object',
          id: unreadableId,
          objectType: 'unknown',
          msgId: 'badType',
          severity: 'error',
        },
      ]);
      expect(result.exitBit).toBe(1);
    });
  });
});
