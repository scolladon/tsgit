/**
 * Runtime-parity driver — Bun × Node adapter.
 *
 * Iterates every scenario in the shared `SCENARIOS` registry, runs it
 * against the Node adapter loaded from `dist/esm/index.node.js` (the
 * Node-conditional entry users get via `import '@scolladon/tsgit'`
 * on Bun's Node-compat surface), and asserts the result against the
 * scenario's golden. A divergence here is most likely Bun's
 * `node:fs` / `node:crypto` polyfill differing from Node's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { openRepository } from '../../../dist/esm/index.node.js';
import { SCENARIOS } from '../../parity/scenarios/index.ts';
import type { ScenarioInputs } from '../../parity/scenarios/types.ts';

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
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-parity-bun-node-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('When the Bun driver runs it against the Node adapter', () => {
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
