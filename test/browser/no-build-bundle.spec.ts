/// <reference lib="dom" />
/**
 * Scenario — the no-build bundle loads in one request.
 *
 * Given the single-file browser bundle at /dist/browser/tsgit.js,
 * When a page imports it directly (no bundler, no import map),
 * Then the browser issues exactly one request for tsgit code — against the
 *   code-split control harness, which issues many — and the bundle's exports
 *   drive a full init → add → commit → status round-trip against OPFS.
 */
import type { Page } from '@playwright/test';
import {
  AUTHOR,
  type Author,
  expect,
  resetOpfs,
  test,
  waitForBundleReady,
  waitForTsgitReady,
} from './fixtures.js';

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

interface TsgitBundle {
  isBrowser: () => boolean;
  openRepository: (opts: { rootHandle: FileSystemDirectoryHandle }) => Promise<BrowserRepo>;
}

// Attach the request listener before navigation so no request is missed.
// Filtering on '/dist/' excludes the harness page itself and any favicon probe.
const trackDistRequests = (page: Page): ReadonlyArray<string> => {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/dist/')) urls.push(request.url());
  });
  return urls;
};

test.describe('no-build bundle', () => {
  test('Given the no-build harness, When the page loads, Then exactly one /dist/ request fetches the bundle', async ({
    page,
  }) => {
    const distRequests = trackDistRequests(page);

    await waitForBundleReady(page);

    expect(distRequests).toHaveLength(1);
    expect(distRequests[0]).toContain('/dist/browser/tsgit.js');
  });

  test('Given the code-split harness (control), When the page loads, Then more than one /dist/ request fires', async ({
    page,
  }) => {
    const distRequests = trackDistRequests(page);

    await waitForTsgitReady(page);

    expect(distRequests.length).toBeGreaterThan(1);
  });

  test('Given the bundle loaded in a real page, When isBrowser is called, Then it reports true', async ({
    page,
  }) => {
    await waitForBundleReady(page);

    const result = await page.evaluate(() =>
      (window as unknown as { __tsgitBundle: TsgitBundle }).__tsgitBundle.isBrowser(),
    );

    expect(result).toBe(true);
  });
});

test.describe('no-build bundle OPFS round-trip', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'OPFS not exposed in Playwright WebKit');

  test('Given an OPFS root, When init→add→commit→status run through the bundle, Then each operation passes on its own step', async ({
    page,
  }) => {
    await waitForBundleReady(page);
    await resetOpfs(page);

    const result = await page.evaluate(async (author) => {
      const tsgit = (window as unknown as { __tsgitBundle: TsgitBundle }).__tsgitBundle;
      const rootHandle = await navigator.storage.getDirectory();

      const file = await rootHandle.getFileHandle('a.txt', { create: true });
      const writable = await file.createWritable();
      await writable.write(new TextEncoder().encode('hello browser\n'));
      await writable.close();

      const repo = await tsgit.openRepository({ rootHandle });
      try {
        const init = await repo.init();
        const add = await repo.add(['a.txt']);
        const commit = await repo.commit({ message: 'first bundle commit', author });
        const status = await repo.status();
        return { init, add, commit, status };
      } finally {
        await repo.dispose();
      }
    }, AUTHOR);

    await test.step('init reports the main branch on a non-bare repo', () => {
      expect(result.init.initialBranch).toBe('main');
      expect(result.init.bare).toBe(false);
    });

    await test.step('add stages a.txt', () => {
      expect(result.add.added).toContain('a.txt');
    });

    await test.step('commit writes a 40-hex id on refs/heads/main', () => {
      expect(result.commit.id).toMatch(/^[0-9a-f]{40}$/);
      expect(result.commit.branch).toBe('refs/heads/main');
    });

    await test.step('status reports a clean, attached tree on refs/heads/main', () => {
      expect(result.status.clean).toBe(true);
      expect(result.status.branch).toBe('refs/heads/main');
      expect(result.status.detached).toBe(false);
      expect(result.status.changes).toEqual([]);
      expect(result.status.untracked).toEqual([]);
    });
  });
});
