import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.default.js';

describe('memory shim — openRepository', () => {
  describe('Given no options', () => {
    describe('When openRepository runs', () => {
      it('Then it returns a frozen Repository handle', async () => {
        // Arrange & Act
        const sut = await openRepository();

        // Assert
        expect(sut).toBeDefined();
        expect(Object.isFrozen(sut)).toBe(true);
      });
    });
  });

  describe('Given the default cwd', () => {
    describe('When inspecting ctx', () => {
      it("Then it equals '/repo' and the layout matches", async () => {
        // Arrange & Act
        const sut = await openRepository();

        // Assert
        expect(sut.ctx.cwd).toBe('/repo');
        expect(sut.ctx.layout.workDir).toBe('/repo');
        expect(sut.ctx.layout.gitDir).toBe('/repo/.git');
        expect(sut.ctx.layout.bare).toBe(false);
      });
    });
  });

  describe('Given gitDir: "" (empty string)', () => {
    describe('When openRepository runs', () => {
      it('Then it throws INVALID_OPTION{option: "gitDir"} rather than resolving a layout', async () => {
        // Arrange / Act
        let caught: unknown;
        try {
          await openRepository({ gitDir: '' });
        } catch (err) {
          caught = err;
        }

        // Assert — validateOptions runs BEFORE resolveLayout in this shim.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OPTION');
        if (data.code === 'INVALID_OPTION') {
          expect(data.option).toBe('gitDir');
        }
      });
    });
  });

  describe("Given algorithm 'sha256'", () => {
    describe('When inspecting ctx.hashConfig', () => {
      it('Then digestLength is 32 (sha256)', async () => {
        // Arrange & Act
        const sut = await openRepository({ algorithm: 'sha256' });

        // Assert
        expect(sut.ctx.hashConfig.digestLength).toBe(32);
      });
    });
  });

  describe('Given default algorithm', () => {
    describe('When inspecting ctx.hashConfig', () => {
      it('Then digestLength is 20 (sha1)', async () => {
        // Arrange & Act
        const sut = await openRepository();

        // Assert
        expect(sut.ctx.hashConfig.digestLength).toBe(20);
      });
    });
  });

  describe('Given a files seed', () => {
    describe('When init runs', () => {
      it('Then the .git directory is created and seeded files survive', async () => {
        // Arrange
        const seedBytes = new TextEncoder().encode('hello');
        const sut = await openRepository({
          files: { '/repo/seed.txt': seedBytes },
        });

        // Act
        await sut.init();

        // Assert
        expect(await sut.ctx.fs.exists('/repo/.git/HEAD')).toBe(true);
        expect(await sut.ctx.fs.readUtf8('/repo/seed.txt')).toBe('hello');
      });
    });
  });

  describe('Given an init via the bound method', () => {
    describe('When followed by status', () => {
      it('Then status reports clean and on refs/heads/main', async () => {
        // Arrange
        const sut = await openRepository();
        await sut.init();

        // Act
        const result = await sut.status();

        // Assert
        expect(result.clean).toBe(true);
        expect(result.branch).toBe('refs/heads/main');
      });
    });
  });

  describe('Given an explicit workDir', () => {
    describe('When openRepository runs', () => {
      it('Then layout.workDir reflects it, not the /repo default', async () => {
        // Arrange & Act
        const sut = await openRepository({ workDir: '/custom-wt' });

        // Assert
        expect(sut.ctx.layout.workDir).toBe('/custom-wt');
      });
    });
  });

  describe('Given bare: true', () => {
    describe('When openRepository runs', () => {
      it('Then layout.bare is true and workDir is absent', async () => {
        // Arrange & Act
        const sut = await openRepository({ bare: true });

        // Assert
        expect(sut.ctx.layout.bare).toBe(true);
        expect(sut.ctx.layout.workDir).toBeUndefined();
      });
    });
  });

  describe('Given an explicit gitDir', () => {
    describe('When openRepository runs', () => {
      it('Then layout.gitDir reflects it, not the /repo/.git default', async () => {
        // Arrange & Act
        const sut = await openRepository({ gitDir: '/custom/.git' });

        // Assert
        expect(sut.ctx.layout.gitDir).toBe('/custom/.git');
      });
    });
  });

  describe('Given a linked-worktree-shaped gitDir plus a separate valid commonDir', () => {
    const files = {
      '/repo/wt/.git/HEAD': new TextEncoder().encode('ref: refs/heads/main\n'),
      '/repo/wt/.git/config': new TextEncoder().encode('[core]\n\tbare = true\n'),
      '/repo/shared/objects/.keep': new Uint8Array(0),
      '/repo/shared/refs/.keep': new Uint8Array(0),
      '/repo/shared/config': new TextEncoder().encode('[core]\n\tbare = true\n'),
    };

    describe('When openRepository runs with commonDir set', () => {
      it('Then layout.commonDir is the given value and core.bare from the decoy is suppressed', async () => {
        // Arrange & Act
        const sut = await openRepository({
          cwd: '/repo',
          gitDir: '/repo/wt/.git',
          commonDir: '/repo/shared',
          files,
        });

        try {
          // Assert
          expect(sut.ctx.layout.commonDir).toBe('/repo/shared');
          expect(sut.ctx.layout.bare).toBe(false);
          expect(sut.ctx.layout.workDir).toBe('/repo');
        } finally {
          await sut.dispose();
        }
      });
    });

    describe('When openRepository runs with commonDir equal to gitDir (degenerate)', () => {
      it('Then layout carries no commonDir key, yet bareness is still suppressed', async () => {
        // Arrange & Act
        const sut = await openRepository({
          cwd: '/repo',
          gitDir: '/repo/wt/.git',
          commonDir: '/repo/wt/.git',
          files,
        });

        try {
          // Assert
          expect('commonDir' in sut.ctx.layout).toBe(false);
          expect(sut.ctx.layout.bare).toBe(false);
          expect(sut.ctx.layout.workDir).toBe('/repo');
        } finally {
          await sut.dispose();
        }
      });
    });
  });

  describe('Given a valid repository at cwd and an unusable commonDir override, on the discovery route', () => {
    describe('When openRepository runs', () => {
      it('Then it refuses with NOT_A_REPOSITORY instead of silently adopting the repository un-overridden', async () => {
        // Arrange — cwd IS the repo root: without the refusal, the walk
        // returns nothing and the found-nothing fallback synthesises the
        // very same {cwd}/.git, opening the repo with the override dropped.
        const files = {
          '/repo/self/.git/HEAD': new TextEncoder().encode('ref: refs/heads/main\n'),
          '/repo/self/.git/objects/.keep': new Uint8Array(0),
          '/repo/self/.git/refs/.keep': new Uint8Array(0),
        };

        // Act
        let caught: unknown;
        try {
          await openRepository({ cwd: '/repo/self', commonDir: '/repo/nowhere', files });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeDefined();
        const data = (caught as { data: { code: string } }).data;
        expect(data.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  describe('Given no repository anywhere and a VALID commonDir, on the found-nothing bootstrap', () => {
    describe('When openRepository runs', () => {
      it('Then the option is inert — the bootstrap layout carries no commonDir', async () => {
        // Arrange — a valid common dir but nothing to discover: the walk
        // finds no valid-HEAD candidate, so the bootstrap engages and must
        // ignore the option (init/clone create a normal repository).
        const files = {
          '/repo/shared/objects/.keep': new Uint8Array(0),
          '/repo/shared/refs/.keep': new Uint8Array(0),
        };

        // Act
        const sut = await openRepository({ cwd: '/repo/empty', commonDir: '/repo/shared', files });

        try {
          // Assert — the memory shim's bootstrap location is its fixed
          // /repo root, and the option must not survive onto it.
          expect('commonDir' in sut.ctx.layout).toBe(false);
          expect(sut.ctx.layout.gitDir).toBe('/repo/.git');
        } finally {
          await sut.dispose();
        }
      });
    });
  });

  describe('Given a sha256-declaring commonDir override and a contradicting algorithm argument', () => {
    describe('When openRepository runs', () => {
      it('Then it refuses with OBJECT_FORMAT_CONFLICT naming both formats', async () => {
        // Arrange — the override's config declares sha256; the caller pins
        // sha1: the declared-vs-requested contradiction must keep refusing
        // through the override exactly as through a repository's own config.
        const files = {
          '/repo/w/.git/HEAD': new TextEncoder().encode('ref: refs/heads/main\n'),
          '/repo/w/.git/objects/.keep': new Uint8Array(0),
          '/repo/w/.git/refs/.keep': new Uint8Array(0),
          '/repo/shared/objects/.keep': new Uint8Array(0),
          '/repo/shared/refs/.keep': new Uint8Array(0),
          '/repo/shared/config': new TextEncoder().encode(
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n',
          ),
        };

        // Act
        let caught: unknown;
        try {
          await openRepository({
            cwd: '/repo/w',
            commonDir: '/repo/shared',
            algorithm: 'sha1',
            files,
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeDefined();
        const data = (caught as { data: { code: string; declared: string; requested: string } })
          .data;
        expect(data.code).toBe('OBJECT_FORMAT_CONFLICT');
        expect(data.declared).toBe('sha256');
        expect(data.requested).toBe('sha1');
      });
    });
  });

  describe('Given a discoverable repository above cwd', () => {
    const gitDirFiles = {
      '/repo/a/.git/HEAD': new TextEncoder().encode('ref: refs/heads/main\n'),
      '/repo/a/.git/objects/.keep': new Uint8Array(0),
      '/repo/a/.git/refs/.keep': new Uint8Array(0),
    };

    describe('When openRepository runs with no ceilingDirs', () => {
      it('Then the walk climbs to it', async () => {
        // Arrange & Act
        const sut = await openRepository({ cwd: '/repo/a/b/c', files: gitDirFiles });

        // Assert
        expect(sut.ctx.layout.gitDir).toBe('/repo/a/.git');
      });
    });

    describe('When openRepository runs with ceilingDirs bounding the walk below it', () => {
      it('Then discovery stops at the ceiling and falls back to the bootstrap layout', async () => {
        // Arrange & Act — the ceiling sits BETWEEN cwd and the discoverable
        // repo, so the walk must never reach /repo/a/.git.
        const sut = await openRepository({
          cwd: '/repo/a/b/c',
          files: gitDirFiles,
          ceilingDirs: ['/repo/a/b'],
        });

        // Assert — the synthetic bootstrap layout wins instead.
        expect(sut.ctx.layout.gitDir).toBe('/repo/.git');
      });
    });
  });

  describe('Given a disposed repo', () => {
    describe('When any bound method is invoked', () => {
      it('Then it throws REPOSITORY_DISPOSED', async () => {
        // Arrange
        const sut = await openRepository();
        await sut.dispose();

        // Act & Assert
        try {
          await sut.init();
          expect.unreachable();
        } catch (err) {
          expect((err as { data: { code: string } }).data.code).toBe('REPOSITORY_DISPOSED');
        }
      });
    });
  });
});

describe('Given a directory holding an INVALID .git with a hostile config', () => {
  describe('When openRepository falls back to the bootstrap layout', () => {
    it("Then the rejected directory's config is never consulted — the layout stays the literal bootstrap", async () => {
      // Arrange — no HEAD/objects/refs, so discovery rejects the .git; the
      // planted config would flip bareness (or throw) if it were read.
      const files = { '/repo/.git/config': new TextEncoder().encode('[core]\n\tbare = banana\n') };

      // Act
      const repo = await openRepository({ files });

      try {
        const result = repo.ctx.layout;

        // Assert
        expect(result.bare).toBe(false);
        expect(result.workDir).toBe('/repo');
      } finally {
        await repo.dispose();
      }
    });
  });
});
