/**
 * Runtime-parity driver — Cloudflare Workers × Memory adapter.
 *
 * Iterates every scenario in the shared `SCENARIOS` registry, runs it
 * inside the real `workerd` runtime against the Memory adapter loaded
 * from `dist/esm/index.default.js`, and asserts the result against the
 * scenario's golden. A divergence here is a Workers-side runtime-parity
 * bug — most likely in a `Uint8Array` / `TextEncoder` semantic that
 * differs from V8.
 *
 * Memory adapter only — `workerd` has no filesystem. See ADR-143.
 */
import { describe, expect, it } from 'vitest';

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

const WORKERS_RUNTIME = 'workers';

const supported = SCENARIOS.filter((s) => !s.unsupportedRuntimes?.includes(WORKERS_RUNTIME));
const skipped = SCENARIOS.filter((s) => s.unsupportedRuntimes?.includes(WORKERS_RUNTIME));

describe.each(supported)('Given the $name scenario', (scenario) => {
  describe('When the Workers driver runs it', () => {
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

// Scenarios intentionally excluded from the workers runner are listed here so
// the exclusion is visible in test output rather than silently dropped.
describe.each(skipped)('Given the $name scenario', (scenario) => {
  describe.skip(`When the Workers driver runs it [SKIPPED — unsupported on ${WORKERS_RUNTIME}: see scenario for reason]`, () => {
    it('Then the result matches the scenario expected golden', () => {
      expect(scenario.expected).toBeDefined();
    });
  });
});
