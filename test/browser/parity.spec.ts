/// <reference lib="dom" />
/**
 * Parity driver — Browser adapter.
 *
 * Runs every scenario registered on `window.__tsgitParity` (populated by
 * `parity-scenarios.bundle.js`) against an OPFS-backed `Repository` and
 * asserts the result against the scenario's `expected` golden. The Node
 * driver (`test/parity/node.test.ts`) and Memory driver
 * (`test/parity/memory.test.ts`) assert against the same golden — divergence
 * is a parity bug.
 *
 * The scenario object holds a function and cannot cross the `page.evaluate`
 * boundary; we look it up by `name` inside the page (ADR-127). `inputs` is
 * structured-cloneable and passed across as data.
 */
import { SCENARIOS } from '../parity/scenarios/index.ts';
import type { ScenarioInputs } from '../parity/scenarios/types.ts';
import { expect, test } from './fixtures.ts';

interface BrowserScenario {
  readonly run: (repo: unknown, inputs: ScenarioInputs) => Promise<unknown>;
}

interface ParityWindow {
  readonly __tsgitParity?: Readonly<Record<string, BrowserScenario>>;
  readonly __tsgit: {
    readonly openRepository: (opts: {
      rootHandle: FileSystemDirectoryHandle;
    }) => Promise<{ dispose: () => Promise<void> }>;
  };
}

const waitForParityRegistry = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.waitForFunction(() => {
    const w = window as unknown as ParityWindow;
    return typeof w.__tsgitParity === 'object' && w.__tsgitParity !== undefined;
  });
};

test.describe('parity', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'OPFS not exposed in Playwright WebKit');

  for (const scenario of SCENARIOS) {
    test.describe(`Given the ${scenario.name} scenario`, () => {
      test('Then the OPFS-backed result matches the scenario expected golden', async ({
        readyPage,
      }) => {
        // Arrange
        await waitForParityRegistry(readyPage);

        // Act
        const sut = await readyPage.evaluate(
          async ({ name, inputs }) => {
            const w = window as unknown as ParityWindow;
            const registry = w.__tsgitParity;
            if (registry === undefined) throw new Error('__tsgitParity not initialized');
            const target = registry[name];
            if (target === undefined) throw new Error(`scenario ${name} not registered`);
            const rootHandle = await navigator.storage.getDirectory();
            const encoder = new TextEncoder();
            for (const file of inputs.files) {
              const handle = await rootHandle.getFileHandle(file.path, { create: true });
              const writable = await handle.createWritable();
              await writable.write(encoder.encode(file.content));
              await writable.close();
            }
            const repo = await w.__tsgit.openRepository({ rootHandle });
            try {
              return await target.run(repo, inputs);
            } finally {
              await repo.dispose();
            }
          },
          { name: scenario.name, inputs: scenario.inputs },
        );

        // Assert
        expect(sut).toEqual(scenario.expected);
      });
    });
  }
});
