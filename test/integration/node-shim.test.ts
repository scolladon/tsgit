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
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

describe('Node shim — symlinked root', () => {
  describe('Given a real repo and a symlink pointing at it, When openRepository opens the symlink path', () => {
    it('Then a read through the returned handle succeeds', async () => {
      // Arrange — the macOS /var -> /private/var / /tmp -> /private/tmp class:
      // cwd resolves through a symlink to a different real path, and the
      // adapter's containment roots must be derived from the REAL path.
      const setup = await openRepository({ cwd: tmpdir });
      await setup.init();
      await writeFile(path.join(tmpdir, 'a.txt'), 'hello\n');
      await setup.add(['a.txt']);
      await setup.commit({ message: 'first', author });
      await setup.dispose();
      const linkPath = `${tmpdir}-link`;
      await symlink(tmpdir, linkPath);

      // Act
      const sut = await openRepository({ cwd: linkPath });
      try {
        const status = await sut.status();

        // Assert
        expect(status.clean).toBe(true);
      } finally {
        await sut.dispose();
        await rm(linkPath, { force: true });
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

describe('Node shim — linked worktree discovery', () => {
  describe('Given a repo with a commit, When repo.worktree.add creates a linked worktree and openRepository opens it', () => {
    it('Then it resolves workDir/gitDir/commonDir', async () => {
      // Arrange — seed a repo with one commit, then create a linked worktree.
      // The sibling worktree path is built from the REALPATHED tmpdir (not the
      // raw one) — openRepository realpaths cwd internally, so a worktree path
      // built off the raw form would root the two sibling directories under
      // different (mismatched) prefixes on a symlinked tmp hierarchy (macOS
      // /var -> /private/var).
      const realTmpdir = await realpath(tmpdir);
      const setup = await openRepository({ cwd: tmpdir });
      await setup.init();
      await writeFile(path.join(tmpdir, 'a.txt'), 'hello\n');
      await setup.add(['a.txt']);
      await setup.commit({ message: 'first', author });
      const wt = `${realTmpdir}-wt`;
      const { id } = await setup.worktree.add({ path: wt, branch: 'wt' });
      await setup.dispose();

      // Act — open a fresh repo at the linked worktree path.
      const sut = await openRepository({ cwd: wt });
      try {
        // Assert
        expect(sut.ctx.layout.workDir).toBe(wt);
        expect(sut.ctx.layout.gitDir).toBe(path.join(realTmpdir, '.git', 'worktrees', id));
        expect(sut.ctx.layout.commonDir).toBe(path.join(realTmpdir, '.git'));
      } finally {
        await sut.dispose();
        await rm(wt, { recursive: true, force: true });
      }
    });
  });

  describe('Given a plain (non-worktree) repo, When openRepository runs', () => {
    it('Then the layout carries no commonDir key', async () => {
      // Arrange
      const setup = await openRepository({ cwd: tmpdir });
      await setup.init();
      await setup.dispose();

      // Act
      const sut = await openRepository({ cwd: tmpdir });
      try {
        // Assert
        expect('commonDir' in sut.ctx.layout).toBe(false);
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

/**
 * A linked worktree and the main repo are siblings, so their common ancestor
 * is a directory that belongs to neither. Rooting the raw adapter there would
 * make every sibling readable and writable through a symlink planted inside
 * the worktree — the facade's multi-root validator is purely lexical and
 * never resolves the link.
 */
const seedWorktreeWithEscapeLink = async (): Promise<{
  readonly worktreePath: string;
  readonly secretFile: string;
  readonly cleanup: () => Promise<void>;
}> => {
  const realTmpdir = await realpath(tmpdir);
  const secretDir = `${realTmpdir}-secret`;
  await mkdir(secretDir, { recursive: true });
  await writeFile(path.join(secretDir, 'key.txt'), 'secret content\n');
  const setup = await openRepository({ cwd: realTmpdir });
  await setup.init();
  await writeFile(path.join(realTmpdir, 'a.txt'), 'hello\n');
  await setup.add(['a.txt']);
  await setup.commit({ message: 'first', author });
  const worktreePath = `${realTmpdir}-wt`;
  await setup.worktree.add({ path: worktreePath, branch: 'wt' });
  await setup.dispose();
  await symlink(secretDir, path.join(worktreePath, 'link'));
  return {
    worktreePath,
    secretFile: path.join(secretDir, 'key.txt'),
    cleanup: async () => {
      await rm(worktreePath, { recursive: true, force: true });
      await rm(secretDir, { recursive: true, force: true });
    },
  };
};

describe('Node shim — linked-worktree containment', () => {
  describe('Given a linked worktree holding a symlink to a directory outside every layout root', () => {
    describe('When adding a path through that symlink', () => {
      it('Then the pathspec is refused as beyond a symbolic link and nothing is staged', async () => {
        // Arrange
        const { worktreePath, cleanup } = await seedWorktreeWithEscapeLink();
        const sut = await openRepository({ cwd: worktreePath });

        try {
          // Act
          let caught: unknown;
          try {
            await sut.add(['link/key.txt']);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as { data: { code: string; path: string } }).data).toEqual({
            code: 'PATHSPEC_BEYOND_SYMLINK',
            path: 'link/key.txt',
          });
          expect((await sut.status()).changes).toHaveLength(0);
        } finally {
          await sut.dispose();
          await cleanup();
        }
      });
    });

    describe('When reading the outside file through the raw adapter', () => {
      it('Then it throws PERMISSION_DENIED', async () => {
        // Arrange — `unsafeRawAdapters` bypasses the lexical facade validator,
        // leaving the adapter's realpath containment as the only gate.
        const { worktreePath, secretFile, cleanup } = await seedWorktreeWithEscapeLink();
        const sut = await openRepository({ cwd: worktreePath, unsafeRawAdapters: true });

        try {
          // Act
          let caught: unknown;
          try {
            await sut.ctx.fs.readUtf8(secretFile);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as { data: unknown }).data).toEqual({
            code: 'PERMISSION_DENIED',
            path: secretFile,
          });
        } finally {
          await sut.dispose();
          await cleanup();
        }
      });
    });
  });
});
