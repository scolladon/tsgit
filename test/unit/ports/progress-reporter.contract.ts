import { describe, expect, it } from 'vitest';
import type { ProgressReporter } from '../../../src/ports/progress-reporter.js';

export function progressReporterContractTests(createSut: () => Promise<ProgressReporter>): void {
  describe('ProgressReporter contract', () => {
    it('Given progress event, When report, Then does not throw', async () => {
      // Arrange
      const sut = await createSut();

      // Act & Assert
      expect(() => sut.report({ phase: 'counting', loaded: 5, total: 10 })).not.toThrow();
    });

    it('Given 1000 sequential events, When reporting, Then all accepted without error', async () => {
      // Arrange
      const sut = await createSut();

      // Act & Assert
      expect(() => {
        for (let i = 0; i < 1000; i++) {
          sut.report({ phase: 'receiving', loaded: i, total: 1000 });
        }
      }).not.toThrow();
    });
  });
}
