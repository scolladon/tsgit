/**
 * Runtime-parity driver — Deno × Memory adapter.
 *
 * Iterates every scenario in the shared `SCENARIOS` registry, runs it
 * against the Memory adapter loaded from `dist/esm/index.default.js`
 * (the same artifact end users `npm install`), and asserts the result
 * against the scenario's golden. A divergence here is a runtime-parity
 * bug — most likely in Deno's Node-compat surface or in a dist-time
 * import resolution.
 *
 * See docs/design/phase-19-8-runtime-parity-matrix.md.
 */
import { assertEquals } from 'jsr:@std/assert@1';

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
  Deno.test(`memory adapter — ${scenario.name} matches expected golden`, async () => {
    // Arrange
    const repo = await openRepository({ files: stageFiles(scenario.inputs) });

    // Act
    const sut = await scenario.run(repo, scenario.inputs);

    // Assert
    assertEquals(sut, scenario.expected);
  });
}
