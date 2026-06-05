/// <reference lib="dom" />
/**
 * Scenario 1 — OPFS round-trip, asserted per git operation.
 *
 * Given an OPFS root with a working file,
 * When init → add → commit → status run in one browser evaluation,
 * Then each operation's result is asserted under its own step, so a failure
 *   names the exact git operation that broke instead of a trailing aggregate.
 */
import { AUTHOR, type Author, expect, test } from './fixtures.js';

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

interface Tsgit {
  openRepository: (opts: { rootHandle: FileSystemDirectoryHandle }) => Promise<BrowserRepo>;
}

// Playwright's WebKit headless build does not expose
// navigator.storage.getDirectory (OPFS works in production Safari but is
// gated off in the test browser). Skip OPFS-dependent scenarios on webkit;
// SubtleCrypto + DecompressionStream coverage still runs there.
test.describe('OPFS round-trip', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'OPFS not exposed in Playwright WebKit');

  test('Given an OPFS root, When init→add→commit→status run, Then each operation passes on its own step', async ({
    readyPage,
  }) => {
    const result = await readyPage.evaluate(async (author) => {
      const tsgit = (window as unknown as { __tsgit: Tsgit }).__tsgit;
      const rootHandle = await navigator.storage.getDirectory();

      const file = await rootHandle.getFileHandle('a.txt', { create: true });
      const writable = await file.createWritable();
      await writable.write(new TextEncoder().encode('hello browser\n'));
      await writable.close();

      const repo = await tsgit.openRepository({ rootHandle });
      try {
        const init = await repo.init();
        const add = await repo.add(['a.txt']);
        const commit = await repo.commit({ message: 'first browser commit', author });
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
