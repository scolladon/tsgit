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
import { expect, test } from 'bun:test';
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

for (const scenario of SCENARIOS) {
  test(`node adapter — ${scenario.name} matches expected golden`, async () => {
    // Arrange
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-parity-bun-node-'));
    try {
      await stageFiles(tmpDir, scenario.inputs);
      const repo = await openRepository({ cwd: tmpDir });

      // Act
      const sut = await scenario.run(repo, scenario.inputs);

      // Assert
      expect(sut).toEqual(scenario.expected);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
}
