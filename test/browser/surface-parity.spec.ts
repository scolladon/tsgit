/// <reference lib="dom" />
/**
 * Scenario 4 — browser surface parity.
 *
 * Given a repo on OPFS,
 * When log / branch / checkout / tag run through the repo facade,
 * Then each command behaves against the browser adapters as it does on Node.
 *
 * Closes the Phase 11 test-review gap: these four commands were unit-tested
 * on the Node adapter but never exercised in a real browser engine. Each
 * scenario runs in one page.evaluate() returning a per-operation result,
 * asserted under its own test.step().
 */
import { AUTHOR, type Author, expect, seedRepo, test } from './fixtures.js';

interface LogEntry {
  id: string;
  message: string;
  parents: ReadonlyArray<string>;
}

interface BranchInfo {
  name: string;
  id: string;
  current: boolean;
}

interface TagInfo {
  name: string;
  id: string;
}

interface BrowserRepo {
  init: () => Promise<unknown>;
  add: (paths: ReadonlyArray<string>) => Promise<unknown>;
  commit: (opts: { message: string; author: Author }) => Promise<{ id: string; branch?: string }>;
  log: () => Promise<ReadonlyArray<LogEntry>>;
  branch: {
    (action: {
      kind: 'create';
      name: string;
    }): Promise<{ kind: 'create'; name: string; id: string }>;
    (action: { kind: 'list' }): Promise<{ kind: 'list'; branches: ReadonlyArray<BranchInfo> }>;
    (action: { kind: 'delete'; name: string }): Promise<{ kind: 'delete'; name: string }>;
  };
  checkout: (opts: { target: string }) => Promise<unknown>;
  tag: {
    (action: {
      kind: 'create';
      name: string;
    }): Promise<{ kind: 'create'; name: string; id: string }>;
    (action: { kind: 'list' }): Promise<{ kind: 'list'; tags: ReadonlyArray<TagInfo> }>;
    (action: { kind: 'delete'; name: string }): Promise<{ kind: 'delete'; name: string }>;
  };
  dispose: () => Promise<void>;
}

interface Tsgit {
  openRepository: (opts: { rootHandle: FileSystemDirectoryHandle }) => Promise<BrowserRepo>;
}

