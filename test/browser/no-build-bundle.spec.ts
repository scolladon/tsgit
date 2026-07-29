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
  expect,
  resetOpfs,
  runOpfsRoundTrip,
  test,
  waitForBundleReady,
  waitForTsgitReady,
} from './fixtures.js';

interface TsgitBundle {
  isBrowser: () => boolean;
}

// Attach the request listener before navigation; the returned reader snapshots
// the URLs collected so far, so assertions run on an immutable copy taken at a
// defined point. Filtering on '/dist/' excludes the harness page itself and
// any favicon probe.
const trackDistRequests = (page: Page): (() => ReadonlyArray<string>) => {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/dist/')) urls.push(request.url());
  });
  return () => [...urls];
};

test.describe('no-build bundle', () => {
  test('Given the no-build harness, When the page loads, Then exactly one /dist/ request fetches the bundle', async ({
    page,
  }) => {
    const readDistRequests = trackDistRequests(page);

    await waitForBundleReady(page);

    const distRequests = readDistRequests();
    expect(distRequests).toHaveLength(1);
    expect(distRequests[0]).toContain('/dist/browser/tsgit.js');
  });

  // Control: pins the code-split path's fan-out shape via its chunk fetches,
  // proving the request filter distinguishes the two harnesses. If the ESM
  // build ever legitimately stops splitting, delete this control rather than
  // "fixing" it.
  test('Given the code-split harness (control), When the page loads, Then chunk requests fan out', async ({
    page,
  }) => {
    const readDistRequests = trackDistRequests(page);

    await waitForTsgitReady(page);

    const distRequests = readDistRequests();
    expect(distRequests.length).toBeGreaterThan(1);
    expect(distRequests.filter((url) => url.includes('/dist/esm/chunks/')).length).toBeGreaterThan(
      0,
    );
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

    const result = await runOpfsRoundTrip(page, '__tsgitBundle', 'first bundle commit');

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
