import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import { TsgitError } from '../../../src/domain/error.js';
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

  describe('Given a local config file larger than the size cap', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it refuses with the gitfile-format code naming the config path — never a silent bareness flip', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        const head = '[core]\n\tbare = true\n';
        await fs.writeUtf8('/repo/.git/config', `${head}${'x'.repeat(70_000 - head.length)}`);
        let caught: TsgitError | undefined;

        // Act
        try {
          await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );
        } catch (err) {
          if (err instanceof TsgitError) caught = err;
        }

        // Assert — the cap refuses BEFORE parsing, loudly: treating an
        // oversized real config as empty would silently flip bareness.
        expect(caught?.data).toMatchObject({
          code: 'GITFILE_INVALID_FORMAT',
          path: '/repo/.git/config',
        });
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
});
