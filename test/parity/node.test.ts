/**
 * Parity driver — Node adapter.
 *
 * Runs every scenario in `SCENARIOS` against a real temporary directory on
 * the Node filesystem via `openRepository` from `tsgit/auto/node`, then
 * asserts the result against the scenario's `expected` golden. The Memory
 * driver (`memory.test.ts`) and the Browser driver (`test/browser/parity
 * .spec.ts`) assert against the same golden — divergence is a parity bug.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.ts';
import { SCENARIOS } from './scenarios/index.ts';
import type { ScenarioInputs } from './scenarios/types.ts';

const stageFiles = async (rootDir: string, inputs: ScenarioInputs): Promise<void> => {
  for (const file of inputs.files) {
    const absolute = path.join(rootDir, file.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content);
  }
};

describe.each(SCENARIOS)('Given the $name scenario', (scenario) => {
  let tmpDir = '';

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-parity-node-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('When the Node driver runs it', () => {
    it('Then the result matches the scenario expected golden', async () => {
      // Arrange
      await stageFiles(tmpDir, scenario.inputs);
      const repo = await openRepository({ cwd: tmpDir });

      // Act
      const sut = await scenario.run(repo, scenario.inputs);

      // Assert
      expect(sut).toEqual(scenario.expected);
    });
  });
});
