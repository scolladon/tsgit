import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { createSubstExpander } from '../../../../../src/application/commands/internal/archive-subst.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';

const UNREADABLE = '1234567890123456789012345678901234567890' as ObjectId;

describe('createSubstExpander', () => {
  describe('Given content without any $Format: occurrence', () => {
    describe('When the file is expanded against a commit that cannot be read', () => {
      it('Then the very same bytes come back without reading the commit', async () => {
        // Arrange
        const content = new TextEncoder().encode('plain %h text');
        const sut = createSubstExpander;
        const expander = sut(createMemoryContext(), { commit: UNREADABLE, tree: UNREADABLE });

        // Act
        const result = await expander.expandFile(content);

        // Assert
        expect(result).toBe(content);
      });
    });
  });
});
