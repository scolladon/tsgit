import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import { TsgitError } from '../../../src/domain/error.js';
import type { LayoutProbe } from '../../../src/ports/layout-probe.js';
import { fileSystemLayoutProbe } from '../../../src/repository/file-system-layout-probe.js';
import { readRepositoryFormat } from '../../../src/repository/read-repository-format.js';

// `readRepositoryFormat` is Stage 2 of layout resolution: it reads exactly
// `<commonDir>/config` (plus `<gitDir>/config.worktree` when
// `extensions.worktreeConfig` is true there) and extracts only `core.bare`,
// `core.worktree` and `extensions.worktreeConfig` — no other key, no
// `include.path` expansion, no global/system scope.

describe('readRepositoryFormat', () => {
  describe('Given no config file at all', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it returns the empty result — absence is not a refusal', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result).toStrictEqual({
          bare: undefined,
          worktree: undefined,
          worktreeConfig: false,
        });
      });
    });
  });

  describe('Given core.bare = true in the local config', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then bare is true', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core]\n\tbare = true\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.bare).toBe(true);
      });
    });
  });

  describe('Given core.worktree set to a relative value in the local config', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then worktree carries the raw (unresolved) value', async () => {
        // Arrange — resolution against gitDir is Stage 3's job, not Stage 2's.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core]\n\tworktree = ../wt\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.worktree).toBe('../wt');
      });
    });
  });

  describe('Given extensions.worktreeConfig = true and a config.worktree overriding core.bare', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then the config.worktree value wins', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\tbare = false\n[extensions]\n\tworktreeConfig = true\n',
        );
        await fs.writeUtf8('/repo/.git/config.worktree', '[core]\n\tbare = true\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result).toStrictEqual({ bare: true, worktree: undefined, worktreeConfig: true });
      });
    });
  });

  describe('Given extensions.worktreeConfig = true and a config.worktree overriding core.worktree', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then the config.worktree value wins over the local one', async () => {
        // Arrange — the local file carries a DIFFERENT value, so this proves
        // the override, not merely the read.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\tworktree = /local-wt\n[extensions]\n\tworktreeConfig = true\n',
        );
        await fs.writeUtf8('/repo/.git/config.worktree', '[core]\n\tworktree = /scoped-wt\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.worktree).toBe('/scoped-wt');
      });
    });
  });

  describe('Given extensions.worktreeConfig is NOT set and a config.worktree file exists anyway', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then config.worktree is ignored — the extension gate was not tripped', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core]\n\tbare = false\n');
        await fs.writeUtf8('/repo/.git/config.worktree', '[core]\n\tbare = true\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result).toStrictEqual({ bare: false, worktree: undefined, worktreeConfig: false });
      });
    });
  });

  describe('Given the local config sets include.path to a file with core.bare = true', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then the included file is never read — bare stays undefined', async () => {
        // Arrange — include machinery is deliberately disabled at this stage.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[include]\n\tpath = /repo/.git/included\n');
        await fs.writeUtf8('/repo/.git/included', '[core]\n\tbare = true\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.bare).toBeUndefined();
      });
    });
  });

  describe('Given core.bare = banana in the local config', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it throws CONFIG_BAD_BOOLEAN_VALUE naming core.bare and the source', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core]\n\tbare = banana\n');

        // Act
        let caught: unknown;
        try {
          await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'core.bare',
          source: '/repo/.git/config',
          value: 'banana',
        });
      });
    });
  });

  describe('Given a valueless core.worktree in the local config', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it throws CONFIG_MISSING_VALUE naming core.worktree, the source and the line', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core]\n\tbare = false\n\tworktree\n');

        // Act
        let caught: unknown;
        try {
          await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'CONFIG_MISSING_VALUE',
          key: 'core.worktree',
          source: '/repo/.git/config',
          line: 3,
        });
      });
    });
  });

  describe('Given a local config file far larger than the pointer-file cap', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it reads the file anyway — git reads a repository config unbounded', async () => {
        // Arrange — ~70 KiB of comment padding after a real core.bare entry:
        // a repo with a thousand [branch] sections is legitimate and git
        // opens it without complaint. Only NON-REGULAR entries are skipped.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        const head = '[core]\n\tbare = true\n';
        const padding = `# ${'x'.repeat(120)}\n`.repeat(600);
        await fs.writeUtf8('/repo/.git/config', `${head}${padding}`);

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.bare).toBe(true);
      });
    });
  });
  describe('Given a config entry that is a directory rather than a regular file', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it is treated as absent — a non-regular config is never read', async () => {
        // Arrange — on the node probe a planted FIFO stats at size 0 and would
        // pass the size cap; reading it would block forever. isFile is the gate.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.mkdir('/repo/.git/config');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result).toStrictEqual({
          bare: undefined,
          worktree: undefined,
          worktreeConfig: false,
        });
      });
    });
  });

  describe('Given a config that stats non-regular but whose readUtf8 would still return real content', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then the non-regular check short-circuits before that read is ever attempted', async () => {
        // Arrange — a hand-crafted probe that DECOUPLES stat from readUtf8,
        // simulating the real hazard the guard defends against: a FIFO stats
        // as non-regular but its content, if read, would still parse as a
        // real config. `MemoryFileSystem`'s own readUtf8 already fails
        // closed for a directory (both the `stat`-guard branch and the later
        // `text === undefined` branch return the same "absent" result
        // there), so only a probe that can return SOMETHING from readUtf8
        // proves the `stat` guard — not the later one — is what stops the
        // read.
        const probe: LayoutProbe = {
          stat: async () => ({ isDirectory: false, isFile: false, size: 3 }),
          readUtf8: async () => '[core]\n\tbare = true\n',
        };

        // Act
        const result = await readRepositoryFormat(probe, '/repo/.git', '/repo/.git', posixPolicy);

        // Assert — the non-regular entry is treated as absent; the config
        // text its readUtf8 stub would have supplied is never consulted.
        expect(result).toStrictEqual({
          bare: undefined,
          worktree: undefined,
          worktreeConfig: false,
        });
      });
    });
  });

  describe('Given core.bare set under a subsection', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it is ignored — only a TOP-LEVEL core.bare counts', async () => {
        // Arrange — `[core "custom"]` is a subsection; git's repository-format
        // keys are read only from the unqualified `[core]` section.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core "custom"]\n\tbare = true\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.bare).toBeUndefined();
      });
    });
  });

  describe('Given a bare = true entry under [extensions] rather than [core]', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it is ignored — the section filter binds the key to its own section', async () => {
        // Arrange — a same-named key in the WRONG section must never satisfy
        // a `core.bare` lookup.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[extensions]\n\tbare = true\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.bare).toBeUndefined();
      });
    });
  });

  describe('Given a valueless core.bare in the local config', () => {
    describe('When readRepositoryFormat runs', () => {
      it("Then bare is true — git's internal NULL for a valueless boolean", async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core]\n\tbare\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.bare).toBe(true);
      });
    });
  });

  describe('Given extensions.worktreeConfig set to a malformed boolean value', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then worktreeConfig is false — an invalid grammar is inert here, not a refusal', async () => {
        // Arrange — `config.worktree` also carries a distinguishing bare
        // value, so an accidentally-tripped gate is observable two ways.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\tbare = false\n[extensions]\n\tworktreeConfig = banana\n',
        );
        await fs.writeUtf8('/repo/.git/config.worktree', '[core]\n\tbare = true\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result).toStrictEqual({ bare: false, worktree: undefined, worktreeConfig: false });
      });
    });
  });
});
