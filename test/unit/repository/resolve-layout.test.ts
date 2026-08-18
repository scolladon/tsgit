import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import { fileSystemLayoutProbe } from '../../../src/repository/file-system-layout-probe.js';
import { resolveLayout } from '../../../src/repository/resolve-layout.js';

// `resolveLayout` composes the walk (`findLayout`) with the config-driven
// work-tree precedence (Stage 3) and the bareness formula (Stage 4), plus
// the EXPLICIT route (`opts.gitDir`), which skips the walk entirely.

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

  describe('The EXPLICIT route (opts.gitDir)', () => {
    describe('Given an explicit gitDir with nothing else set', () => {
      describe('When resolveLayout runs', () => {
        it('Then the work tree defaults to cwd — the explicit-route surprise', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/elsewhere',
            posixPolicy,
            {
              gitDir: '/repo/bare.git',
            },
          );

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/bare.git',
            workDir: '/repo/elsewhere',
            bare: false,
          });
        });
      });
    });

    describe('Given a relative gitDir', () => {
      describe('When resolveLayout runs', () => {
        it('Then it resolves against cwd', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');

          // Act
          const result = await resolveLayout(fileSystemLayoutProbe(fs), '/repo', posixPolicy, {
            gitDir: 'bare.git',
          });

          // Assert
          expect(result?.gitDir).toBe('/repo/bare.git');
        });
      });
    });

    describe('Given an explicit gitDir AND an explicit workDir', () => {
      describe('When resolveLayout runs', () => {
        it('Then the explicit workDir wins, resolved against cwd', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/config', '[core]\n\tbare = true\n');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/elsewhere',
            posixPolicy,
            {
              gitDir: '/repo/bare.git',
              workDir: 'wt',
            },
          );

          // Assert — an explicit work tree overrides core.bare=true silently,
          // no bogus-config flag (that flag only fires via core.worktree).
          expect(result).toStrictEqual({
            gitDir: '/repo/bare.git',
            workDir: '/repo/elsewhere/wt',
            bare: false,
          });
        });
      });
    });

    describe('Given opts.bare = true overriding an absent core.bare', () => {
      describe('When resolveLayout runs', () => {
        it('Then the argument tier wins outright and there is no work tree', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/target');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/target',
            posixPolicy,
            {
              gitDir: '/repo/target',
              bare: true,
            },
          );

          // Assert
          expect(result).toStrictEqual({ gitDir: '/repo/target', bare: true });
        });
      });
    });

    describe('Given opts.bare = false overriding core.bare = true', () => {
      describe('When resolveLayout runs', () => {
        it('Then the argument tier wins and a work tree defaults to cwd', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/target');
          await fs.writeUtf8('/repo/target/config', '[core]\n\tbare = true\n');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/target',
            posixPolicy,
            {
              gitDir: '/repo/target',
              bare: false,
            },
          );

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/target',
            workDir: '/repo/target',
            bare: false,
          });
        });
      });
    });

    describe('Given a gitDir naming a directory that does not exist', () => {
      describe('When resolveLayout runs', () => {
        it('Then it still resolves, leniently, with a work tree at cwd (R1c-5) — assertRepository refuses later, not this stage', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });

          // Act
          const result = await resolveLayout(fileSystemLayoutProbe(fs), '/repo', posixPolicy, {
            gitDir: '/repo/does-not-exist',
          });

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/does-not-exist',
            workDir: '/repo',
            bare: false,
          });
        });
      });
    });

    describe('Given a gitDir naming an existing empty directory', () => {
      describe('When resolveLayout runs', () => {
        it('Then it still resolves, leniently, with a work tree at cwd', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.mkdir('/repo/empty');

          // Act
          const result = await resolveLayout(fileSystemLayoutProbe(fs), '/repo', posixPolicy, {
            gitDir: '/repo/empty',
          });

          // Assert
          expect(result).toStrictEqual({ gitDir: '/repo/empty', workDir: '/repo', bare: false });
        });
      });
    });

    describe('Given a gitDir naming a regular file with a valid gitfile pointer', () => {
      describe('When resolveLayout runs', () => {
        it('Then it resolves through the gitfile grammar', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/admin');
          await fs.writeUtf8('/repo/pointer', 'gitdir: /repo/admin\n');

          // Act
          const result = await resolveLayout(fileSystemLayoutProbe(fs), '/repo', posixPolicy, {
            gitDir: '/repo/pointer',
          });

          // Assert
          expect(result?.gitDir).toBe('/repo/admin');
        });
      });
    });

    describe('Given a gitDir naming a regular file with malformed gitfile content', () => {
      describe('When resolveLayout runs', () => {
        it('Then it throws GITFILE_INVALID_FORMAT, inheriting the gitfile grammar refusal', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8('/repo/pointer', 'not a gitfile\n');

          // Act
          let caught: unknown;
          try {
            await resolveLayout(fileSystemLayoutProbe(fs), '/repo', posixPolicy, {
              gitDir: '/repo/pointer',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as { data?: { code?: string } })?.data?.code).toBe(
            'GITFILE_INVALID_FORMAT',
          );
        });
      });
    });

    describe('Given opts.workDir alone, with no gitDir and no repository anywhere', () => {
      describe('When resolveLayout runs', () => {
        it('Then it still returns undefined — a work tree alone never conjures a repository', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.mkdir('/repo/lonely');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/lonely',
            posixPolicy,
            {
              workDir: '/repo/wt',
            },
          );

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given an explicit gitDir pointing at a linked-worktree admin dir with its own commondir', () => {
      describe('When resolveLayout runs', () => {
        it('Then commonDir splits from gitDir, exactly as the walk resolves it', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8('/repo/bare.git/worktrees/wt/HEAD', 'ref: refs/heads/main\n');
          await fs.writeUtf8('/repo/bare.git/worktrees/wt/commondir', '../..\n');
          await fs.mkdir('/repo/bare.git/objects');
          await fs.mkdir('/repo/bare.git/refs');

          // Act
          const result = await resolveLayout(fileSystemLayoutProbe(fs), '/repo', posixPolicy, {
            gitDir: '/repo/bare.git/worktrees/wt',
          });

          // Assert
          expect(result?.gitDir).toBe('/repo/bare.git/worktrees/wt');
          expect(result?.commonDir).toBe('/repo/bare.git');
        });
      });
    });
  });
  describe('§1c rows previously untested across routes', () => {
    describe('Given route BARE_DIR with core.bare = true and an explicit workDir argument', () => {
      describe('When resolveLayout runs', () => {
        it('Then the argument wins silently: work tree present, bare false', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/config', '[core]\n\tbare = true\n');
          await fs.mkdir('/repo/wt');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/bare.git',
            posixPolicy,
            { workDir: '/repo/wt' },
          );

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/bare.git',
            workDir: '/repo/wt',
            bare: false,
          });
        });
      });
    });

    describe('Given route EXPLICIT with an absolute core.worktree in the config', () => {
      describe('When resolveLayout runs', () => {
        it('Then core.worktree is honoured on the explicit route too', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/normal/.git');
          await fs.writeUtf8('/repo/normal/.git/config', '[core]\n\tworktree = /repo/wt\n');
          await fs.mkdir('/repo/elsewhere');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/elsewhere',
            posixPolicy,
            { gitDir: '/repo/normal/.git' },
          );

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/normal/.git',
            workDir: '/repo/wt',
            bare: false,
          });
        });
      });
    });

    describe('Given route EXPLICIT with a relative core.worktree in the config', () => {
      describe('When resolveLayout runs without a physical-resolution capability', () => {
        it('Then the value resolves lexically against the gitDir, not against cwd', async () => {
          // Arrange — cwd-relative resolution would give /repo/elsewhere/wt2;
          // gitDir-relative gives /repo/wt2.
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/normal/.git');
          await fs.writeUtf8('/repo/normal/.git/config', '[core]\n\tworktree = ../../wt2\n');
          await fs.mkdir('/repo/elsewhere');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/elsewhere',
            posixPolicy,
            { gitDir: '/repo/normal/.git' },
          );

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/normal/.git',
            workDir: '/repo/wt2',
            bare: false,
          });
        });
      });
    });

    describe('Given route EXPLICIT with core.bare = true alone', () => {
      describe('When resolveLayout runs', () => {
        it('Then no work tree is defaulted at cwd — the config beats the route default', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/config', '[core]\n\tbare = true\n');
          await fs.mkdir('/repo/elsewhere');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/elsewhere',
            posixPolicy,
            { gitDir: '/repo/bare.git' },
          );

          // Assert
          expect(result).toStrictEqual({ gitDir: '/repo/bare.git', bare: true });
        });
      });
    });

    describe('Given a .git-file route whose gitdir config sets core.worktree', () => {
      describe('When resolveLayout runs', () => {
        it('Then core.worktree is honoured on the gitfile route — every route honours it', async () => {
          // Arrange — a separate-git-dir shape: the worktree holds a .git
          // pointer file; the external gitdir's config redirects the work tree.
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/external.git');
          await fs.writeUtf8('/repo/external.git/config', '[core]\n\tworktree = /repo/wt\n');
          await fs.mkdir('/repo/separate');
          await fs.writeUtf8('/repo/separate/.git', 'gitdir: /repo/external.git\n');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/separate',
            posixPolicy,
          );

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/external.git',
            workDir: '/repo/wt',
            bare: false,
          });
        });
      });
    });

    describe('Given route EXPLICIT naming a linked-worktree admin dir with shared core.bare = true', () => {
      describe('When resolveLayout runs', () => {
        it('Then the linked-worktree bypass does NOT apply — the explicit route stays bare', async () => {
          // Arrange — same fixture shape as the DISCOVERED-route bypass test,
          // but entered via opts.gitDir: the bypass is scoped to DISCOVERED.
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/config', '[core]\n\tbare = true\n');
          const admin = '/repo/bare.git/worktrees/wt';
          await fs.mkdir(admin);
          await fs.writeUtf8(`${admin}/HEAD`, 'ref: refs/heads/wt\n');
          await fs.writeUtf8(`${admin}/commondir`, '../..\n');
          await fs.mkdir('/repo/elsewhere');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/elsewhere',
            posixPolicy,
            { gitDir: admin },
          );

          // Assert — bare, no workDir: core.bare wins on the explicit route.
          expect(result).toStrictEqual({
            gitDir: admin,
            commonDir: '/repo/bare.git',
            bare: true,
          });
        });
      });
    });
  });
});
