/**
 * Node-runtime integration. Exercises src/index.node.ts against a real tmpdir
 * (no in-memory fs) so the runtime shim's own code path is mutation-tested
 * end-to-end. Closes the 0%-coverage gap on src/index.node.ts that the unit
 * suite cannot reach (it stubs adapters; the shim is what builds them).
 *
 * @proves
 *   surface: nodeShim
 *   bucket:  coverage-gap
 *   unique:  src/index.node.ts runtime-shim adapter construction path the unit suite cannot reach
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openRepository } from '../../src/index.node.js';

let tmpdir: string;

const author = {
  name: 'Test',
  email: 'test@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-it-'));
});

afterEach(async () => {
  await rm(tmpdir, { recursive: true, force: true });
});

describe('Node shim — bootstrap', () => {
  describe('Given a tmpdir as cwd, When openRepository runs', () => {
    it('Then it returns a Repository with cwd resolved by nodePath', async () => {
      // Arrange & Act
      const sut = await openRepository({ cwd: tmpdir });
      try {
        // Assert
        expect(sut.ctx.cwd).toBe(await realpath(tmpdir));
        expect(sut.ctx.layout.workDir).toBe(await realpath(tmpdir));
        expect(sut.ctx.layout.gitDir).toBe(path.join(await realpath(tmpdir), '.git'));
      } finally {
        await sut.dispose();
      }
    });
  });

  describe('Given no cwd argument, When openRepository runs', () => {
    it('Then it falls back to process.cwd()', async () => {
      // Arrange & Act
      const sut = await openRepository();
      try {
        // Assert
        expect(sut.ctx.cwd).toBe(await realpath(process.cwd()));
      } finally {
        await sut.dispose();
      }
    });
  });
});

describe('Node shim — round-trip', () => {
  describe('Given a fresh tmpdir, When init → status', () => {
    it('Then the repo is reported clean and on refs/heads/main', async () => {
      // Arrange
      const sut = await openRepository({ cwd: tmpdir });
      try {
        // Act
        await sut.init();
        const status = await sut.status();

        // Assert
        expect(status.clean).toBe(true);
        expect(status.branch).toBe('refs/heads/main');
      } finally {
        await sut.dispose();
      }
    });
  });

  describe('Given a fresh tmpdir AND a working-tree file, When add → commit → log', () => {
    it('Then log returns one commit referencing the staged file', async () => {
      // Arrange
      await writeFile(path.join(tmpdir, 'a.txt'), 'hello\n');
      const sut = await openRepository({ cwd: tmpdir });
      try {
        await sut.init();

        // Act
        await sut.add(['a.txt']);
        const result = await sut.commit({ message: 'first', author });
        const log = await sut.log();

        // Assert
        expect(log).toHaveLength(1);
        expect(log[0]?.id).toBe(result.id);
      } finally {
        await sut.dispose();
      }
    });
  });
});

describe('Node shim — findLayout walk-up', () => {
  describe('Given a sub-directory of an initialized repo as cwd, When openRepository runs', () => {
    it('Then findLayout discovers the parent .git', async () => {
      // Arrange — initialize at tmpdir, then point cwd at a sub-directory.
      const setup = await openRepository({ cwd: tmpdir });
      try {
        await setup.init();
      } finally {
        await setup.dispose();
      }
      const sub = path.join(tmpdir, 'sub', 'dir');
      await mkdir(sub, { recursive: true });

      // Act — open from the sub-directory.
      const sut = await openRepository({ cwd: sub });
      try {
        // Assert — workDir is the parent (where .git lives), NOT the sub-dir.
        expect(sut.ctx.layout.workDir).toBe(await realpath(tmpdir));
        expect(sut.ctx.layout.gitDir).toBe(path.join(await realpath(tmpdir), '.git'));
      } finally {
        await sut.dispose();
      }
    });
  });

  describe('Given a tmpdir with NO .git anywhere up-tree, When openRepository runs', () => {
    it('Then layout defaults to {cwd}/.git (init/clone path)', async () => {
      // Arrange & Act
      const sut = await openRepository({ cwd: tmpdir });
      try {
        // Assert
        expect(sut.ctx.layout.gitDir).toBe(path.join(await realpath(tmpdir), '.git'));
        expect(sut.ctx.layout.bare).toBe(false);
      } finally {
        await sut.dispose();
      }
    });
  });
});

describe('Node shim — dispose', () => {
  describe('Given a disposed repo, When any bound method is invoked', () => {
    it('Then it throws REPOSITORY_DISPOSED', async () => {
      // Arrange
      const sut = await openRepository({ cwd: tmpdir });
      await sut.dispose();

      // Act
      try {
        await sut.init();
        expect.unreachable();
      } catch (err) {
        // Assert
        expect((err as { data: { code: string } }).data.code).toBe('REPOSITORY_DISPOSED');
      }
    });
  });

  describe('Given a user-supplied AbortSignal, When the signal aborts', () => {
    it('Then bound methods throw REPOSITORY_DISPOSED via the atomic gate', async () => {
      // Arrange
      const controller = new AbortController();
      const sut = await openRepository({ cwd: tmpdir, signal: controller.signal });
      try {
        // Act
        controller.abort();
        try {
          await sut.init();
          expect.unreachable();
        } catch (err) {
          // Assert
          expect((err as { data: { code: string } }).data.code).toBe('REPOSITORY_DISPOSED');
        }
      } finally {
        // dispose() itself is no-op past abort; calling it cleans up the controller.
        await sut.dispose();
      }
    });
  });
});
