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
import type { Repository } from '../../src/repository.ts';
import { SCENARIOS } from '../parity/scenarios/index.ts';
import type { ScenarioInputs } from '../parity/scenarios/types.ts';
import { expect, test } from './fixtures.ts';

interface BrowserScenario {
  readonly run: (repo: Repository, inputs: ScenarioInputs) => Promise<unknown>;
}

interface ParityWindow {
  readonly __tsgitParity?: Readonly<Record<string, BrowserScenario>>;
  readonly __tsgit: {
    readonly openRepository: (opts: {
      rootHandle: FileSystemDirectoryHandle;
    }) => Promise<Repository>;
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

  // Guard: the browser bundle must register every scenario the Node-side
  // SCENARIOS list expects. A by-name lookup with a missing or misnamed
  // entry would otherwise mismatch `run()` against `expected` and silently
  // hide a parity bug — or worse, blame the wrong adapter.
  test('Given the browser bundle, When the registry is inspected, Then it exposes exactly the SCENARIOS list', async ({
    readyPage,
  }) => {
    // Arrange
    await waitForParityRegistry(readyPage);

    // Act
    const sut = await readyPage.evaluate(() => {
      const w = window as unknown as ParityWindow;
      return Object.keys(w.__tsgitParity ?? {}).sort();
    });

    // Assert
    expect(sut).toEqual(SCENARIOS.map((scenario) => scenario.name).sort());
  });

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
