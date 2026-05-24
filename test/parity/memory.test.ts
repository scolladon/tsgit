/**
 * Parity driver — Memory adapter.
 *
 * Runs every scenario in `SCENARIOS` against the in-memory FS adapter via
 * `openRepository` from `tsgit/auto/memory` and asserts the result against
 * the same golden the Node driver (`node.test.ts`) uses. Any divergence is
 * a parity bug — most likely in object serialization, hash framing, or
 * author-identity encoding.
 */
import { describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.default.ts';
import { SCENARIOS } from './scenarios/index.ts';
import type { ScenarioInputs } from './scenarios/types.ts';

const MEMORY_WORK_DIR = '/repo';

const stageFiles = (inputs: ScenarioInputs): Readonly<Record<string, Uint8Array>> => {
  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  for (const file of inputs.files) {
    files[`${MEMORY_WORK_DIR}/${file.path}`] = encoder.encode(file.content);
  }
  return files;
};

describe.each(SCENARIOS)('Given the $name scenario', (scenario) => {
  describe('When the Memory driver runs it', () => {
    it('Then the result matches the scenario expected golden', async () => {
      // Arrange
      const repo = await openRepository({ files: stageFiles(scenario.inputs) });

      // Act
      const sut = await scenario.run(repo, scenario.inputs);

      // Assert
      expect(sut).toEqual(scenario.expected);
    });
  });
});
