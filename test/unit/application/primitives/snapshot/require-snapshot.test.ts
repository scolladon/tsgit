import { describe, expect, it } from 'vitest';

import { requireSnapshot } from '../../../../../src/application/primitives/snapshot/require-snapshot.js';

describe('requireSnapshot', () => {
  describe('Given a Promise that resolves to a non-null value', () => {
    describe('When requireSnapshot is called', () => {
      it('Then it returns the unwrapped value', async () => {
        // Arrange
        const value = { kind: 'tree' as const };

        // Act
        const sut = await requireSnapshot(Promise.resolve(value), 'never thrown');

        // Assert
        expect(sut).toBe(value);
      });
    });
  });

  describe('Given a Promise that resolves to null', () => {
    describe('When requireSnapshot is called with a reason', () => {
      it('Then it throws SNAPSHOT_REQUIRED carrying the exact reason string', async () => {
        // Arrange
        const reason = 'no merge in progress';

        // Act + Assert
        await expect(
          requireSnapshot<{ kind: 'tree' }>(Promise.resolve(null), reason),
        ).rejects.toMatchObject({
          data: { code: 'SNAPSHOT_REQUIRED', reason },
        });
      });
    });
  });

  describe('Given a Promise that rejects with an unrelated error', () => {
    describe('When requireSnapshot is called', () => {
      it('Then it propagates the original rejection unchanged', async () => {
        // Arrange
        const original = new Error('upstream failure');

        // Act + Assert
        await expect(
          requireSnapshot<{ kind: 'tree' }>(Promise.reject(original), 'reason ignored'),
        ).rejects.toBe(original);
      });
    });
  });
});
