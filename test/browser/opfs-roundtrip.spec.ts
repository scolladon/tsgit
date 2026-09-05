/// <reference lib="dom" />
/**
 * Scenario 1 — OPFS round-trip, asserted per git operation.
 *
 * Given an OPFS root with a working file,
 * When init → add → commit → status run in one browser evaluation,
 * Then each operation's result is asserted under its own step, so a failure
 *   names the exact git operation that broke instead of a trailing aggregate.
 */
import { expect, runOpfsRoundTrip, test } from './fixtures.js';

// Playwright's WebKit headless build does not expose
// navigator.storage.getDirectory (OPFS works in production Safari but is
// gated off in the test browser). Skip OPFS-dependent scenarios on webkit;
// SubtleCrypto + DecompressionStream coverage still runs there.
test.describe('OPFS round-trip', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'OPFS not exposed in Playwright WebKit');

  test('Given an OPFS root, When init→add→commit→status run, Then each operation passes on its own step', async ({
    readyPage,
  }) => {
    const result = await runOpfsRoundTrip(readyPage, '__tsgit', 'first browser commit');

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

// Local typing aid for the surface these three cases drive — not a shared
// contract; the real class lives in src/adapters/browser/browser-file-system.ts.
interface OpfsFs {
  mkdir(path: string): Promise<void>;
  write(path: string, data: Uint8Array): Promise<void>;
  writeExclusive(path: string, data: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<ReadonlyArray<{ name: string }>>;
  rename(src: string, dst: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory: boolean }>;
  exists(path: string): Promise<boolean>;
}

test.describe('OPFS directory-occupant refusals', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'OPFS not exposed in Playwright WebKit');

  test('Given a directory occupying the target path, When writeExclusive, Then it throws FILE_EXISTS against real OPFS', async ({
    readyPage,
  }) => {
    const result = await readyPage.evaluate(async () => {
      const MODULE_PATH = '/dist/esm/adapters/browser/index.js';
      const mod = (await import(MODULE_PATH)) as {
        BrowserFileSystem: new (rootHandle: FileSystemDirectoryHandle) => OpfsFs;
      };
      const sut = new mod.BrowserFileSystem(await navigator.storage.getDirectory());

      await sut.mkdir('occupant-1');
      await sut.write('occupant-1/child.txt', new Uint8Array([1, 2, 3]));

      let code: string | undefined;
      let path: string | undefined;
      try {
        await sut.writeExclusive('occupant-1', new Uint8Array([9]));
      } catch (err) {
        const data = (err as { data?: { code?: string; path?: string } }).data;
        code = data?.code;
        path = data?.path;
      }

      const entries = await sut.readdir('occupant-1');
      const childBytes = await sut.read('occupant-1/child.txt');

      return {
        code,
        path,
        childNames: entries.map((entry) => entry.name),
        childBytes: Array.from(childBytes),
      };
    });

    await test.step('writeExclusive reports FILE_EXISTS on the directory path', () => {
      expect(result.code).toBe('FILE_EXISTS');
      expect(result.path).toBe('occupant-1');
    });

    await test.step('the directory and its child are still there afterwards', () => {
      expect(result.childNames).toContain('child.txt');
      expect(result.childBytes).toEqual([1, 2, 3]);
    });
  });

  test('Given a directory occupying the target path, When write, Then it throws PERMISSION_DENIED against real OPFS', async ({
    readyPage,
  }) => {
    const result = await readyPage.evaluate(async () => {
      const MODULE_PATH = '/dist/esm/adapters/browser/index.js';
      const mod = (await import(MODULE_PATH)) as {
        BrowserFileSystem: new (rootHandle: FileSystemDirectoryHandle) => OpfsFs;
      };
      const sut = new mod.BrowserFileSystem(await navigator.storage.getDirectory());

      await sut.mkdir('occupant-2');
      await sut.write('occupant-2/child.txt', new Uint8Array([4, 5, 6]));

      let code: string | undefined;
      let path: string | undefined;
      try {
        await sut.write('occupant-2', new Uint8Array([9]));
      } catch (err) {
        const data = (err as { data?: { code?: string; path?: string } }).data;
        code = data?.code;
        path = data?.path;
      }

      const entries = await sut.readdir('occupant-2');
      const childBytes = await sut.read('occupant-2/child.txt');
      const dirStat = await sut.stat('occupant-2');
      const dirExists = await sut.exists('occupant-2');

      // The ancestor-fault mapping must not move: a regular file blocking an
      // ancestor segment still reports FILE_NOT_FOUND, not PERMISSION_DENIED.
      await sut.write('ancestor-file.txt', new Uint8Array([7]));
      let ancestorCode: string | undefined;
      try {
        await sut.write('ancestor-file.txt/nested.txt', new Uint8Array([8]));
      } catch (err) {
        const data = (err as { data?: { code?: string } }).data;
        ancestorCode = data?.code;
      }

      return {
        code,
        path,
        childNames: entries.map((entry) => entry.name),
        childBytes: Array.from(childBytes),
        isDirectory: dirStat.isDirectory,
        dirExists,
        ancestorCode,
      };
    });

    await test.step('write on a directory reports PERMISSION_DENIED', () => {
      expect(result.code).toBe('PERMISSION_DENIED');
      expect(result.path).toBe('occupant-2');
    });

    await test.step('the directory and its child are unchanged', () => {
      expect(result.childNames).toContain('child.txt');
      expect(result.childBytes).toEqual([4, 5, 6]);
    });

    await test.step('stat and exists still resolve the create:false mapping on a directory', () => {
      expect(result.isDirectory).toBe(true);
      expect(result.dirExists).toBe(true);
    });

    await test.step('a regular file blocking an ancestor segment still reports FILE_NOT_FOUND', () => {
      expect(result.ancestorCode).toBe('FILE_NOT_FOUND');
    });
  });

  test('Given a file source and a directory destination, When rename, Then it throws PERMISSION_DENIED and the source survives', async ({
    readyPage,
  }) => {
    const result = await readyPage.evaluate(async () => {
      const MODULE_PATH = '/dist/esm/adapters/browser/index.js';
      const mod = (await import(MODULE_PATH)) as {
        BrowserFileSystem: new (rootHandle: FileSystemDirectoryHandle) => OpfsFs;
      };
      const sut = new mod.BrowserFileSystem(await navigator.storage.getDirectory());

      await sut.write('src.txt', new Uint8Array([1, 2, 3]));
      await sut.mkdir('dst-dir');
      await sut.write('dst-dir/child.txt', new Uint8Array([4, 5, 6]));

      let code: string | undefined;
      let path: string | undefined;
      try {
        await sut.rename('src.txt', 'dst-dir');
      } catch (err) {
        const data = (err as { data?: { code?: string; path?: string } }).data;
        code = data?.code;
        path = data?.path;
      }

      const srcBytes = await sut.read('src.txt');
      const entries = await sut.readdir('dst-dir');
      const childBytes = await sut.read('dst-dir/child.txt');

      return {
        code,
        path,
        srcBytes: Array.from(srcBytes),
        dstNames: entries.map((entry) => entry.name),
        dstChildBytes: Array.from(childBytes),
      };
    });

    await test.step('rename onto a directory destination reports PERMISSION_DENIED', () => {
      expect(result.code).toBe('PERMISSION_DENIED');
      expect(result.path).toBe('dst-dir');
    });

    await test.step('the source file survives — rm never ran', () => {
      expect(result.srcBytes).toEqual([1, 2, 3]);
    });

    await test.step('the destination directory is unchanged', () => {
      expect(result.dstNames).toContain('child.txt');
      expect(result.dstChildBytes).toEqual([4, 5, 6]);
    });
  });
  test('Given a regular file, When rename onto itself, Then it is a no-op and the file survives', async ({
    readyPage,
  }) => {
    const result = await readyPage.evaluate(async () => {
      const MODULE_PATH = '/dist/esm/adapters/browser/index.js';
      const mod = (await import(MODULE_PATH)) as {
        BrowserFileSystem: new (rootHandle: FileSystemDirectoryHandle) => OpfsFs;
      };
      const sut = new mod.BrowserFileSystem(await navigator.storage.getDirectory());
      await sut.write('same.txt', new Uint8Array([7, 8, 9]));

      await sut.rename('same.txt', 'same.txt');
      const survivor = await sut.exists('same.txt');
      const bytes = survivor ? Array.from(await sut.read('same.txt')) : [];

      let absentCode: string | undefined;
      try {
        await sut.rename('missing.txt', 'missing.txt');
      } catch (err) {
        absentCode = (err as { data?: { code?: string } }).data?.code;
      }

      return { survivor, bytes, absentCode };
    });

    await test.step('the file is still there with its bytes — the emulation never unlinked it', () => {
      expect(result.survivor).toBe(true);
      expect(result.bytes).toEqual([7, 8, 9]);
    });

    await test.step('an absent source is still refused with FILE_NOT_FOUND', () => {
      expect(result.absentCode).toBe('FILE_NOT_FOUND');
    });
  });
});
