import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { rereadsMisspeltRevision } from '../../../../../src/application/commands/internal/misspelt-revision.js';
import { TsgitError } from '../../../../../src/domain/error.js';

const unresolved = (expression: string): TsgitError =>
  new TsgitError({ code: 'REVPARSE_UNRESOLVED', expression });

describe('rereadsMisspeltRevision', () => {
  describe('Given a read that named no object for a name that is no path', () => {
    describe('When the misspelt-name diagnosis asks for a second read', () => {
      it('Then it asks for one', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = rereadsMisspeltRevision;

        // Act
        const result = await sut(ctx, 'nope', unresolved('nope'));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a read that died of a refusal other than naming no object', () => {
    describe('When the misspelt-name diagnosis asks for a second read', () => {
      it('Then it asks for none', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const denied = new TsgitError({ code: 'PERMISSION_DENIED', path: 'nope' });
        const sut = rereadsMisspeltRevision;

        // Act
        const result = await sut(ctx, 'nope', denied);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a `:/` search that named no object', () => {
    describe('When the misspelt-name diagnosis asks for a second read', () => {
      it('Then it asks for none, as git skips a search on its second read', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = rereadsMisspeltRevision;

        // Act
        const result = await sut(ctx, ':/nomatch', unresolved(':/nomatch'));

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
