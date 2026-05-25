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
import { expect, test } from 'bun:test';

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

for (const scenario of SCENARIOS) {
  test(`memory adapter — ${scenario.name} matches expected golden`, async () => {
    // Arrange
    const repo = await openRepository({ files: stageFiles(scenario.inputs) });

    // Act
    const sut = await scenario.run(repo, scenario.inputs);

    // Assert
    expect(sut).toEqual(scenario.expected);
  });
}
