import { describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.browser.js';

// The browser shim only stores the `rootHandle` (BrowserFileSystem's
// constructor never touches it) and `openRepository` performs no eager
// I/O, so a stub handle is sufficient to assert the ctx it builds.
const fakeHandle = {} as unknown as FileSystemDirectoryHandle;

describe('browser shim — openRepository', () => {
  describe('Given only a rootHandle', () => {
    describe('When openRepository runs', () => {
      it('Then the layout workDir is "/"', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert — kills ROOT_WORK_DIR `'/'` → `""`.
        expect(sut.ctx.layout.workDir).toBe('/');
      });
      it('Then ctx.cwd is "/" (forwarded as the core cwd)', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert — kills the L69 ObjectLiteral `{ cwd, ...coreOpts }` → `{}`
        // mutant: with `{}` the core would fall back to `defaultCwd()`.
        expect(sut.ctx.cwd).toBe('/');
      });
    });
  });

  describe('Given no gitDirName', () => {
    describe('When openRepository runs', () => {
      it('Then gitDir is "/.git" (default name under the root)', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert — kills DEFAULT_GIT_DIR_NAME `'.git'` → `""` AND the L50
        // template-literal `` `${ROOT_WORK_DIR}${gitDirName}` `` → `` `` ``.
        expect(sut.ctx.layout.gitDir).toBe('/.git');
      });
    });
  });

  describe('Given an explicit gitDirName', () => {
    describe('When openRepository runs', () => {
      it('Then gitDir uses that name (the `??` keeps the supplied value)', async () => {
        // Arrange / Act — kills L41 LogicalOperator `??` → `&&`: with `&&`
        // a supplied gitDirName would be discarded for DEFAULT_GIT_DIR_NAME.
        const sut = await openRepository({ rootHandle: fakeHandle, gitDirName: 'dot-git' });

        // Assert
        expect(sut.ctx.layout.gitDir).toBe('/dot-git');
      });
    });
  });

  describe('Given no bare flag', () => {
    describe('When openRepository runs', () => {
      it('Then layout.bare defaults to false', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert — kills L51 BooleanLiteral `false` → `true`.
        expect(sut.ctx.layout.bare).toBe(false);
      });
    });
  });

  describe('Given bare:true', () => {
    describe('When openRepository runs', () => {
      it('Then layout.bare is true', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle, bare: true });

        // Assert
        expect(sut.ctx.layout.bare).toBe(true);
      });
    });
  });

  describe('Given no deltaCacheMaxBytes', () => {
    describe('When openRepository runs', () => {
      it('Then the delta cache maxSize is 16 MiB', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert — kills the two L20 ArithmeticOperator mutants on
        // `16 * 1024 * 1024` (any `*` → `/` yields a tiny non-16 MiB value).
        expect(sut.ctx.deltaCache.maxSize).toBe(16 * 1024 * 1024);
      });
    });
  });

  describe('Given an explicit deltaCacheMaxEntries', () => {
    describe('When the cache exceeds it', () => {
      it('Then it evicts down to that cap (the `??` keeps the supplied value)', async () => {
        // Arrange — kills L56 LogicalOperator `??` → `&&`: with `&&` a
        // supplied entry cap would be discarded for DEFAULT_DELTA_CACHE_ENTRIES
        // (65 536), so a 4th tiny entry would NOT evict.
        const sut = await openRepository({ rootHandle: fakeHandle, deltaCacheMaxEntries: 3 });
        const one = new Uint8Array([1]);

        // Act — insert four single-byte entries (each well under maxSize).
        sut.ctx.deltaCache.set('a', one, 1);
        sut.ctx.deltaCache.set('b', one, 1);
        sut.ctx.deltaCache.set('c', one, 1);
        sut.ctx.deltaCache.set('d', one, 1);

        // Assert — the cap of 3 evicted the least-recently-used entry.
        expect(sut.ctx.deltaCache.entryCount).toBe(3);
      });
    });
  });

  describe('Given the browser runtime', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.ssh and ctx.env stay undefined and ctx.runtime is browser', async () => {
        // Arrange / Act — the browser shim cannot spawn a process or read
        // real environment variables, so it wires neither `ssh` nor `env`.
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert
        expect(sut.ctx.ssh).toBeUndefined();
        expect(sut.ctx.env).toBeUndefined();
        expect(sut.ctx.runtime).toBe('browser');
      });
    });
  });
});
