import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import { fileSystemLayoutProbe } from '../../../src/repository/file-system-layout-probe.js';
import { resolveLayout } from '../../../src/repository/resolve-layout.js';

// `resolveLayout` composes the walk (`findLayout`) with the config-driven
// work-tree precedence (design's Stage 3) and the bareness formula (Stage 4).
// This part implements only the discovery routes — DISCOVERED and BARE_DIR;
// the EXPLICIT route (opts.gitDir) is Part 4.

/** Marks `dir` as a valid git directory: `objects/`, `refs/`, and a `HEAD` file. */
const makeGitDir = async (fs: MemoryFileSystem, dir: string): Promise<void> => {
  await fs.mkdir(`${dir}/objects`);
  await fs.mkdir(`${dir}/refs`);
  await fs.writeUtf8(`${dir}/HEAD`, 'ref: refs/heads/main\n');
};

describe('resolveLayout', () => {
  describe('Given no .git anywhere and cwd is not itself a git directory', () => {
    describe('When resolveLayout runs', () => {
      it('Then it returns undefined', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.mkdir('/repo/lonely');

        // Act
        const result = await resolveLayout(fileSystemLayoutProbe(fs), '/repo/lonely', posixPolicy);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Stage 3 precedence — discovery routes only', () => {
    describe('Given route BARE_DIR with core.bare = true alone (no core.worktree)', () => {
      describe('When resolveLayout runs', () => {
        it('Then no work tree, bare true, no bogus flag', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/config', '[core]\n\tbare = true\n');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/bare.git',
            posixPolicy,
          );

          // Assert
          expect(result).toStrictEqual({ gitDir: '/repo/bare.git', bare: true });
        });
      });
    });

    describe('Given route BARE_DIR with core.bare = true AND core.worktree set', () => {
      describe('When resolveLayout runs', () => {
        it('Then no work tree, bare true, workTreeConfigBogus true', async () => {
          // Arrange — the two config keys disagree; git warns and marks the
          // work-tree config bogus rather than picking a winner.
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8(
            '/repo/bare.git/config',
            '[core]\n\tbare = true\n\tworktree = /repo/wt\n',
          );

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/bare.git',
            posixPolicy,
          );

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/bare.git',
            bare: true,
            workTreeConfigBogus: true,
          });
        });
      });
    });

    describe('Given route DISCOVERED with core.worktree set to an absolute path', () => {
      describe('When resolveLayout runs', () => {
        it('Then the work tree is that absolute path verbatim', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/normal/.git');
          await fs.writeUtf8('/repo/normal/.git/config', '[core]\n\tworktree = /repo/custom-wt\n');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/normal',
            posixPolicy,
          );

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/normal/.git',
            workDir: '/repo/custom-wt',
            bare: false,
          });
        });
      });
    });

    describe('Given route DISCOVERED with core.worktree set to a relative path', () => {
      describe('When resolveLayout runs', () => {
        it('Then the work tree resolves against gitDir, not the directory holding .git', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/normal/.git');
          await fs.writeUtf8('/repo/normal/.git/config', '[core]\n\tworktree = ../../other-wt\n');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/normal',
            posixPolicy,
          );

          // Assert — resolved lexically against gitDir here; the node shim
          // realpaths the result afterward, this tier stays lexical.
          expect(result).toStrictEqual({
            gitDir: '/repo/normal/.git',
            workDir: '/repo/other-wt',
            bare: false,
          });
        });
      });
    });

    describe('Given route DISCOVERED with nothing above (a plain repo)', () => {
      describe('When resolveLayout runs', () => {
        it('Then the work tree is the directory holding the .git entry', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/normal/.git');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/normal',
            posixPolicy,
          );

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/normal/.git',
            workDir: '/repo/normal',
            bare: false,
          });
        });
      });
    });

    describe('Given route BARE_DIR with nothing above (a clone --bare shape, no config)', () => {
      describe('When resolveLayout runs', () => {
        it('Then there is no work tree', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/bare.git',
            posixPolicy,
          );

          // Assert
          expect(result).toStrictEqual({ gitDir: '/repo/bare.git', bare: true });
        });
      });
    });
  });

  describe('Given a linked worktree admin dir whose shared config sets core.bare = true', () => {
    describe('When resolveLayout runs at the worktree path', () => {
      it('Then it still resolves a work tree and bare is false — a linked worktree always has one', async () => {
        // Arrange — `core.bare` lives in the SHARED config (read from
        // commonDir), so it is visible from every linked worktree of a bare
        // main repo too; but a linked worktree's admin dir (recognised by
        // its own `commondir` file pointing elsewhere) always has a work
        // tree regardless of what the shared config says about the main
        // checkout. Measured: `--is-bare-repository` is false from inside
        // such a worktree even though the shared `core.bare` reads true.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/bare.git');
        await fs.writeUtf8('/repo/bare.git/config', '[core]\n\tbare = true\n');
        await fs.writeUtf8('/repo/bare.git/worktrees/wt/HEAD', 'ref: refs/heads/main\n');
        await fs.writeUtf8('/repo/bare.git/worktrees/wt/commondir', '../..\n');
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/bare.git/worktrees/wt\n');

        // Act
        const result = await resolveLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/bare.git/worktrees/wt',
          commonDir: '/repo/bare.git',
          workDir: '/repo/wt',
          bare: false,
        });
      });
    });
  });

  describe('Stage 4 — the bareness formula truth table', () => {
    describe('Given core.bare is absent entirely, on the BARE_DIR route', () => {
      describe('When resolveLayout runs', () => {
        it('Then bare is true — absent core.bare is truthy, not falsy', async () => {
          // Arrange — the single most-likely-to-be-got-wrong row: git's
          // `is_bare_repository_cfg` defaults to -1 (truthy), not 0.
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/bare.git',
            posixPolicy,
          );

          // Assert
          expect(result?.bare).toBe(true);
        });
      });
    });

    describe('Given core.bare = false explicitly, on the BARE_DIR route (worktree-less non-bare)', () => {
      describe('When resolveLayout runs', () => {
        it('Then bare is false even though there is no work tree', async () => {
          // Arrange — `cd normal/.git`-shaped: `is_bare_repository()` is
          // false, but git's work-tree commands still refuse (a distinct
          // question the gate, not this formula, answers).
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/dotgit');
          await fs.writeUtf8('/repo/dotgit/config', '[core]\n\tbare = false\n');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/dotgit',
            posixPolicy,
          );

          // Assert
          expect(result).toStrictEqual({ gitDir: '/repo/dotgit', bare: false });
        });
      });
    });

    describe('Given core.bare = true, on the BARE_DIR route', () => {
      describe('When resolveLayout runs', () => {
        it('Then bare is true', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/config', '[core]\n\tbare = true\n');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/bare.git',
            posixPolicy,
          );

          // Assert
          expect(result?.bare).toBe(true);
        });
      });
    });

    describe('Given a work tree is present regardless of core.bare', () => {
      describe('When resolveLayout runs', () => {
        it('Then bare is false — a resolved work tree always wins', async () => {
          // Arrange — a plain discovered repo whose config happens to carry
          // `core.bare = true` alongside `core.worktree` is covered by the
          // bogus-config row above; this row pins the ordinary DISCOVERED
          // case where no `core.bare` key exists at all and a work tree
          // resolves from the route.
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/normal/.git');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/normal',
            posixPolicy,
          );

          // Assert
          expect(result?.bare).toBe(false);
          expect(result?.workDir).toBe('/repo/normal');
        });
      });
    });
  });

  describe('Given a sub-directory of a plain repo (workDir up the tree)', () => {
    describe('When resolveLayout runs', () => {
      it('Then the resolved layout is identical to running from the workDir root', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/normal/.git');
        await fs.mkdir('/repo/normal/sub/dir');

        // Act
        const result = await resolveLayout(
          fileSystemLayoutProbe(fs),
          '/repo/normal/sub/dir',
          posixPolicy,
        );

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/normal/.git',
          workDir: '/repo/normal',
          bare: false,
        });
      });
    });
  });
});
