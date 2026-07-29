import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import { TsgitError } from '../../../src/domain/error.js';
import type { LayoutProbe } from '../../../src/ports/layout-probe.js';
import { fileSystemLayoutProbe } from '../../../src/repository/file-system-layout-probe.js';
import { findLayout } from '../../../src/repository/find-layout.js';

// All tests use POSIX paths with the in-memory FS (which is POSIX-only by
// design) and inject `posixPolicy` so the walk stays POSIX-rooted on any
// host. The production `findLayout` uses `nativePolicy` (host-matching)
// when invoked without a policy argument — covered by the integration
// tests in the cross-platform suite.

/** Marks `dir` as a valid git directory: `objects/`, `refs/`, and a `HEAD` file. */
const makeGitDir = async (fs: MemoryFileSystem, dir: string): Promise<void> => {
  await fs.mkdir(`${dir}/objects`);
  await fs.mkdir(`${dir}/refs`);
  await fs.writeUtf8(`${dir}/HEAD`, 'ref: refs/heads/main\n');
};

describe('findLayout', () => {
  describe('Given cwd contains a valid .git directory', () => {
    describe('When findLayout runs', () => {
      it('Then returns layout with cwd as workDir and no commonDir key', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo', posixPolicy);

        // Assert
        expect(result).toStrictEqual({ workDir: '/repo', gitDir: '/repo/.git', bare: false });
      });
    });
  });

  describe('Given cwd is a sub-directory of a repo', () => {
    describe('When findLayout runs', () => {
      it('Then walks up to find the valid .git directory', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await fs.mkdir('/repo/sub/dir');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/sub/dir', posixPolicy);

        // Assert
        expect(result).toStrictEqual({ workDir: '/repo', gitDir: '/repo/.git', bare: false });
      });
    });
  });

  describe('Given no .git anywhere up the tree', () => {
    describe('When findLayout runs', () => {
      it('Then returns undefined', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.mkdir('/repo/lonely');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/lonely', posixPolicy);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a .git directory missing objects/, with a valid repo one level up', () => {
    describe('When findLayout runs from inside it', () => {
      it('Then skips it and walks up to the valid repo', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await fs.mkdir('/repo/sub/.git/refs');
        await fs.writeUtf8('/repo/sub/.git/HEAD', 'ref: refs/heads/main\n');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/sub', posixPolicy);

        // Assert
        expect(result).toStrictEqual({ workDir: '/repo', gitDir: '/repo/.git', bare: false });
      });
    });
  });

  describe('Given a .git directory missing refs/, with a valid repo one level up', () => {
    describe('When findLayout runs from inside it', () => {
      it('Then skips it and walks up to the valid repo', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await fs.mkdir('/repo/sub/.git/objects');
        await fs.writeUtf8('/repo/sub/.git/HEAD', 'ref: refs/heads/main\n');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/sub', posixPolicy);

        // Assert
        expect(result).toStrictEqual({ workDir: '/repo', gitDir: '/repo/.git', bare: false });
      });
    });
  });

  describe('Given a .git directory missing HEAD, with a valid repo one level up', () => {
    describe('When findLayout runs from inside it', () => {
      it('Then skips it and walks up to the valid repo', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await fs.mkdir('/repo/sub/.git/objects');
        await fs.mkdir('/repo/sub/.git/refs');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/sub', posixPolicy);

        // Assert
        expect(result).toStrictEqual({ workDir: '/repo', gitDir: '/repo/.git', bare: false });
      });
    });
  });

  describe('Given a .git file with an absolute pointer to an admin dir carrying a commondir', () => {
    describe('When findLayout runs', () => {
      it('Then returns the admin dir as gitDir and the resolved commonDir', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/main/.git');
        await fs.writeUtf8('/repo/main/.git/worktrees/wt/HEAD', 'ref: refs/heads/main\n');
        await fs.writeUtf8('/repo/main/.git/worktrees/wt/commondir', '../..\n');
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/main/.git/worktrees/wt\n');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          workDir: '/repo/wt',
          gitDir: '/repo/main/.git/worktrees/wt',
          bare: false,
          commonDir: '/repo/main/.git',
        });
      });
    });
  });

  describe('Given a .git file with a pointer relative to the directory holding it', () => {
    describe('When findLayout runs', () => {
      it('Then resolves gitDir with no ".." segment surviving', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/main/.git');
        await fs.writeUtf8('/repo/main/.git/worktrees/wt/HEAD', 'ref: refs/heads/main\n');
        await fs.writeUtf8('/repo/main/.git/worktrees/wt/commondir', '../..\n');
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: ../main/.git/worktrees/wt\n');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);

        // Assert
        expect(result?.gitDir).toBe('/repo/main/.git/worktrees/wt');
        expect(result?.gitDir.includes('..')).toBe(false);
      });
    });
  });

  describe('Given a .git file whose target has no commondir file', () => {
    describe('When findLayout runs', () => {
      it('Then the commonDir key is absent (falls back to gitDir)', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/separate-dir');
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/separate-dir\n');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          workDir: '/repo/wt',
          gitDir: '/repo/separate-dir',
          bare: false,
        });
      });
    });
  });

  describe('Given a .git file whose target has an absolute commondir', () => {
    describe('When findLayout runs', () => {
      it('Then the absolute commondir path is used verbatim', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/common');
        await fs.writeUtf8('/repo/admin/HEAD', 'ref: refs/heads/main\n');
        await fs.writeUtf8('/repo/admin/commondir', '/repo/common\n');
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/admin\n');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          workDir: '/repo/wt',
          gitDir: '/repo/admin',
          bare: false,
          commonDir: '/repo/common',
        });
      });
    });
  });

  describe('Given a .git file with malformed content, with a valid repo one level up', () => {
    describe('When findLayout runs', () => {
      it('Then it throws GITFILE_INVALID_FORMAT and does not return the outer repo', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await fs.writeUtf8('/repo/wt/.git', 'hello world\n');

        // Act
        let caught: unknown;
        try {
          await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'GITFILE_INVALID_FORMAT',
          path: '/repo/wt/.git',
        });
      });
    });
  });

  describe('Given a .git file with an empty gitdir path (gitdir: \\n)', () => {
    describe('When findLayout runs', () => {
      it('Then it throws GITFILE_NO_PATH', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: \n');

        // Act
        let caught: unknown;
        try {
          await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'GITFILE_NO_PATH',
          path: '/repo/wt/.git',
        });
      });
    });
  });

  describe('Given a .git file whose target is an empty dir (no HEAD, objects/ or refs/)', () => {
    describe('When findLayout runs', () => {
      it('Then it throws NOT_A_REPOSITORY naming the worktree dir', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.mkdir('/repo/empty-target');
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/empty-target\n');

        // Act
        let caught: unknown;
        try {
          await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'NOT_A_REPOSITORY',
          path: '/repo/wt',
        });
      });
    });
  });

  describe('Given a .git file whose target has HEAD but lacks objects/ and refs/', () => {
    describe('When findLayout runs', () => {
      it('Then it throws NOT_A_REPOSITORY through the objects/refs guards', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/head-only/HEAD', 'ref: refs/heads/main\n');
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/head-only\n');

        // Act
        let caught: unknown;
        try {
          await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'NOT_A_REPOSITORY',
          path: '/repo/wt',
        });
      });
    });
  });

  describe('Given a .git directory whose HEAD entry is itself a directory', () => {
    describe('When findLayout runs from inside it with a valid repo one level up', () => {
      it('Then the invalid directory is skipped and the outer repo is returned', async () => {
        // Arrange — HEAD must be a regular file; a directory named HEAD is
        // not a head, so the candidate fails validation and the walk climbs.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await fs.mkdir('/repo/inner/.git/HEAD');
        await fs.mkdir('/repo/inner/.git/objects');
        await fs.mkdir('/repo/inner/.git/refs');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/inner', posixPolicy);

        // Assert
        expect(result).toEqual({ workDir: '/repo', gitDir: '/repo/.git', bare: false });
      });
    });
  });

  describe('Given a .git file larger than the gitfile size cap', () => {
    describe('When findLayout runs', () => {
      it('Then it throws GITFILE_INVALID_FORMAT without parsing the content', async () => {
        // Arrange — a hostile multi-megabyte `.git` file must be refused on
        // its stat size, before its bytes reach the parser.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/wt/.git', `gitdir: /repo/admin${'x'.repeat(70_000)}\n`);

        // Act
        let caught: unknown;
        try {
          await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'GITFILE_INVALID_FORMAT',
          path: '/repo/wt/.git',
        });
      });
    });
  });

  describe('Given an admin dir whose commondir file is larger than the size cap', () => {
    describe('When findLayout runs', () => {
      it('Then it throws GITFILE_INVALID_FORMAT naming the commondir path', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/admin/HEAD', 'ref: refs/heads/main\n');
        await fs.writeUtf8('/repo/admin/commondir', `${'x'.repeat(70_000)}\n`);
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/admin\n');

        // Act
        let caught: unknown;
        try {
          await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'GITFILE_INVALID_FORMAT',
          path: '/repo/admin/commondir',
        });
      });
    });
  });

  describe('Given a .git file whose target has an empty commondir file', () => {
    describe('When findLayout runs', () => {
      it('Then it throws GITFILE_INVALID_FORMAT naming the commondir path', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/admin');
        await fs.writeUtf8('/repo/admin/commondir', '\n');
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/admin\n');

        // Act
        let caught: unknown;
        try {
          await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'GITFILE_INVALID_FORMAT',
          path: '/repo/admin/commondir',
        });
      });
    });
  });

  describe('Given a stub probe whose stat reports a file but whose readUtf8 resolves to undefined', () => {
    describe('When findLayout runs', () => {
      it('Then it throws GITFILE_INVALID_FORMAT (unreadable gitfile is a hard stop)', async () => {
        // Arrange
        const gitfilePath = '/repo/wt/.git';
        const probe: LayoutProbe = {
          stat: async (path) =>
            path === gitfilePath ? { isDirectory: false, isFile: true, size: 32 } : undefined,
          readUtf8: async () => undefined,
        };

        // Act
        let caught: unknown;
        try {
          await findLayout(probe, '/repo/wt', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'GITFILE_INVALID_FORMAT',
          path: gitfilePath,
        });
      });
    });
  });

  describe('Given a sub-directory of a linked worktree whose .git is a gitfile', () => {
    describe('When findLayout runs from the sub-directory', () => {
      it('Then returns the same layout as running from the worktree root', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/main/.git');
        await fs.writeUtf8('/repo/main/.git/worktrees/wt/HEAD', 'ref: refs/heads/main\n');
        await fs.writeUtf8('/repo/main/.git/worktrees/wt/commondir', '../..\n');
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/main/.git/worktrees/wt\n');
        await fs.mkdir('/repo/wt/sub/dir');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/wt/sub/dir', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          workDir: '/repo/wt',
          gitDir: '/repo/main/.git/worktrees/wt',
          bare: false,
          commonDir: '/repo/main/.git',
        });
      });
    });
  });
});
