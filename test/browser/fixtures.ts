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

// The commit author shared by the seed helper and the spec scenarios. A plain
// structured-cloneable object — it is passed across the page.evaluate() boundary.
export interface Author {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: string;
}

export const AUTHOR: Author = {
  name: 'Browser Test',
  email: 'browser@tsgit.dev',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

// Minimal repo shape used only inside seedRepo's evaluate callback — a local
// typing aid, not a shared contract; the real facade lives in src/.
interface SeedRepo {
  init: () => Promise<unknown>;
  add: (paths: ReadonlyArray<string>) => Promise<unknown>;
  commit: (opts: { message: string; author: Author }) => Promise<{ id: string; branch?: string }>;
  dispose: () => Promise<void>;
}

// Seed a fresh repo on the OPFS root: write `a.txt`, then init → add → commit
// one commit (`seed commit`). Returns the new commit id and branch so callers
// can chain further operations or assert against the baseline. A Node-side
// helper — it runs one self-contained `page.evaluate()`, never a callback
// smuggled across the evaluate boundary. The repo is disposed before the
// helper returns; callers re-open the same root in a later `evaluate()` —
// OPFS persists for the page's lifetime, so the seeded `.git` is still there.
export const seedRepo = (page: Page): Promise<{ commitId: string; branch: string | undefined }> =>
  page.evaluate(async (author) => {
    const tsgit = (
      window as unknown as {
        __tsgit: {
          openRepository: (opts: { rootHandle: FileSystemDirectoryHandle }) => Promise<SeedRepo>;
        };
      }
    ).__tsgit;
    const rootHandle = await navigator.storage.getDirectory();
    const file = await rootHandle.getFileHandle('a.txt', { create: true });
    const writable = await file.createWritable();
    await writable.write(new TextEncoder().encode('hello browser\n'));
    await writable.close();

    const repo = await tsgit.openRepository({ rootHandle });
    try {
      await repo.init();
      await repo.add(['a.txt']);
      const commit = await repo.commit({ message: 'seed commit', author });
      return { commitId: commit.id, branch: commit.branch };
    } finally {
      await repo.dispose();
    }
  }, AUTHOR);

export { expect } from '@playwright/test';
