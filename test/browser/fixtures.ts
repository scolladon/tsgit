/// <reference lib="dom" />
import { test as base, type Page } from '@playwright/test';

export const HARNESS_PATH = '/test/browser/index.html';

// Wait until the inline module script in index.html has assigned
// `window.__tsgit`. Returns nothing — callers `page.evaluate(...)` afterwards.
export const waitForTsgitReady = async (page: Page): Promise<void> => {
  await page.goto(HARNESS_PATH, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    return typeof (window as unknown as { __tsgit?: unknown }).__tsgit === 'object';
  });
};

// Clear OPFS between tests so each scenario starts from a known-empty root.
// Defensive: not every browser engine ships OPFS in headless mode, so swallow
// the absence here and let the scenario assertions fail loudly if it matters.
export const resetOpfs = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const storage = (
      navigator as Navigator & {
        storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
      }
    ).storage;
    if (storage?.getDirectory === undefined) return;
    const root = await storage.getDirectory();
    for await (const name of (
      root as FileSystemDirectoryHandle & {
        keys: () => AsyncIterableIterator<string>;
      }
    ).keys()) {
      await root.removeEntry(name, { recursive: true });
    }
  });
};

export const test = base.extend<{ readyPage: Page }>({
  readyPage: async ({ page }, use) => {
    await waitForTsgitReady(page);
    await resetOpfs(page);
    await use(page);
  },
});

export { expect } from '@playwright/test';
