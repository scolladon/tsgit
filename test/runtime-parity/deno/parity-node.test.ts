/**
 * Runtime-parity driver — Deno × Node adapter.
 *
 * Iterates every scenario in the shared `SCENARIOS` registry, runs it
 * against the Node adapter loaded from `dist/esm/index.node.js` (the
 * Node-conditional entry users get via `import '@scolladon/tsgit'` on
 * Deno's Node-compat surface), and asserts the result against the
 * scenario's golden. A divergence here is most likely Deno's
 * `node:fs` / `node:crypto` polyfill differing from V8 + libuv.
 *
 * Titles use the project's 2-level GWT shortcut (Given+When in the
 * outer label, Then in the inner `t.step`) because `Deno.test` has no
 * `describe.each` analogue.
 */

import { assertEquals } from 'jsr:@std/assert@1';
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
  Deno.test(`Given the ${scenario.name} scenario, When the Deno driver runs it against the Node adapter`, async (t) => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-parity-deno-node-'));
    try {
      await t.step('Then the result matches the scenario expected golden', async () => {
        // Arrange
        await stageFiles(tmpDir, scenario.inputs);
        const repo = await openRepository({ cwd: tmpDir });

        // Act
        const sut = await scenario.run(repo, scenario.inputs);

        // Assert
        assertEquals(sut, scenario.expected);
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
}
