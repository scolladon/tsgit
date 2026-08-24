import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import { TsgitError } from '../../../src/domain/error.js';
import type { LayoutProbe } from '../../../src/ports/layout-probe.js';
import { fileSystemLayoutProbe } from '../../../src/repository/file-system-layout-probe.js';
import { findLayout, resolveCommonDir } from '../../../src/repository/find-layout.js';

// All tests use POSIX paths with the in-memory FS (which is POSIX-only by
// design) and inject `posixPolicy` so the walk stays POSIX-rooted on any
// host. The production `findLayout` uses `nativePolicy` (host-matching)
// when invoked without a policy argument — covered by the integration
// tests in the cross-platform suite.
//
// `findLayout` returns the walk's structural finding — `{ gitDir, commonDir?,
// route, origin? }` — not a full layout: config-driven work-tree resolution
// (`resolve-layout.ts`) is a separate stage this file does not exercise.

/** Marks `dir` as a valid git directory: `objects/`, `refs/`, and a `HEAD` file. */
const makeGitDir = async (fs: MemoryFileSystem, dir: string): Promise<void> => {
  await fs.mkdir(`${dir}/objects`);
  await fs.mkdir(`${dir}/refs`);
  await fs.writeUtf8(`${dir}/HEAD`, 'ref: refs/heads/main\n');
};

