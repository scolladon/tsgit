/**
 * Runtime-parity driver — Bun × Memory adapter.
 *
 * Iterates every scenario in the shared `SCENARIOS` registry, runs it
 * against the Memory adapter loaded from `dist/esm/index.default.js`,
 * and asserts the result against the scenario's golden. A divergence
 * here is a Bun-side runtime-parity bug — most likely in the
 * Bun-vs-V8 difference in Map iteration order or in TypedArray
 * encoding.
 */
import { describe, expect, it } from 'bun:test';

import { openRepository } from '../../../dist/esm/index.default.js';
import { SCENARIOS } from '../../parity/scenarios/index.ts';
import type { ScenarioInputs } from '../../parity/scenarios/types.ts';

const MEMORY_WORK_DIR = '/repo';

const stageFiles = (inputs: ScenarioInputs): Readonly<Record<string, Uint8Array>> => {
  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  for (const file of inputs.files) {
    files[`${MEMORY_WORK_DIR}/${file.path}`] = encoder.encode(file.content);
  }
  return files;
};

const BUN_RUNTIME = 'bun';
const supported = SCENARIOS.filter((s) => !s.unsupportedRuntimes?.includes(BUN_RUNTIME));

describe.each(supported)('Given the $name scenario', (scenario) => {
  describe('When the Bun driver runs it against the Memory adapter', () => {
    it('Then the result matches the scenario expected golden', async () => {
      // Arrange
      const sut = await openRepository({
        files: stageFiles(scenario.inputs),
        ...scenario.openOptions,
      });

      // Act
      const result = await scenario.run(sut, scenario.inputs);

      // Assert
      expect(result).toEqual(scenario.expected);
    });
  });
});
