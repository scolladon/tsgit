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

export const NO_BUILD_HARNESS_PATH = '/test/browser/no-build.html';

// Wait until the inline module script in no-build.html has assigned
// `window.__tsgitBundle` from the single-file browser bundle.
export const waitForBundleReady = async (page: Page): Promise<void> => {
  await page.goto(NO_BUILD_HARNESS_PATH, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    return typeof (window as unknown as { __tsgitBundle?: unknown }).__tsgitBundle === 'object';
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

// The two harness pages publish the library under different globals; the
// round-trip helper is keyed by whichever one a spec drives.
type HarnessGlobal = '__tsgit' | '__tsgitBundle';

// The repository surface exercised by the round-trip specs — a typing aid for
// values crossing the page.evaluate boundary, not a shared contract; the real
// facade lives in src/.
interface BrowserRepo {
  init: () => Promise<{ initialBranch: string; bare: boolean }>;
  add: (paths: ReadonlyArray<string>) => Promise<{ added: ReadonlyArray<string> }>;
  commit: (opts: { message: string; author: Author }) => Promise<{ id: string; branch?: string }>;
  status: () => Promise<{
    clean: boolean;
    branch?: string;
    detached: boolean;
    changes: ReadonlyArray<unknown>;
    untracked: ReadonlyArray<unknown>;
  }>;
  dispose: () => Promise<void>;
}

interface RepositoryOpener {
  openRepository: (opts: { rootHandle: FileSystemDirectoryHandle }) => Promise<BrowserRepo>;
}

export interface RoundTripResult {
  init: Awaited<ReturnType<BrowserRepo['init']>>;
  add: Awaited<ReturnType<BrowserRepo['add']>>;
  commit: Awaited<ReturnType<BrowserRepo['commit']>>;
  status: Awaited<ReturnType<BrowserRepo['status']>>;
}

// One full init → add → commit → status round-trip against the OPFS root,
// through whichever harness global carries the library (`__tsgit` on the
// code-split harness, `__tsgitBundle` on the no-build one). Both round-trip
// specs run this same body so the two entry points cannot drift apart.
export const runOpfsRoundTrip = (
  page: Page,
  windowKey: HarnessGlobal,
  message: string,
): Promise<RoundTripResult> =>
  page.evaluate(
    async ({ windowKey, message, author }) => {
      const tsgit = (window as unknown as Record<HarnessGlobal, RepositoryOpener>)[windowKey];
      const rootHandle = await navigator.storage.getDirectory();

      const file = await rootHandle.getFileHandle('a.txt', { create: true });
      const writable = await file.createWritable();
      await writable.write(new TextEncoder().encode('hello browser\n'));
      await writable.close();

      const repo = await tsgit.openRepository({ rootHandle });
      try {
        const init = await repo.init();
        const add = await repo.add(['a.txt']);
        const commit = await repo.commit({ message, author });
        const status = await repo.status();
        return { init, add, commit, status };
      } finally {
        await repo.dispose();
      }
    },
    { windowKey, message, author: AUTHOR },
  );

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
