import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import { TsgitError } from '../../../src/domain/error.js';
import { fileSystemLayoutProbe } from '../../../src/repository/file-system-layout-probe.js';
import { resolveLayout, syntheticFallbackLayout } from '../../../src/repository/resolve-layout.js';

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
          expect(result).toStrictEqual({
            gitDir: '/repo/bare.git',
            bare: true,
            objectFormat: 'sha1',
            refStorage: 'files',
          });
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
            objectFormat: 'sha1',
            refStorage: 'files',
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
            objectFormat: 'sha1',
            refStorage: 'files',
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
            objectFormat: 'sha1',
            refStorage: 'files',
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
            objectFormat: 'sha1',
            refStorage: 'files',
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
          expect(result).toStrictEqual({
            gitDir: '/repo/bare.git',
            bare: true,
            objectFormat: 'sha1',
            refStorage: 'files',
          });
        });
      });
    });
  });

  describe('The objectFormat channel', () => {
    describe('Given extensions.objectFormat = sha256 in the repository config', () => {
      describe('When resolveLayout runs', () => {
        it('Then the returned layout carries objectFormat: sha256', async () => {
          // Arrange — the config declares version 1, which is what makes the
          // extension load-bearing: git honours `extensions.*` only from
          // version 1 up, so a fixture without the key would assert a format
          // git itself ignores.
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/sha256/.git');
          await fs.writeUtf8(
            '/repo/sha256/.git/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n',
          );

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/sha256',
            posixPolicy,
          );

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/sha256/.git',
            workDir: '/repo/sha256',
            bare: false,
            objectFormat: 'sha256',
            refStorage: 'files',
          });
        });
      });
    });

    describe('Given no extensions.objectFormat in the repository config (the sha1 default)', () => {
      describe('When resolveLayout runs', () => {
        it("Then the returned layout carries objectFormat: 'sha1' — unconditionally, not omitted", async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/sha1/.git');

          // Act
          const result = await resolveLayout(fileSystemLayoutProbe(fs), '/repo/sha1', posixPolicy);

          // Assert — an OPENED repository's format is always resolvable (unlike
          // the bootstrap path, which never sets this field at all); the
          // resolveAlgorithm contradiction check depends on this being present
          // even for the undeclared (sha1) case.
          expect(result).toStrictEqual({
            gitDir: '/repo/sha1/.git',
            workDir: '/repo/sha1',
            bare: false,
            objectFormat: 'sha1',
            refStorage: 'files',
          });
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
          objectFormat: 'sha1',
          refStorage: 'files',
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
          expect(result).toStrictEqual({
            gitDir: '/repo/dotgit',
            bare: false,
            objectFormat: 'sha1',
            refStorage: 'files',
          });
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
          objectFormat: 'sha1',
          refStorage: 'files',
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
            objectFormat: 'sha1',
            refStorage: 'files',
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
            objectFormat: 'sha1',
            refStorage: 'files',
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
          expect(result).toStrictEqual({
            gitDir: '/repo/target',
            bare: true,
            objectFormat: 'sha1',
            refStorage: 'files',
          });
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
            objectFormat: 'sha1',
            refStorage: 'files',
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
            objectFormat: 'sha1',
            refStorage: 'files',
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
          expect(result).toStrictEqual({
            gitDir: '/repo/empty',
            workDir: '/repo',
            bare: false,
            objectFormat: 'sha1',
            refStorage: 'files',
          });
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
  describe('work-tree precedence rows across every route', () => {
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
            objectFormat: 'sha1',
            refStorage: 'files',
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
            objectFormat: 'sha1',
            refStorage: 'files',
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
            objectFormat: 'sha1',
            refStorage: 'files',
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
          expect(result).toStrictEqual({
            gitDir: '/repo/bare.git',
            bare: true,
            objectFormat: 'sha1',
            refStorage: 'files',
          });
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
            objectFormat: 'sha1',
            refStorage: 'files',
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
            objectFormat: 'sha1',
            refStorage: 'files',
          });
        });
      });
    });
  });
  describe('Given a relative core.worktree and a physical-resolution capability', () => {
    describe('When the capability resolves the join to a real path', () => {
      it('Then the physical path is the work tree', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/normal/.git');
        await fs.writeUtf8('/repo/normal/.git/config', '[core]\n\tworktree = ../../wt\n');

        let seenJoin: string | undefined;

        // Act
        const result = await resolveLayout(
          fileSystemLayoutProbe(fs),
          '/repo/normal',
          posixPolicy,
          {},
          {
            realWorkTreePath: async (joined) => {
              seenJoin = joined;
              return '/repo/physical-wt';
            },
          },
        );

        // Assert — the capability receives the GITDIR-relative join, and its
        // physical answer becomes the work tree.
        expect(seenJoin).toBe('/repo/wt');
        expect(result).toStrictEqual({
          gitDir: '/repo/normal/.git',
          workDir: '/repo/physical-wt',
          bare: false,
          objectFormat: 'sha1',
          refStorage: 'files',
        });
      });
    });

    describe('When the capability cannot resolve the join', () => {
      it('Then it refuses with WORK_TREE_UNRESOLVABLE naming the raw value and the gitDir', async () => {
        // Arrange — git changes directory to resolve a relative core.worktree,
        // so a missing target is a setup refusal, not a lexical fallback.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/normal/.git');
        await fs.writeUtf8('/repo/normal/.git/config', '[core]\n\tworktree = ../missing\n');

        // Act
        let caught: unknown;
        try {
          await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/normal',
            posixPolicy,
            {},
            { realWorkTreePath: async () => undefined },
          );
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toStrictEqual({
          code: 'WORK_TREE_UNRESOLVABLE',
          value: '../missing',
          gitDir: '/repo/normal/.git',
        });
      });
    });

    describe('When core.worktree is ABSOLUTE and missing', () => {
      it('Then the capability is never consulted — git records the value verbatim', async () => {
        // Arrange — the asymmetry the refusal is scoped to: only the relative
        // form needs a physical walk from the gitDir.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/normal/.git');
        await fs.writeUtf8('/repo/normal/.git/config', '[core]\n\tworktree = /repo/nope\n');

        // Act
        const result = await resolveLayout(
          fileSystemLayoutProbe(fs),
          '/repo/normal',
          posixPolicy,
          {},
          {
            realWorkTreePath: async () => {
              throw new Error('must not be called for an absolute value');
            },
          },
        );

        // Assert
        expect(result?.workDir).toBe('/repo/nope');
      });
    });
  });
  describe('syntheticFallbackLayout — the found-nothing bootstrap', () => {
    describe('Given no overrides', () => {
      describe('When the fallback layout is synthesised', () => {
        it('Then it is the historical non-bare bootstrap shape', () => {
          // Arrange
          const sut = syntheticFallbackLayout;

          // Act
          const result = sut('/repo/.git', '/repo', '/repo', {}, posixPolicy);

          // Assert — no objectFormat: the bootstrap path reads nothing from
          // disk, so the format is genuinely unknown, not defaulted to sha1
          // (unlike `finishLayout`, which always resolves a definite answer
          // for an ALREADY-EXISTING repository). refStorage IS defaulted —
          // `bootstrapRepository` writes no `[extensions]` unless asked, so
          // 'files' is the correct, unambiguous answer even for a
          // not-yet-existing repository.
          expect(result).toStrictEqual({
            gitDir: '/repo/.git',
            workDir: '/repo',
            bare: false,
            refStorage: 'files',
          });
        });
      });
    });

    describe('Given a bare override', () => {
      describe('When the fallback layout is synthesised', () => {
        it('Then it is bare with no work tree', () => {
          // Arrange
          const sut = syntheticFallbackLayout;

          // Act
          const result = sut('/repo/.git', '/repo', '/repo', { bare: true }, posixPolicy);

          // Assert
          expect(result).toStrictEqual({ gitDir: '/repo/.git', bare: true, refStorage: 'files' });
        });
      });
    });

    describe('Given a relative workDir override and a cwd away from the anchor', () => {
      describe('When the fallback layout is synthesised', () => {
        it('Then the work tree resolves against the cwd, the same base as the discovery path', () => {
          // Arrange
          const sut = syntheticFallbackLayout;

          // Act
          const result = sut('/repo/.git', '/repo', '/repo/deep', { workDir: 'wt' }, posixPolicy);

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/.git',
            workDir: '/repo/deep/wt',
            bare: false,
            refStorage: 'files',
          });
        });
      });
    });

    describe('Given both a workDir override and a bare override', () => {
      describe('When the fallback layout is synthesised', () => {
        it('Then the work tree wins and the layout is not bare — argument precedence', () => {
          // Arrange
          const sut = syntheticFallbackLayout;

          // Act
          const result = sut(
            '/repo/.git',
            '/repo',
            '/repo',
            { bare: true, workDir: '/elsewhere' },
            posixPolicy,
          );

          // Assert
          expect(result).toStrictEqual({
            gitDir: '/repo/.git',
            workDir: '/elsewhere',
            bare: false,
            refStorage: 'files',
          });
        });
      });
    });
  });

  describe('The version arm — core.repositoryformatversion carried onto the layout', () => {
    describe('Given a repository whose local config sets repositoryformatversion = 99', () => {
      describe('When resolveLayout runs', () => {
        it('Then the finished layout carries formatRefusal', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/normal/.git');
          await fs.writeUtf8(
            '/repo/normal/.git/config',
            '[core]\n\trepositoryformatversion = 99\n',
          );

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
            formatRefusal: { kind: 'version', version: 99 },
            objectFormat: 'sha1',
            refStorage: 'files',
          });
        });
      });
    });

    describe('Given a repository whose local config sets repositoryformatversion = 0', () => {
      describe('When resolveLayout runs', () => {
        it('Then the finished layout carries no formatRefusal key at all', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/normal/.git');
          await fs.writeUtf8('/repo/normal/.git/config', '[core]\n\trepositoryformatversion = 0\n');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/normal',
            posixPolicy,
          );

          // Assert — proves the conditional spread, not just an undefined read.
          expect('formatRefusal' in (result as object)).toBe(false);
        });
      });
    });
  });
});