// Playwright's WebKit headless build does not expose
// navigator.storage.getDirectory, so every OPFS-backed scenario skips there —
// the same engine gap handled in opfs-roundtrip.spec.ts.
test.describe('surface parity', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'OPFS not exposed in Playwright WebKit');

  test.describe('log', () => {
    test('Given two commits, When log runs, Then it returns them newest-first with linked parents', async ({
      readyPage,
    }) => {
      const seed = await seedRepo(readyPage);

      await readyPage.evaluate(async (author) => {
        const tsgit = (window as unknown as { __tsgit: Tsgit }).__tsgit;
        const rootHandle = await navigator.storage.getDirectory();
        const file = await rootHandle.getFileHandle('b.txt', { create: true });
        const writable = await file.createWritable();
        await writable.write(new TextEncoder().encode('second file\n'));
        await writable.close();
        const repo = await tsgit.openRepository({ rootHandle });
        try {
          await repo.add(['b.txt']);
          await repo.commit({ message: 'second commit', author });
        } finally {
          await repo.dispose();
        }
      }, AUTHOR);

      const entries = await readyPage.evaluate(async () => {
        const tsgit = (window as unknown as { __tsgit: Tsgit }).__tsgit;
        const rootHandle = await navigator.storage.getDirectory();
        const repo = await tsgit.openRepository({ rootHandle });
        try {
          const log = await repo.log();
          return log.map((entry) => ({
            id: entry.id,
            message: entry.message,
            parents: entry.parents,
          }));
        } finally {
          await repo.dispose();
        }
      });

      await test.step('log returns both commits newest-first', () => {
        expect(entries.map((entry) => entry.message)).toEqual(['second commit', 'seed commit']);
      });

      await test.step('the newer commit links the older as its only parent', () => {
        expect(entries).toMatchObject([
          { parents: [seed.commitId] },
          { id: seed.commitId, parents: [] },
        ]);
      });
    });
  });

  test.describe('branch', () => {
    test('Given a seeded repo, When create→list→delete, Then the branch lifecycle is observable', async ({
      readyPage,
    }) => {
      await seedRepo(readyPage);

      const result = await readyPage.evaluate(async () => {
        const tsgit = (window as unknown as { __tsgit: Tsgit }).__tsgit;
        const rootHandle = await navigator.storage.getDirectory();
        const repo = await tsgit.openRepository({ rootHandle });
        try {
          const created = await repo.branch({ kind: 'create', name: 'feature' });
          const listed = await repo.branch({ kind: 'list' });
          const deleted = await repo.branch({ kind: 'delete', name: 'feature' });
          const remaining = await repo.branch({ kind: 'list' });
          return { created, listed, deleted, remaining };
        } finally {
          await repo.dispose();
        }
      });

      await test.step('create returns refs/heads/feature', () => {
        expect(result.created.kind).toBe('create');
        expect(result.created.name).toBe('refs/heads/feature');
        expect(result.created.id).toMatch(/^[0-9a-f]{40}$/);
      });

      await test.step('list shows feature beside the current main', () => {
        expect(result.listed.kind).toBe('list');
        expect(result.listed.branches).toContainEqual(
          expect.objectContaining({ name: 'refs/heads/main', current: true }),
        );
        expect(result.listed.branches).toContainEqual(
          expect.objectContaining({ name: 'refs/heads/feature', current: false }),
        );
      });

      await test.step('delete removes feature', () => {
        expect(result.deleted.kind).toBe('delete');
        expect(result.deleted.name).toBe('refs/heads/feature');
        expect(result.remaining.kind).toBe('list');
        expect(result.remaining.branches.map((info) => info.name)).not.toContain(
          'refs/heads/feature',
        );
      });
    });
  });

  test.describe('checkout', () => {
    test('Given divergent branches, When checkout switches, Then the working file matches each branch', async ({
      readyPage,
    }) => {
      const contents = await readyPage.evaluate(async (author) => {
        const tsgit = (window as unknown as { __tsgit: Tsgit }).__tsgit;
        const rootHandle = await navigator.storage.getDirectory();

        const writeA = async (text: string): Promise<void> => {
          const handle = await rootHandle.getFileHandle('a.txt', { create: true });
          const writable = await handle.createWritable();
          await writable.write(new TextEncoder().encode(text));
          await writable.close();
        };
        const readA = async (): Promise<string> => {
          const handle = await rootHandle.getFileHandle('a.txt');
          const file = await handle.getFile();
          return file.text();
        };

        // Inline seed (not seedRepo): a.txt must carry a known "v1" here so it
        // can diverge to "v2" on the feature branch and prove checkout swaps it.
        await writeA('v1\n');
        const repo = await tsgit.openRepository({ rootHandle });
        try {
          await repo.init();
          await repo.add(['a.txt']);
          await repo.commit({ message: 'v1 on main', author });
          await repo.branch({ kind: 'create', name: 'feature' });
          await repo.checkout({ target: 'feature' });
          await writeA('v2\n');
          await repo.add(['a.txt']);
          await repo.commit({ message: 'v2 on feature', author });
          await repo.checkout({ target: 'main' });
          const onMain = await readA();
          await repo.checkout({ target: 'feature' });
          const onFeature = await readA();
          return { onMain, onFeature };
        } finally {
          await repo.dispose();
        }
      }, AUTHOR);

      await test.step('checkout main materializes v1', () => {
        expect(contents.onMain).toBe('v1\n');
      });

      await test.step('checkout feature materializes v2', () => {
        expect(contents.onFeature).toBe('v2\n');
      });
    });
  });

  test.describe('tag', () => {
    test('Given a seeded repo, When create→list→delete a tag, Then the tag lifecycle is observable', async ({
      readyPage,
    }) => {
      await seedRepo(readyPage);

      const result = await readyPage.evaluate(async () => {
        const tsgit = (window as unknown as { __tsgit: Tsgit }).__tsgit;
        const rootHandle = await navigator.storage.getDirectory();
        const repo = await tsgit.openRepository({ rootHandle });
        try {
          const created = await repo.tag({ kind: 'create', name: 'v1' });
          const listed = await repo.tag({ kind: 'list' });
          const deleted = await repo.tag({ kind: 'delete', name: 'v1' });
          const remaining = await repo.tag({ kind: 'list' });
          return { created, listed, deleted, remaining };
        } finally {
          await repo.dispose();
        }
      });

      await test.step('create returns refs/tags/v1', () => {
        expect(result.created.kind).toBe('create');
        expect(result.created.name).toBe('refs/tags/v1');
        expect(result.created.id).toMatch(/^[0-9a-f]{40}$/);
      });

      await test.step('list shows v1', () => {
        expect(result.listed.kind).toBe('list');
        expect(result.listed.tags.map((info) => info.name)).toContain('refs/tags/v1');
      });

      await test.step('delete removes v1', () => {
        expect(result.deleted.kind).toBe('delete');
        expect(result.deleted.name).toBe('refs/tags/v1');
        expect(result.remaining.kind).toBe('list');
        expect(result.remaining.tags.map((info) => info.name)).not.toContain('refs/tags/v1');
      });
    });
  });
});
