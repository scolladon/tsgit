import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { transactionLogging } from '../../../../../src/application/primitives/internal/ref-transaction-logging.js';
import { withReftableStorage } from '../reftable-fixtures.js';

describe('transactionLogging', () => {
  describe('Given a files-backend Context', () => {
    describe('When transactionLogging is called', () => {
      it('Then noOpDeleteLogs is "written"', () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = transactionLogging(ctx);

        // Assert
        expect(result.noOpDeleteLogs).toBe('written');
      });
    });
  });

  describe('Given a reftable-backend Context', () => {
    describe('When transactionLogging is called', () => {
      it('Then noOpDeleteLogs is "skipped"', () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());

        // Act
        const result = transactionLogging(ctx);

        // Assert
        expect(result.noOpDeleteLogs).toBe('skipped');
      });
    });
  });

  describe('Given a files-backend Context', () => {
    describe('When transactionLogging is called', () => {
      it('Then renamedBranchLog is "replace-then-same-id"', () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = transactionLogging(ctx);

        // Assert
        expect(result.renamedBranchLog).toBe('replace-then-same-id');
      });
    });
  });

  describe('Given a reftable-backend Context', () => {
    describe('When transactionLogging is called', () => {
      it('Then renamedBranchLog is "merge-then-delete-and-create"', () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());

        // Act
        const result = transactionLogging(ctx);

        // Assert
        expect(result.renamedBranchLog).toBe('merge-then-delete-and-create');
      });
    });
  });

  describe('Given a files-backend Context', () => {
    describe('When transactionLogging is called', () => {
      it('Then headOldThroughLink is "null-id" and symbolicDeleteLog is "removed"', () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = transactionLogging(ctx);

        // Assert
        expect(result.headOldThroughLink).toBe('null-id');
        expect(result.symbolicDeleteLog).toBe('removed');
      });
    });
  });

  describe('Given a reftable-backend Context', () => {
    describe('When transactionLogging is called', () => {
      it('Then headOldThroughLink is "resolved" and symbolicDeleteLog is "kept-with-entry"', () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());

        // Act
        const result = transactionLogging(ctx);

        // Assert
        expect(result.headOldThroughLink).toBe('resolved');
        expect(result.symbolicDeleteLog).toBe('kept-with-entry');
      });
    });
  });

  describe('Given a files-backend Context', () => {
    describe('When transactionLogging is called', () => {
      it('Then renamedSymrefLog is "move-then-null-entry"', () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = transactionLogging(ctx);

        // Assert
        expect(result.renamedSymrefLog).toBe('move-then-null-entry');
      });
    });
  });

  describe('Given a reftable-backend Context', () => {
    describe('When transactionLogging is called', () => {
      it('Then renamedSymrefLog is "copy-then-delete-entry"', () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());

        // Act
        const result = transactionLogging(ctx);

        // Assert
        expect(result.renamedSymrefLog).toBe('copy-then-delete-entry');
      });
    });
  });
});
