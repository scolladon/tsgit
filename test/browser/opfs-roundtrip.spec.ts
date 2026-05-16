/// <reference lib="dom" />
/**
 * Scenario 1 — OPFS round-trip.
 *
 * Given an OPFS rootHandle granted by the harness,
 * When init → add → commit → status round-trips,
 * Then status reports clean.
 */
import { expect, test } from './fixtures.js';

interface Author {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: string;
}

interface BrowserRepo {
  init: () => Promise<unknown>;
  add: (paths: ReadonlyArray<string>) => Promise<unknown>;
  commit: (opts: { message: string; author: Author }) => Promise<{ id: string; branch?: string }>;
  status: () => Promise<{ clean: boolean; branch?: string }>;
  dispose: () => Promise<void>;
}

interface Tsgit {
  openRepository: (opts: { rootHandle: FileSystemDirectoryHandle }) => Promise<BrowserRepo>;
}

// Playwright's WebKit headless build does not expose navigator.storage.getDirectory
// (OPFS works in production Safari but is gated off in the test browser).
// Skip OPFS-dependent scenarios on webkit; SubtleCrypto + DecompressionStream
// coverage still runs there.
test.describe('OPFS round-trip', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'OPFS not exposed in Playwright WebKit');

  test('Given an OPFS root, When init→add→commit→status, Then status is clean and HEAD points at refs/heads/main', async ({
    readyPage,
  }) => {
    const result = await readyPage.evaluate(async () => {
      const tsgit = (window as unknown as { __tsgit: Tsgit }).__tsgit;
      const rootHandle = await navigator.storage.getDirectory();

      const file = await rootHandle.getFileHandle('a.txt', { create: true });
      const writable = await file.createWritable();
      await writable.write(new TextEncoder().encode('hello browser\n'));
      await writable.close();

      const repo = await tsgit.openRepository({ rootHandle });
      try {
        await repo.init();
        await repo.add(['a.txt']);
        const commit = await repo.commit({
          message: 'first browser commit',
          author: {
            name: 'Browser Test',
            email: 'browser@tsgit.dev',
            timestamp: 1_700_000_000,
            timezoneOffset: '+0000',
          },
        });
        const status = await repo.status();
        return {
          commitId: commit.id,
          branch: status.branch,
          clean: status.clean,
        };
      } finally {
        await repo.dispose();
      }
    });

    expect(result.clean).toBe(true);
    expect(result.branch).toBe('refs/heads/main');
    expect(result.commitId).toMatch(/^[0-9a-f]{40}$/);
  });
});