describe('findLayout', () => {
  describe('Given cwd contains a valid .git directory', () => {
    describe('When findLayout runs', () => {
      it('Then returns DISCOVERED with origin as cwd and no commonDir key', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
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
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
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
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
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
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
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
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
      });
    });
  });

  describe('Given a .git directory whose HEAD holds garbage content, with a valid repo one level up', () => {
    describe('When findLayout runs from inside it', () => {
      it('Then skips it and walks up to the valid repo', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await fs.mkdir('/repo/sub/.git/objects');
        await fs.mkdir('/repo/sub/.git/refs');
        await fs.writeUtf8('/repo/sub/.git/HEAD', 'garbage');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/sub', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
      });
    });
  });

  describe('Given a .git directory whose HEAD holds 64 lowercase hex characters', () => {
    describe('When findLayout runs', () => {
      it('Then it is a valid repo (SHA-256-width detached HEAD)', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.mkdir('/repo/.git/objects');
        await fs.mkdir('/repo/.git/refs');
        await fs.writeUtf8('/repo/.git/HEAD', 'a'.repeat(64));

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
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
          gitDir: '/repo/main/.git/worktrees/wt',
          commonDir: '/repo/main/.git',
          route: 'DISCOVERED',
          origin: '/repo/wt',
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
          gitDir: '/repo/separate-dir',
          route: 'DISCOVERED',
          origin: '/repo/wt',
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
          gitDir: '/repo/admin',
          commonDir: '/repo/common',
          route: 'DISCOVERED',
          origin: '/repo/wt',
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
        expect(result).toEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
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

  describe('Given a .git file of exactly the size cap (boundary)', () => {
    describe('When findLayout runs', () => {
      it('Then the size cap admits it and the refusal is layout-shaped, not size-shaped', async () => {
        // Arrange — a pointer padded to exactly 65536 bytes. The grammar
        // keeps every byte after `gitdir: ` as the path, so the padded path
        // does not exist — but the SIZE cap must admit exactly-65536.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        const head = 'gitdir: /repo/admin';
        await fs.writeUtf8('/repo/wt/.git', `${head}${'x'.repeat(65_536 - head.length)}`);

        // Act
        let caught: unknown;
        try {
          await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert — NOT_A_REPOSITORY (the padded target is missing), never
        // GITFILE_INVALID_FORMAT: proves the cap is `>` not `>=`.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'NOT_A_REPOSITORY',
          path: '/repo/wt',
        });
      });
    });
  });

  describe('Given an admin dir whose commondir file is exactly the size cap (boundary)', () => {
    describe('When findLayout runs', () => {
      it('Then the commondir is read and the refusal is layout-shaped, not size-shaped', async () => {
        // Arrange — a commondir value padded with trailing spaces to exactly
        // 65536 bytes: spaces are kept by the grammar, so the resolved dir is
        // missing and the layout is invalid — but the SIZE cap must admit it.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/admin/HEAD', 'ref: refs/heads/main\n');
        const value = '/repo/common';
        await fs.writeUtf8('/repo/admin/commondir', `${value}${' '.repeat(65_536 - value.length)}`);
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/admin\n');

        // Act
        let caught: unknown;
        try {
          await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert — NOT_A_REPOSITORY (space-suffixed common dir lacks
        // objects/refs), never GITFILE_INVALID_FORMAT: proves `>` not `>=`.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'NOT_A_REPOSITORY',
          path: '/repo/wt',
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

  describe('Given a .git file whose target has a NEWLINE-ONLY commondir file', () => {
    describe('When findLayout runs', () => {
      it('Then the stripped-empty pointer means the target is its own common dir and it resolves', async () => {
        // Arrange — git accepts this shape (the pointer strips to empty and
        // the gitdir serves as its own common dir); only a ZERO-BYTE
        // commondir is the hard failed-to-read refusal.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/admin');
        await fs.writeUtf8('/repo/admin/commondir', '\n');
        await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/admin\n');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/wt', posixPolicy);

        // Assert — commonDir equals the gitDir, so the key is omitted.
        expect(result).toStrictEqual({
          gitDir: '/repo/admin',
          route: 'DISCOVERED',
          origin: '/repo/wt',
        });
      });
    });
  });

  describe('Given a .git file whose target has a ZERO-BYTE commondir file', () => {
    describe('When findLayout runs', () => {
      it('Then it throws GITFILE_INVALID_FORMAT naming the commondir path', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/admin');
        await fs.writeUtf8('/repo/admin/commondir', '');
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
          gitDir: '/repo/main/.git/worktrees/wt',
          commonDir: '/repo/main/.git',
          route: 'DISCOVERED',
          origin: '/repo/wt',
        });
      });
    });
  });

  describe('Given cwd is itself a valid git directory (no enclosing .git)', () => {
    describe('When findLayout runs', () => {
      it('Then returns BARE_DIR with gitDir === cwd and no origin key', async () => {
        // Arrange — a `clone --bare`-shaped directory: HEAD/objects/refs at cwd,
        // no `.git` entry anywhere.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/bare.git');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/bare.git', posixPolicy);

        // Assert
        expect(result).toStrictEqual({ gitDir: '/repo/bare.git', route: 'BARE_DIR' });
      });
    });
  });

  describe('Given cwd is a sub-directory inside a cwd-is-gitdir repository', () => {
    describe('When findLayout runs', () => {
      it('Then walks up and returns the enclosing BARE_DIR match', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/bare.git');
        await fs.mkdir('/repo/bare.git/refs/heads');

        // Act
        const result = await findLayout(
          fileSystemLayoutProbe(fs),
          '/repo/bare.git/refs/heads',
          posixPolicy,
        );

        // Assert
        expect(result).toStrictEqual({ gitDir: '/repo/bare.git', route: 'BARE_DIR' });
      });
    });
  });

  describe('Given cwd holds both a valid .git directory AND is itself a valid git directory', () => {
    describe('When findLayout runs', () => {
      it('Then the .git subdirectory wins over the cwd-is-gitdir match', async () => {
        // Arrange — cwd itself qualifies (HEAD/objects/refs at the top level)
        // AND also has a nested, independently valid `.git/`.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/both/HEAD', 'ref: refs/heads/main\n');
        await fs.mkdir('/repo/both/objects');
        await fs.mkdir('/repo/both/refs');
        await makeGitDir(fs, '/repo/both/.git');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/both', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/both/.git',
          route: 'DISCOVERED',
          origin: '/repo/both',
        });
      });
    });
  });

  describe('Given a bare-shaped directory nested inside an enclosing repo work tree', () => {
    describe('When findLayout runs from inside the nested bare-shaped directory', () => {
      it('Then the nested cwd-is-gitdir match shadows the enclosing repository', async () => {
        // Arrange — `$T/n` is a normal repo; `$T/n/nested` independently
        // qualifies as a git directory in its own right (no `.git` entry of
        // its own). git's own walk resolves to the INNER match here.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/n/.git');
        await makeGitDir(fs, '/repo/n/nested');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/n/nested', posixPolicy);

        // Assert
        expect(result).toStrictEqual({ gitDir: '/repo/n/nested', route: 'BARE_DIR' });
      });
    });
  });

  describe('Given cwd has an invalid .git/ AND is itself a valid git directory', () => {
    describe('When findLayout runs', () => {
      it('Then the .git branch skips and the cwd-is-gitdir branch resolves at the same level', async () => {
        // Arrange — `.git` exists but is missing `refs/`, so it fails
        // validation; cwd itself independently qualifies.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/mixed/HEAD', 'ref: refs/heads/main\n');
        await fs.mkdir('/repo/mixed/objects');
        await fs.mkdir('/repo/mixed/refs');
        await fs.mkdir('/repo/mixed/.git/objects');
        await fs.writeUtf8('/repo/mixed/.git/HEAD', 'ref: refs/heads/main\n');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/mixed', posixPolicy);

        // Assert — the SAME level resolves via cwd-is-gitdir, not a climb.
        expect(result).toStrictEqual({ gitDir: '/repo/mixed', route: 'BARE_DIR' });
      });
    });
  });

  describe('Given a level with neither a .git entry nor a HEAD file', () => {
    describe('When findLayout climbs past it', () => {
      it('Then costs exactly one extra stat on a capability-less probe over the pre-existing .git-only probe', async () => {
        // Arrange — a counting probe stub over a two-level climb: the empty
        // leaf level, then a valid repo one level up. Every `stat` call is
        // tallied by path so the cost contract is asserted precisely rather
        // than just "the walk still finds the repo".
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await fs.mkdir('/repo/empty');
        const baseProbe = fileSystemLayoutProbe(fs);
        const statCounts = new Map<string, number>();
        const countingProbe: LayoutProbe = {
          stat: async (path) => {
            statCounts.set(path, (statCounts.get(path) ?? 0) + 1);
            return baseProbe.stat(path);
          },
          readUtf8: (path) => baseProbe.readUtf8(path),
        };

        // Act
        const result = await findLayout(countingProbe, '/repo/empty', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
        // The empty leaf level pays exactly two stats: `.git` (absent) and
        // `HEAD` (absent) — never a third probe into commondir/objects/refs.
        expect(statCounts.get('/repo/empty/.git')).toBe(1);
        expect(statCounts.get('/repo/empty/HEAD')).toBe(1);
        expect(statCounts.has('/repo/empty/objects')).toBe(false);
        expect(statCounts.has('/repo/empty/refs')).toBe(false);
      });
    });
  });

  describe('Given a ceilingDirs entry that is a strict ancestor of cwd, at the repo root', () => {
    describe('When findLayout runs', () => {
      it('Then it returns undefined — the walk never examines the repo root', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/normal/.git');
        await fs.mkdir('/repo/normal/deep/deeper');

        // Act
        const result = await findLayout(
          fileSystemLayoutProbe(fs),
          '/repo/normal/deep/deeper',
          posixPolicy,
          ['/repo/normal'],
        );

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a ceilingDirs entry above the repo root', () => {
    describe('When findLayout runs', () => {
      it('Then the repo is still found — an irrelevant ceiling is a no-op', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/normal/.git');
        await fs.mkdir('/repo/normal/deep/deeper');

        // Act
        const result = await findLayout(
          fileSystemLayoutProbe(fs),
          '/repo/normal/deep/deeper',
          posixPolicy,
          ['/repo'],
        );

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/normal/.git',
          route: 'DISCOVERED',
          origin: '/repo/normal',
        });
      });
    });
  });

  describe('Given a ceilingDirs entry equal to cwd itself', () => {
    describe('When findLayout runs', () => {
      it('Then the repo is still found — a strict-ancestor no-op wired into the loop head', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/normal/.git');
        await fs.mkdir('/repo/normal/deep/deeper');

        // Act
        const result = await findLayout(
          fileSystemLayoutProbe(fs),
          '/repo/normal/deep/deeper',
          posixPolicy,
          ['/repo/normal/deep/deeper'],
        );

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/normal/.git',
          route: 'DISCOVERED',
          origin: '/repo/normal',
        });
      });
    });
  });

  describe('Given no ceilingDirs argument at all', () => {
    describe('When findLayout runs', () => {
      it('Then it walks all the way to the root, exactly as before', async () => {
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
  describe('Given a candidate directory with a valid HEAD and a ZERO-BYTE commondir file', () => {
    describe('When findLayout runs', () => {
      it('Then the walk refuses hard — git dies on an unreadable commondir and never climbs', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/bare');
        await fs.writeUtf8('/repo/bare/commondir', '');

        // Act
        let caught: unknown;
        try {
          await findLayout(fileSystemLayoutProbe(fs), '/repo/bare', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toMatchObject({
          code: 'GITFILE_INVALID_FORMAT',
          path: '/repo/bare/commondir',
        });
      });
    });
  });

  describe('Given a candidate directory with a valid HEAD and a NEWLINE-ONLY commondir file', () => {
    describe('When findLayout runs', () => {
      it('Then the stripped-empty pointer means the directory is its own common dir and it is accepted', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/bare');
        await fs.writeUtf8('/repo/bare/commondir', '\n');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/bare', posixPolicy);

        // Assert — commonDir equals the gitDir, so the key is omitted.
        expect(result).toStrictEqual({ gitDir: '/repo/bare', route: 'BARE_DIR' });
      });
    });
  });

  describe('Given a candidate whose commondir names a whitespace path that does not validate', () => {
    describe('When findLayout runs from inside a real repo', () => {
      it('Then the candidate simply fails its shared-dir check and the walk climbs to the enclosing repo', async () => {
        // Arrange — git treats `"   \n"` as a path named `"   "`; the missing
        // objects/refs there make the candidate a miss, never a refusal.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await makeGitDir(fs, '/repo/bait');
        await fs.writeUtf8('/repo/bait/commondir', '   \n');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/bait', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
      });
    });
  });

  describe('Given a planted directory with a garbage HEAD and an empty commondir inside a real repo', () => {
    describe('When findLayout runs from inside the planted directory', () => {
      it('Then the walk climbs past to the enclosing repo instead of hard-stopping on the commondir', async () => {
        // Arrange — HEAD is validated FIRST, so the unusable commondir is never
        // even parsed for a directory whose HEAD already disqualifies it.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await fs.mkdir('/repo/bait/objects');
        await fs.mkdir('/repo/bait/refs');
        await fs.writeUtf8('/repo/bait/HEAD', 'garbage');
        await fs.writeUtf8('/repo/bait/commondir', '');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/bait', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
      });
    });
  });

  describe('Given an OVERSIZED HEAD file whose leading content is valid', () => {
    describe('When findLayout runs', () => {
      it('Then the level is admitted — git validates only the leading bytes and never the size', async () => {
        // Arrange — a valid detached oid followed by ~70 KiB of filler: git
        // resolves this directory (it reads only the first 255 bytes), so a
        // size gate here would climb PAST a repository git sees.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.mkdir('/repo/bare/objects');
        await fs.mkdir('/repo/bare/refs');
        await fs.writeUtf8('/repo/bare/HEAD', `${'a'.repeat(40)}\n${'x'.repeat(70_000)}`);

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/bare', posixPolicy);

        // Assert
        expect(result).toStrictEqual({ gitDir: '/repo/bare', route: 'BARE_DIR' });
      });
    });
  });

  describe('Given an OVERSIZED HEAD file whose leading content is garbage', () => {
    describe('When findLayout runs from inside a valid repo', () => {
      it('Then the level fails the grammar and the walk climbs to the enclosing repo', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await fs.mkdir('/repo/bait/objects');
        await fs.mkdir('/repo/bait/refs');
        await fs.writeUtf8('/repo/bait/HEAD', `garbage${'x'.repeat(70_000)}`);

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/bait', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
      });
    });
  });

  describe('Given a valid gitdir placed under a name other than .git', () => {
    describe('When findLayout runs from its parent', () => {
      it('Then nothing is found — only the literal name .git is probed as a child entry', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/parent/other-name');
        await fs.mkdir('/repo/parent');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/parent', posixPolicy);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a commondir entry that is a directory rather than a regular file', () => {
    describe('When resolveCommonDir runs', () => {
      it('Then it is treated as absent and the gitDir is its own common dir', async () => {
        // Arrange — a non-regular commondir must never be read: on the node
        // probe a planted FIFO would block the read forever.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await fs.mkdir('/repo/.git/commondir');

        // Act
        const result = await resolveCommonDir(fileSystemLayoutProbe(fs), '/repo/.git', posixPolicy);

        // Assert
        expect(result).toBe('/repo/.git');
      });
    });
  });

  describe('Given a commondir that stats non-regular but whose readUtf8 would still return a pointer', () => {
    describe('When resolveCommonDir runs', () => {
      it('Then the non-regular check short-circuits before that read is ever attempted', async () => {
        // Arrange — a hand-crafted probe that DECOUPLES stat from readUtf8,
        // simulating the real hazard the guard defends against: a FIFO
        // stats as non-regular but its content, if read, would still parse
        // as a valid pointer. `MemoryFileSystem`'s own readUtf8 already
        // fails closed for a directory (both branches return the same
        // "absent" result there), so only a probe that can return SOMETHING
        // from `readUtf8` proves the `stat.isFile !== true` check — not the
        // later `raw === undefined` one — is what stops the read.
        const probe: LayoutProbe = {
          stat: async () => ({ isDirectory: false, isFile: false, size: 3 }),
          readUtf8: async () => '/elsewhere\n',
        };

        // Act
        const result = await resolveCommonDir(probe, '/repo/.git', posixPolicy);

        // Assert — the non-regular entry is treated as absent; the pointer
        // its readUtf8 stub would have supplied is never consulted.
        expect(result).toBe('/repo/.git');
      });
    });
  });
  describe('Given a probe exposing readLink and a dangling HEAD symlink whose text begins refs/', () => {
    describe('When findLayout runs', () => {
      it('Then the directory qualifies — git judges a symlinked HEAD by its link text, dangling included', async () => {
        // Arrange — the target of the link does not exist, so the following
        // stat sees nothing; only the link text makes this a git directory.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.mkdir('/repo/bare/objects');
        await fs.mkdir('/repo/bare/refs');
        const base = fileSystemLayoutProbe(fs);
        const probe = {
          ...base,
          readLink: async (path: string) =>
            path === '/repo/bare/HEAD' ? 'refs/heads/main' : undefined,
        };

        // Act
        const result = await findLayout(probe, '/repo/bare', posixPolicy);

        // Assert
        expect(result).toStrictEqual({ gitDir: '/repo/bare', route: 'BARE_DIR' });
      });
    });
  });

  describe('Given a probe exposing readLink and a HEAD symlink pointing outside refs/', () => {
    describe('When findLayout runs', () => {
      it('Then the directory does not qualify even though the link target might exist', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.mkdir('/repo/bare/objects');
        await fs.mkdir('/repo/bare/refs');
        await fs.writeUtf8('/repo/bare/HEAD', 'ref: refs/heads/main\n');
        const base = fileSystemLayoutProbe(fs);
        const probe = {
          ...base,
          readLink: async (path: string) =>
            path === '/repo/bare/HEAD' ? '/nowhere/else' : undefined,
        };

        // Act
        const result = await findLayout(probe, '/repo/bare', posixPolicy);

        // Assert — link text wins over the (valid) followed content.
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a commondir whose target path has a missing INTERMEDIATE component', () => {
    describe('When findLayout runs', () => {
      it('Then it refuses hard — git dies with Invalid path there and never climbs', async () => {
        // Arrange — only the FINAL component may be absent (that shape is a
        // candidate miss); a missing intermediate is a refusal.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await makeGitDir(fs, '/repo/bait');
        await fs.writeUtf8('/repo/bait/commondir', 'no/such/dir\n');

        // Act
        let caught: unknown;
        try {
          await findLayout(fileSystemLayoutProbe(fs), '/repo/bait', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toMatchObject({
          code: 'GITFILE_INVALID_FORMAT',
          path: '/repo/bait/commondir',
        });
      });
    });
  });

  describe('Given a commondir with a trailing slash whose target is missing', () => {
    describe('When findLayout runs from inside a real repo', () => {
      it('Then slash noise never fabricates an intermediate — the candidate is a plain miss and the walk climbs', async () => {
        // Arrange — 'shared/' splits into one real segment; empty segments
        // from slash noise are dropped, so the missing target is a FINAL
        // component (a miss), never a missing intermediate (a refusal).
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await makeGitDir(fs, '/repo/bait');
        await fs.writeUtf8('/repo/bait/commondir', 'shared/\n');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/bait', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
      });
    });
  });

  describe('Given a commondir whose dotted path traverses a missing component', () => {
    describe('When findLayout runs', () => {
      it('Then it refuses hard — lexical collapse must not skip the component git trips on', async () => {
        // Arrange — `missing/../../shared` collapses lexically to `../shared`,
        // but git's component-wise walk dies at `missing` first.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await makeGitDir(fs, '/repo/bait');
        await fs.mkdir('/repo/shared');
        await fs.writeUtf8('/repo/bait/commondir', 'missing/../../shared\n');

        // Act
        let caught: unknown;
        try {
          await findLayout(fileSystemLayoutProbe(fs), '/repo/bait', posixPolicy);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toMatchObject({
          code: 'GITFILE_INVALID_FORMAT',
          path: '/repo/bait/commondir',
        });
      });
    });
  });

  describe('Given a commondir whose target is missing only its FINAL component', () => {
    describe('When findLayout runs from inside a real repo', () => {
      it('Then the candidate is a plain miss and the walk climbs to the enclosing repo', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/.git');
        await makeGitDir(fs, '/repo/bait');
        await fs.writeUtf8('/repo/bait/commondir', '../shared\n');

        // Act
        const result = await findLayout(fileSystemLayoutProbe(fs), '/repo/bait', posixPolicy);

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/repo/.git',
          route: 'DISCOVERED',
          origin: '/repo',
        });
      });
    });
  });

  describe('The commonDir override', () => {
    describe('Given /repo/.git valid with a commondir file naming /repo/other, and a valid /repo/alt', () => {
      describe('When findLayout runs with a commonDir override', () => {
        it('Then the outcome uses the override in place of the file-derived value, marked supplied', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/.git');
          await makeGitDir(fs, '/repo/other');
          await fs.writeUtf8('/repo/.git/commondir', '/repo/other\n');
          await makeGitDir(fs, '/repo/alt');

          // Act
          const result = await findLayout(
            fileSystemLayoutProbe(fs),
            '/repo',
            posixPolicy,
            undefined,
            '/repo/alt',
          );

          // Assert
          expect(result).toStrictEqual({
            route: 'DISCOVERED',
            origin: '/repo',
            gitDir: '/repo/.git',
            commonDir: '/repo/alt',
            commonDirSupplied: true,
          });
        });
      });
    });

    describe('Given /repo/.git valid whose commondir file is ZERO-BYTE, and a valid /repo/alt', () => {
      describe('When findLayout runs with a commonDir override', () => {
        it('Then it does not throw — the commondir file is never read when an override is supplied', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/.git');
          await fs.writeUtf8('/repo/.git/commondir', '');
          await makeGitDir(fs, '/repo/alt');

          // Act
          const result = await findLayout(
            fileSystemLayoutProbe(fs),
            '/repo',
            posixPolicy,
            undefined,
            '/repo/alt',
          );

          // Assert
          expect(result).toStrictEqual({
            route: 'DISCOVERED',
            origin: '/repo',
            gitDir: '/repo/.git',
            commonDir: '/repo/alt',
            commonDirSupplied: true,
          });
        });
      });
    });

    describe('Given a .git file pointing at an admin dir, and a valid /repo/alt', () => {
      describe('When findLayout runs with a commonDir override', () => {
        it('Then commonDir is the override, not the file-derived value', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8('/repo/.git/worktrees/wt/HEAD', 'ref: refs/heads/main\n');
          await fs.writeUtf8('/repo/.git/worktrees/wt/commondir', '/repo/.git\n');
          await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/.git/worktrees/wt\n');
          await makeGitDir(fs, '/repo/alt');

          // Act
          const result = await findLayout(
            fileSystemLayoutProbe(fs),
            '/repo/wt',
            posixPolicy,
            undefined,
            '/repo/alt',
          );

          // Assert
          expect(result).toStrictEqual({
            route: 'DISCOVERED',
            origin: '/repo/wt',
            gitDir: '/repo/.git/worktrees/wt',
            commonDir: '/repo/alt',
            commonDirSupplied: true,
          });
        });
      });
    });

    describe('Given /repo/bare.git valid (no enclosing .git), and a valid /repo/alt', () => {
      describe('When findLayout runs with a commonDir override', () => {
        it('Then the outcome is BARE_DIR with the override commonDir, marked supplied', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await makeGitDir(fs, '/repo/alt');

          // Act
          const result = await findLayout(
            fileSystemLayoutProbe(fs),
            '/repo/bare.git',
            posixPolicy,
            undefined,
            '/repo/alt',
          );

          // Assert
          expect(result).toStrictEqual({
            route: 'BARE_DIR',
            gitDir: '/repo/bare.git',
            commonDir: '/repo/alt',
            commonDirSupplied: true,
          });
        });
      });
    });

    describe('Given /repo/inner/.git valid, an enclosing /repo/.git also valid, and /repo/alt containing only refs/', () => {
      describe('When findLayout runs with the override', () => {
        it('Then the result is undefined — the override invalidates every candidate, and the walk never climbs to a usable repo', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/.git');
          await makeGitDir(fs, '/repo/inner/.git');
          await fs.mkdir('/repo/alt/refs');

          // Act
          const result = await findLayout(
            fileSystemLayoutProbe(fs),
            '/repo/inner',
            posixPolicy,
            undefined,
            '/repo/alt',
          );

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given /repo/inner/.git valid, an enclosing /repo/.git also valid, and /repo/alt containing only objects/', () => {
      describe('When findLayout runs with the override', () => {
        it('Then the result is undefined — the missing refs/ guard alone invalidates every candidate', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/.git');
          await makeGitDir(fs, '/repo/inner/.git');
          await fs.mkdir('/repo/alt/objects');

          // Act
          const result = await findLayout(
            fileSystemLayoutProbe(fs),
            '/repo/inner',
            posixPolicy,
            undefined,
            '/repo/alt',
          );

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given /repo/.git valid, and an override equal to the gitDir itself (degenerate)', () => {
      describe('When findLayout runs with the override', () => {
        it('Then the commonDir key is omitted but commonDirSupplied is true', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/.git');

          // Act
          const result = await findLayout(
            fileSystemLayoutProbe(fs),
            '/repo',
            posixPolicy,
            undefined,
            '/repo/.git',
          );

          // Assert
          expect(result !== undefined && 'commonDir' in result).toBe(false);
          expect(result?.commonDirSupplied).toBe(true);
        });
      });
    });

    describe('Given a plain /repo/.git and no override at all', () => {
      describe('When findLayout runs', () => {
        it('Then the outcome carries no commonDirSupplied key — byte-identical to today', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/.git');

          // Act
          const result = await findLayout(fileSystemLayoutProbe(fs), '/repo', posixPolicy);

          // Assert
          expect(result).toStrictEqual({
            route: 'DISCOVERED',
            gitDir: '/repo/.git',
            origin: '/repo',
          });
          expect(result !== undefined && 'commonDirSupplied' in result).toBe(false);
        });
      });
    });
  });
});
