/**
 * The memory adapter has no filesystem beyond its root, so an alternate
 * outside it is reported `unreachable`; the node adapter reads such a path
 * from disk, which is why this row is not in the shared `SCENARIOS` list.
 */
import { describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.default.ts';
import { runScenario } from './run-scenario.ts';
import { alternatesOutOfRootScenario } from './scenarios/alternates.scenario.ts';

describe('Given the alternates-out-of-root scenario', () => {
  describe('When the Memory driver runs it', () => {
    it('Then the out-of-root alternate is reported unreachable', async () => {
      // Arrange
      const sut = await openRepository({});

      // Act
      const result = await runScenario(sut, alternatesOutOfRootScenario);

      // Assert
      expect(result).toEqual(alternatesOutOfRootScenario.expected);
    });
  });
});
