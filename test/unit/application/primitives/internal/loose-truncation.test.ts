import { describe, expect, it } from 'vitest';

import { isLooseTruncationOf } from '../../../../../src/application/primitives/internal/loose-truncation.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import { buildSeededContext, writeSelfHashedLooseWithDeclaredSize } from '../fixtures.js';

const BODY = new TextEncoder().encode('0123456789');
const CLAIM = 5;
const FIRST_FIVE = BODY.subarray(0, CLAIM);

describe('isLooseTruncationOf', () => {
  describe('Given an id with no loose copy', () => {
    describe('When asked', () => {
      it('Then it answers false', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = isLooseTruncationOf;

        // Act
        const result = await sut(ctx, 'a'.repeat(40) as ObjectId, FIRST_FIVE);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an honest loose blob', () => {
    describe('When asked with its own bytes', () => {
      it('Then it answers false', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeSelfHashedLooseWithDeclaredSize(ctx, 'blob', BODY.length, BODY);
        const sut = isLooseTruncationOf;

        // Act
        const result = await sut(ctx, id, BODY);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a loose blob claiming more than its body holds', () => {
    describe('When asked', () => {
      it('Then it answers false', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const body = BODY.subarray(0, 5);
        const id = await writeSelfHashedLooseWithDeclaredSize(ctx, 'blob', 200, body);
        const sut = isLooseTruncationOf;

        // Act
        const result = await sut(ctx, id, body);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an in-window truncation', () => {
    describe('When asked with five different bytes', () => {
      it('Then it answers false', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeSelfHashedLooseWithDeclaredSize(ctx, 'blob', CLAIM, BODY);
        const sut = isLooseTruncationOf;

        // Act
        const result = await sut(ctx, id, new TextEncoder().encode('abcde'));

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When asked with the first claimed bytes of the body', () => {
      it('Then it answers true', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeSelfHashedLooseWithDeclaredSize(ctx, 'blob', CLAIM, BODY);
        const sut = isLooseTruncationOf;

        // Act
        const result = await sut(ctx, id, FIRST_FIVE);

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When asked with the whole body', () => {
      it('Then it answers false', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeSelfHashedLooseWithDeclaredSize(ctx, 'blob', CLAIM, BODY);
        const sut = isLooseTruncationOf;

        // Act
        const result = await sut(ctx, id, BODY);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
