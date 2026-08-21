import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import { tokenizeConfig } from '../../../src/domain/config/config-ini.js';
import { TsgitError } from '../../../src/domain/error.js';
import type { LayoutProbe } from '../../../src/ports/layout-probe.js';
import { fileSystemLayoutProbe } from '../../../src/repository/file-system-layout-probe.js';
import {
  enumerateExtensionEntries,
  readRepositoryFormat,
} from '../../../src/repository/read-repository-format.js';

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
          objectFormat: 'sha1',
          refusal: undefined,
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
        expect(result).toStrictEqual({
          bare: true,
          worktree: undefined,
          worktreeConfig: true,
          objectFormat: 'sha1',
          refusal: undefined,
        });
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
        expect(result).toStrictEqual({
          bare: false,
          worktree: undefined,
          worktreeConfig: false,
          objectFormat: 'sha1',
          refusal: undefined,
        });
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
          objectFormat: 'sha1',
          refusal: undefined,
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
          objectFormat: 'sha1',
          refusal: undefined,
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
        expect(result).toStrictEqual({
          bare: false,
          worktree: undefined,
          worktreeConfig: false,
          objectFormat: 'sha1',
          refusal: undefined,
        });
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // core.repositoryformatversion — the version arm.
  // ───────────────────────────────────────────────────────────────────────

  /** Run `readRepositoryFormat` against a local `/repo/.git/config`, catching a throw. */
  const catchFormat = async (fs: MemoryFileSystem): Promise<unknown> => {
    try {
      await readRepositoryFormat(
        fileSystemLayoutProbe(fs),
        '/repo/.git',
        '/repo/.git',
        posixPolicy,
      );
      return undefined;
    } catch (err) {
      return err;
    }
  };

  interface BadNumericData {
    readonly code: string;
    readonly key: string;
    readonly source: string;
    readonly value: string;
    readonly reason: string;
  }

  /** Assert `caught` is the eager numeric refusal, naming `core.repositoryformatversion`. */
  const expectBadNumericVersion = (caught: unknown, value: string, reason: string): void => {
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data).toEqual({
      code: 'CONFIG_BAD_NUMERIC_VALUE',
      key: 'core.repositoryformatversion',
      source: '/repo/.git/config',
      value,
      reason,
    } satisfies BadNumericData);
  };

  describe('Given core.repositoryformatversion = 99 in the local config', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it carries a version refusal and throws nothing', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core]\n\trepositoryformatversion = 99\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.refusal).toStrictEqual({ kind: 'version', version: 99 });
      });
    });
  });

  describe('Given an accepted core.repositoryformatversion literal', () => {
    describe('When readRepositoryFormat runs', () => {
      it.each([['0'], ['1'], ['-1'], ['+1'], [' 1 '], ['0x1']])(
        'Then %j carries no refusal',
        async (literal) => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            `[core]\n\trepositoryformatversion = ${literal}\n`,
          );

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.refusal).toBeUndefined();
        },
      );
    });
  });

  describe('Given a refused version paired with an UNKNOWN extension name', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then the version arm wins — the two arms are ordered, not interchangeable', async () => {
        // Arrange — every other high-version fixture pairs with a name git
        // KNOWS, for which the extension arm returns nothing either way, so
        // swapping the two arms would survive them all.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = 99\n[extensions]\n\tbogus = 1\n',
        );

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.refusal).toStrictEqual({ kind: 'version', version: 99 });
      });
    });
  });

  describe('Given a NEGATIVE version paired with an UNKNOWN extension name', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it carries no refusal — a negative version refuses neither arm', async () => {
        // Arrange — every other extension-arm fixture pairs an unknown name
        // with `version === 0` or `version >= 1`; only a negative version
        // exercises the `>= 1` guard's false branch with a non-empty entries
        // array, so a mutant forcing that guard `true` survives every other
        // row here.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = -1\n[extensions]\n\tbogus = 1\n',
        );

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.refusal).toBeUndefined();
      });
    });
  });

  describe('Given a SUBSECTIONED v1-only extension at version 0', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it is accepted — a subsectioned name is not the v1-only name', async () => {
        // Arrange — measured: git accepts `[extensions "x"] objectFormat` at
        // version 0, so refusing it would be a faithfulness break. Without
        // this row the `subsection === undefined` conjunct is never exercised
        // on its own and dropping it changes no observed result.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = 0\n[extensions "x"]\n\tobjectFormat = sha1\n',
        );

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.refusal).toBeUndefined();
      });
    });
  });

  describe('Given a refused core.repositoryformatversion literal', () => {
    describe('When readRepositoryFormat runs', () => {
      it.each([
        ['2', 2],
        ['3', 3],
        ['99', 99],
        ['0777', 511],
        ['1k', 1024],
      ])('Then %s carries a version refusal for the parsed value %i', async (literal, parsed) => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', `[core]\n\trepositoryformatversion = ${literal}\n`);

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.refusal).toStrictEqual({ kind: 'version', version: parsed });
      });
    });
  });

  describe('Given core.repositoryformatversion = abc in the local config', () => {
    describe('When readRepositoryFormat runs', () => {
      it("Then it throws CONFIG_BAD_NUMERIC_VALUE with reason 'invalid unit'", async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core]\n\trepositoryformatversion = abc\n');

        // Act
        const caught = await catchFormat(fs);

        // Assert
        expectBadNumericVersion(caught, 'abc', 'invalid unit');
      });
    });
  });

  describe('Given core.repositoryformatversion set to the empty string', () => {
    describe('When readRepositoryFormat runs', () => {
      it("Then it throws CONFIG_BAD_NUMERIC_VALUE naming the empty value with reason 'invalid unit'", async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core]\n\trepositoryformatversion =\n');

        // Act
        const caught = await catchFormat(fs);

        // Assert
        expectBadNumericVersion(caught, '', 'invalid unit');
      });
    });
  });

  describe('Given core.repositoryformatversion = 1.0 in the local config', () => {
    describe('When readRepositoryFormat runs', () => {
      it("Then it throws CONFIG_BAD_NUMERIC_VALUE with reason 'invalid unit'", async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core]\n\trepositoryformatversion = 1.0\n');

        // Act
        const caught = await catchFormat(fs);

        // Assert
        expectBadNumericVersion(caught, '1.0', 'invalid unit');
      });
    });
  });

  describe('Given core.repositoryformatversion = 08 in the local config', () => {
    describe('When readRepositoryFormat runs', () => {
      it("Then it throws CONFIG_BAD_NUMERIC_VALUE with reason 'invalid unit'", async () => {
        // Arrange — the octal run stops at the first non-octal digit; the
        // trailing `8` is then read as an invalid unit suffix.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core]\n\trepositoryformatversion = 08\n');

        // Act
        const caught = await catchFormat(fs);

        // Assert
        expectBadNumericVersion(caught, '08', 'invalid unit');
      });
    });
  });

  describe('Given a valueless core.repositoryformatversion in the local config', () => {
    describe('When readRepositoryFormat runs', () => {
      it("Then it throws CONFIG_BAD_NUMERIC_VALUE naming the empty value with reason 'invalid unit'", async () => {
        // Arrange — no `=` at all: git's internal NULL, reported as value ''.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core]\n\trepositoryformatversion\n');

        // Act
        const caught = await catchFormat(fs);

        // Assert
        expectBadNumericVersion(caught, '', 'invalid unit');
      });
    });
  });

  describe('Given core.repositoryformatversion = 9223372036854775808 (int64 max + 1)', () => {
    describe('When readRepositoryFormat runs', () => {
      it("Then it throws CONFIG_BAD_NUMERIC_VALUE with reason 'out of range'", async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = 9223372036854775808\n',
        );

        // Act
        const caught = await catchFormat(fs);

        // Assert
        expectBadNumericVersion(caught, '9223372036854775808', 'out of range');
      });
    });
  });

  describe('Given core.repositoryformatversion = -9223372036854775809 (int64 min - 1)', () => {
    describe('When readRepositoryFormat runs', () => {
      it("Then it throws CONFIG_BAD_NUMERIC_VALUE with reason 'out of range'", async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = -9223372036854775809\n',
        );

        // Act
        const caught = await catchFormat(fs);

        // Assert
        expectBadNumericVersion(caught, '-9223372036854775809', 'out of range');
      });
    });
  });

  describe('Given core.repositoryformatversion = 999999999999999999999999999999 (far out of range)', () => {
    describe('When readRepositoryFormat runs', () => {
      it("Then it throws CONFIG_BAD_NUMERIC_VALUE with reason 'out of range'", async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = 999999999999999999999999999999\n',
        );

        // Act
        const caught = await catchFormat(fs);

        // Assert
        expectBadNumericVersion(caught, '999999999999999999999999999999', 'out of range');
      });
    });
  });

  describe('Given core.repositoryformatversion = 0, then 99, then 0 (last-wins, accepted)', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it carries no refusal — the effective value is the last well-formed one', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = 0\n\trepositoryformatversion = 99\n\trepositoryformatversion = 0\n',
        );

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.refusal).toBeUndefined();
      });
    });
  });

  describe('Given core.repositoryformatversion = 0, then 0, then 99 (last-wins, refused)', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it carries a version refusal for 99', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = 0\n\trepositoryformatversion = 0\n\trepositoryformatversion = 99\n',
        );

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.refusal).toStrictEqual({ kind: 'version', version: 99 });
      });
    });
  });

  describe('Given core.repositoryformatversion = abc on an early line, then 0 later', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it still throws — a later valid line does not rescue an earlier malformed one', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = abc\n\trepositoryformatversion = 0\n',
        );

        // Act
        const caught = await catchFormat(fs);

        // Assert
        expectBadNumericVersion(caught, 'abc', 'invalid unit');
      });
    });
  });

  describe('Given core.repositoryformatversion = 0 first, then abc', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it throws — every malformed occurrence fires, in file order', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = 0\n\trepositoryformatversion = abc\n',
        );

        // Act
        const caught = await catchFormat(fs);

        // Assert
        expectBadNumericVersion(caught, 'abc', 'invalid unit');
      });
    });
  });

  describe('Given [CoRe] / RePoSiToRyFoRmAtVeRsIoN = 99 (mixed case)', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it still refuses — section and key are case-insensitive', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[CoRe]\n\tRePoSiToRyFoRmAtVeRsIoN = 99\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.refusal).toStrictEqual({ kind: 'version', version: 99 });
      });
    });
  });

  describe('Given [core "x"] repositoryformatversion = 99 (subsectioned)', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it is ignored — a subsectioned core is not [core]', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8('/repo/.git/config', '[core "x"]\n\trepositoryformatversion = 99\n');

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.refusal).toBeUndefined();
      });
    });
  });

  describe('Given a repositoryformatversion = 99 planted in config.worktree, with worktreeConfig active at v1', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it is inert — the format keys read only <commonDir>/config, never the scoped file', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tworktreeConfig = true\n',
        );
        await fs.writeUtf8(
          '/repo/.git/config.worktree',
          '[core]\n\trepositoryformatversion = 99\n',
        );

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.refusal).toBeUndefined();
      });
    });
  });

  describe('Given a core.bare planted in config.worktree alongside repositoryformatversion = 1 locally', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then core.bare from config.worktree still wins — the format-key scoping asymmetry is unaffected', async () => {
        // Arrange — the mirror of the previous row: core.bare/core.worktree
        // keep going through pickScoped even though the version does not.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tworktreeConfig = true\n',
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
        expect(result.bare).toBe(true);
        expect(result.refusal).toBeUndefined();
      });
    });
  });

  describe('Given core.repositoryformatversion = 99 AND core.bare = banana in the local config', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it throws CONFIG_BAD_BOOLEAN_VALUE — the bad-boolean fatal wins; the version verdict is never returned', async () => {
        // Arrange — the version verdict is carried, never thrown, so an
        // eager throw elsewhere must win outright and pin the ordering.
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = 99\n\tbare = banana\n',
        );

        // Act
        const caught = await catchFormat(fs);

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

  // ───────────────────────────────────────────────────────────────────────
  // enumerateExtensionEntries — the sibling enumerator over every
  // `[extensions]` entry, subsectioned ones included, in file order.
  // ───────────────────────────────────────────────────────────────────────

  describe('enumerateExtensionEntries', () => {
    describe('Given an [extensions] block with various list shapes', () => {
      describe('When enumerateExtensionEntries runs', () => {
        it.each([
          ['[extensions]\n\tbogus = 1\n', ['bogus']],
          ['[extensions]\n\tbogus = 1\n\talsoBogus = 1\n', ['bogus', 'alsobogus']],
          ['[extensions]\n\tzzz = 1\n\taaa = 1\n\tmmm = 1\n', ['zzz', 'aaa', 'mmm']],
          ['[extensions]\n\tbogus = 1\n\tbogus = 2\n', ['bogus', 'bogus']],
          ['[extensions]\n\tbogus\n', ['bogus']],
        ])('Then %j yields the names %j', (text, expectedNames) => {
          // Arrange
          const tokens = tokenizeConfig(text, '/repo/.git/config');

          // Act
          const result = enumerateExtensionEntries(tokens);

          // Assert
          expect(result.map((entry) => entry.name)).toStrictEqual(expectedNames);
        });
      });
    });

    describe('Given [extensions "X"] bogus = 1', () => {
      describe('When enumerateExtensionEntries runs', () => {
        it('Then the entry carries name X.bogus, key bogus, and subsection X verbatim', () => {
          // Arrange
          const tokens = tokenizeConfig('[extensions "X"]\n\tbogus = 1\n', '/repo/.git/config');

          // Act
          const result = enumerateExtensionEntries(tokens);

          // Assert
          expect(result).toStrictEqual([
            { name: 'X.bogus', key: 'bogus', subsection: 'X', value: '1', line: 2 },
          ]);
        });
      });
    });

    describe('Given [extensions ""] bogus = 1', () => {
      describe('When enumerateExtensionEntries runs', () => {
        it('Then the entry carries name .bogus with an empty subsection', () => {
          // Arrange
          const tokens = tokenizeConfig('[extensions ""]\n\tbogus = 1\n', '/repo/.git/config');

          // Act
          const result = enumerateExtensionEntries(tokens);

          // Assert
          expect(result).toStrictEqual([
            { name: '.bogus', key: 'bogus', subsection: '', value: '1', line: 2 },
          ]);
        });
      });
    });

    describe('Given [extensions "x"] worktreeConfig = true', () => {
      describe('When enumerateExtensionEntries runs', () => {
        it('Then the entry carries name x.worktreeconfig — a subsectioned known name is still enumerated', () => {
          // Arrange
          const tokens = tokenizeConfig(
            '[extensions "x"]\n\tworktreeConfig = true\n',
            '/repo/.git/config',
          );

          // Act
          const result = enumerateExtensionEntries(tokens);

          // Assert
          expect(result).toStrictEqual([
            {
              name: 'x.worktreeconfig',
              key: 'worktreeconfig',
              subsection: 'x',
              value: 'true',
              line: 2,
            },
          ]);
        });
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // The two extension arms — git's nine known names × {absent, v0, v1},
  // plus an unknown name in the same three states. The two remaining
  // UNBACKED_EXTENSIONS members (compatObjectFormat, refStorage) are
  // excluded at v1 (they throw, asserted separately below) rather than
  // folded into this sweep's oracle. `objectFormat` left that set (its own
  // dedicated test below covers its v1 row) but keeps its undefined/v0 rows
  // here for parity with the sibling sweeps.
  // ───────────────────────────────────────────────────────────────────────

  describe('The two extension arms', () => {
    /** Plants ONE `extensions.<name> = <value>` entry, with an optional version. */
    const buildExtensionsConfig = (
      version: number | undefined,
      name: string,
      value: string,
    ): string => {
      const versionBlock =
        version === undefined ? '' : `[core]\n\trepositoryformatversion = ${version}\n`;
      return `${versionBlock}[extensions]\n\t${name} = ${value}\n`;
    };

    // `objectFormat` alone now carries its own value grammar (this part);
    // every other known extension name stays a grammar-free placeholder —
    // measured against git 2.55.0: `objectFormat = true` refuses with
    // CONFIG_INVALID_ENUM_VALUE before the acceptance gate ever runs, so
    // the generic placeholder would falsify the 'accept'/'v1only' rows below.
    const plantedValueFor = (name: string): string => (name === 'objectFormat' ? 'sha256' : 'true');

    describe('Given each git-known extension planted alone at absent, v0, and v1', () => {
      describe('When readRepositoryFormat runs', () => {
        it.each([
          ['noop', undefined, 'accept'],
          ['noop', 0, 'accept'],
          ['noop', 1, 'accept'],
          ['noop-v1', undefined, 'accept'],
          ['noop-v1', 0, 'v1only'],
          ['noop-v1', 1, 'accept'],
          ['worktreeConfig', undefined, 'accept'],
          ['worktreeConfig', 0, 'accept'],
          ['worktreeConfig', 1, 'accept'],
          ['preciousObjects', undefined, 'accept'],
          ['preciousObjects', 0, 'accept'],
          ['preciousObjects', 1, 'accept'],
          ['partialClone', undefined, 'accept'],
          ['partialClone', 0, 'accept'],
          ['partialClone', 1, 'accept'],
          ['relativeWorktrees', undefined, 'accept'],
          ['relativeWorktrees', 0, 'v1only'],
          ['relativeWorktrees', 1, 'accept'],
          ['objectFormat', undefined, 'accept'],
          ['objectFormat', 0, 'v1only'],
          ['compatObjectFormat', undefined, 'accept'],
          ['compatObjectFormat', 0, 'v1only'],
          ['refStorage', undefined, 'accept'],
          ['refStorage', 0, 'v1only'],
          ['bogus', undefined, 'accept'],
          ['bogus', 0, 'accept'],
          ['bogus', 1, 'unknown'],
        ] as const)('Then extensions.%s at version %s is %s', async (name, version, expected) => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            buildExtensionsConfig(version, name, plantedValueFor(name)),
          );
          const lowerName = name.toLowerCase();

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          if (expected === 'accept') {
            expect(result.refusal).toBeUndefined();
          } else if (expected === 'v1only') {
            expect(result.refusal).toStrictEqual({
              kind: 'extensions',
              version: 0,
              extensions: [lowerName],
            });
          } else {
            expect(result.refusal).toStrictEqual({
              kind: 'extensions',
              version: 1,
              extensions: [lowerName],
            });
          }
        });
      });
    });
  });

  describe('Given core.repositoryformatversion = 0 with a v1-only extension and an unknown extension together', () => {
    describe('When readRepositoryFormat runs', () => {
      it('Then it carries the v1-only refusal and the unknown name is ignored', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await fs.writeUtf8(
          '/repo/.git/config',
          '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tobjectFormat = sha1\n\tbogus = 1\n',
        );

        // Act
        const result = await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );

        // Assert
        expect(result.refusal).toStrictEqual({
          kind: 'extensions',
          version: 0,
          extensions: ['objectformat'],
        });
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // The unbacked-extension refuse set — a top-level ACCEPTED extension
  // tsgit cannot yet act on, thrown at open rather than misread. Every
  // guard below is triggered alone (CLAUDE.md).
  // ───────────────────────────────────────────────────────────────────────

  describe('The unbacked-extension refuse set', () => {
    describe('Given extensions.compatObjectFormat with the version key absent', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it accepts — the refuse-set arm never fires below version 1', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8('/repo/.git/config', '[extensions]\n\tcompatObjectFormat = sha1\n');

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.refusal).toBeUndefined();
        });
      });
    });

    describe('Given extensions.compatObjectFormat with repositoryformatversion = -1', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it accepts — the refuse-set arm never fires below version 1', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = -1\n[extensions]\n\tcompatObjectFormat = sha1\n',
          );

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.refusal).toBeUndefined();
        });
      });
    });

    describe('Given extensions.compatObjectFormat with repositoryformatversion = 0', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it takes the v1-only arm — the refuse-set arm never fires below version 1', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tcompatObjectFormat = sha1\n',
          );

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.refusal).toStrictEqual({
            kind: 'extensions',
            version: 0,
            extensions: ['compatobjectformat'],
          });
        });
      });
    });

    describe('Given extensions.compatObjectFormat with repositoryformatversion = 2 or 99', () => {
      describe('When readRepositoryFormat runs', () => {
        it.each([[2], [99]])(
          'Then it takes the version arm for %i — the refuse-set arm never fires above version 1',
          async (version) => {
            // Arrange
            const fs = new MemoryFileSystem({ rootDir: '/repo' });
            await fs.writeUtf8(
              '/repo/.git/config',
              `[core]\n\trepositoryformatversion = ${version}\n[extensions]\n\tcompatObjectFormat = sha1\n`,
            );

            // Act
            const result = await readRepositoryFormat(
              fileSystemLayoutProbe(fs),
              '/repo/.git',
              '/repo/.git',
              posixPolicy,
            );

            // Assert
            expect(result.refusal).toStrictEqual({ kind: 'version', version });
          },
        );
      });
    });

    describe('Given a subsectioned [extensions "x"] compatObjectFormat at version 1', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it carries the unknown-extension refusal, not the refuse-set throw', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions "x"]\n\tcompatObjectFormat = sha1\n',
          );

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.refusal).toStrictEqual({
            kind: 'extensions',
            version: 1,
            extensions: ['x.compatobjectformat'],
          });
        });
      });
    });

    describe('Given a valueless extensions.compatObjectFormat at version 1', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it throws CONFIG_MISSING_VALUE naming extensions.compatobjectformat and the line', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tcompatObjectFormat\n',
          );

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
            key: 'extensions.compatobjectformat',
            source: '/repo/.git/config',
            line: 4,
          });
        });
      });
    });

    describe('Given extensions.<name> = <value> at version 1, for each unbacked-extension member', () => {
      describe('When readRepositoryFormat runs', () => {
        it.each([
          ['compatObjectFormat', 'sha1'],
          ['refStorage', 'reftable'],
        ])(
          'Then extensions.%s throws REPOSITORY_EXTENSION_UNSUPPORTED naming the value %s',
          async (name, value) => {
            // Arrange
            const fs = new MemoryFileSystem({ rootDir: '/repo' });
            await fs.writeUtf8(
              '/repo/.git/config',
              `[core]\n\trepositoryformatversion = 1\n[extensions]\n\t${name} = ${value}\n`,
            );

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
              code: 'REPOSITORY_EXTENSION_UNSUPPORTED',
              extension: name.toLowerCase(),
              value,
            });
          },
        );
      });
    });

    describe('Given a repository declaring extensions.objectFormat = sha256 at version 1', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it succeeds — objectFormat left the unbacked-extension refuse set', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha256\n',
          );

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.refusal).toBeUndefined();
          expect(result.objectFormat).toBe('sha256');
        });
      });
    });

    describe('Given extensions.compatObjectFormat and a malformed extensions.worktreeConfig at version 1', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then the bad-boolean fatal wins over the refuse-set throw', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tcompatObjectFormat = sha1\n\tworktreeConfig = banana\n',
          );

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
            key: 'extensions.worktreeconfig',
            source: '/repo/.git/config',
            value: 'banana',
          });
        });
      });
    });

    describe('Given extensions.compatObjectFormat and a WELL-FORMED extensions.worktreeConfig at version 1', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then the refuse-set throw wins — a valid worktreeConfig boolean never blocks it', async () => {
          // Arrange — the sibling row above proves the malformed-boolean
          // fatal wins; this row proves the INVERSE: a well-formed boolean
          // must fall through to the refuse-set throw rather than being
          // (wrongly) treated as malformed.
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tcompatObjectFormat = sha1\n\tworktreeConfig = true\n',
          );

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
            code: 'REPOSITORY_EXTENSION_UNSUPPORTED',
            extension: 'compatobjectformat',
            value: 'sha1',
          });
        });
      });
    });

    describe('Given extensions.compatObjectFormat and an unknown sibling extension at version 1', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it carries the format verdict — the unknown-extension refusal — and throws nothing', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tcompatObjectFormat = sha1\n\tbogus = 1\n',
          );

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.refusal).toStrictEqual({
            kind: 'extensions',
            version: 1,
            extensions: ['bogus'],
          });
        });
      });
    });

    describe('Given extensions.compatObjectFormat and a malformed core.sparseCheckout at version 1', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then the refuse-set throw wins — the eager [core] gate is command-time, not open-time', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 1\n\tsparseCheckout = banana\n[extensions]\n\tcompatObjectFormat = sha1\n',
          );

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
            code: 'REPOSITORY_EXTENSION_UNSUPPORTED',
            extension: 'compatobjectformat',
            value: 'sha1',
          });
        });
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // extensions.objectFormat — the value grammar (measured against git
  // 2.55.0). Deliberately planted with NO core.repositoryformatversion, so
  // the version-ceiling arm of the acceptance gate never enters the picture
  // — these rows exercise the value-grammar layer in isolation, exactly like
  // `core.bare` / `core.worktree` above. `objectFormat` no longer sits in
  // UNBACKED_EXTENSIONS, so this isolation is no longer load-bearing for the
  // refuse-set arm either — kept anyway for parity with the sibling sweeps.
  // ───────────────────────────────────────────────────────────────────────

  describe('extensions.objectFormat — the value grammar', () => {
    /** Run readRepositoryFormat against a local config, catching a throw. */
    const catchObjectFormat = async (config: string): Promise<unknown> => {
      const fs = new MemoryFileSystem({ rootDir: '/repo' });
      await fs.writeUtf8('/repo/.git/config', config);
      try {
        await readRepositoryFormat(
          fileSystemLayoutProbe(fs),
          '/repo/.git',
          '/repo/.git',
          posixPolicy,
        );
        return undefined;
      } catch (err) {
        return err;
      }
    };

    describe('Given extensions.objectFormat = sha256', () => {
      describe('When readRepositoryFormat runs', () => {
        it("Then objectFormat is 'sha256'", async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha256\n',
          );

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.objectFormat).toBe('sha256');
        });
      });
    });

    describe('Given extensions.objectFormat = sha1', () => {
      describe('When readRepositoryFormat runs', () => {
        it("Then objectFormat is 'sha1' — an explicit, legal no-op", async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha1\n',
          );

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.objectFormat).toBe('sha1');
        });
      });
    });

    describe('Given no extensions.objectFormat at v1', () => {
      describe('When readRepositoryFormat runs', () => {
        it("Then objectFormat is 'sha1'", async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8('/repo/.git/config', '[core]\n\trepositoryformatversion = 1\n');

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.objectFormat).toBe('sha1');
        });
      });
    });

    describe('Given extensions.objectFormat = SHA256 (upper-case)', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it throws CONFIG_INVALID_ENUM_VALUE naming the lower-cased key and the verbatim value — the value grammar is case-sensitive', async () => {
          // Arrange & Act
          const caught = await catchObjectFormat('[extensions]\n\tobjectFormat = SHA256\n');

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'CONFIG_INVALID_ENUM_VALUE',
            key: 'extensions.objectformat',
            source: '/repo/.git/config',
            value: 'SHA256',
            line: 2,
          });
        });
      });
    });

    describe('Given extensions.objectFormat = Sha256 (mixed case)', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it throws CONFIG_INVALID_ENUM_VALUE with value Sha256 — case-sensitivity is not an all-caps special case', async () => {
          // Arrange & Act
          const caught = await catchObjectFormat('[extensions]\n\tobjectFormat = Sha256\n');

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'CONFIG_INVALID_ENUM_VALUE',
            key: 'extensions.objectformat',
            source: '/repo/.git/config',
            value: 'Sha256',
            line: 2,
          });
        });
      });
    });

    describe('Given extensions.objectFormat = sha-256', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it throws CONFIG_INVALID_ENUM_VALUE with value sha-256', async () => {
          // Arrange & Act
          const caught = await catchObjectFormat('[extensions]\n\tobjectFormat = sha-256\n');

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'CONFIG_INVALID_ENUM_VALUE',
            key: 'extensions.objectformat',
            source: '/repo/.git/config',
            value: 'sha-256',
            line: 2,
          });
        });
      });
    });

    describe('Given extensions.objectFormat = sha256x', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it throws CONFIG_INVALID_ENUM_VALUE with value sha256x', async () => {
          // Arrange & Act
          const caught = await catchObjectFormat('[extensions]\n\tobjectFormat = sha256x\n');

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'CONFIG_INVALID_ENUM_VALUE',
            key: 'extensions.objectformat',
            source: '/repo/.git/config',
            value: 'sha256x',
            line: 2,
          });
        });
      });
    });

    describe('Given extensions.objectFormat set to the empty string', () => {
      describe('When readRepositoryFormat runs', () => {
        it("Then it throws CONFIG_INVALID_ENUM_VALUE with value '' — an empty string is a value, not the missing-value shape", async () => {
          // Arrange & Act
          const caught = await catchObjectFormat('[extensions]\n\tobjectFormat =\n');

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'CONFIG_INVALID_ENUM_VALUE',
            key: 'extensions.objectformat',
            source: '/repo/.git/config',
            value: '',
            line: 2,
          });
        });
      });
    });

    describe('Given a valueless extensions.objectFormat', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it throws CONFIG_MISSING_VALUE naming the key, the source and the 1-based line — the second guard, proven alone', async () => {
          // Arrange & Act
          const caught = await catchObjectFormat('[extensions]\n\tobjectFormat\n');

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'CONFIG_MISSING_VALUE',
            key: 'extensions.objectformat',
            source: '/repo/.git/config',
            line: 2,
          });
        });
      });
    });

    describe('Given extensions.objectFormat padded with whitespace', () => {
      describe('When readRepositoryFormat runs', () => {
        it("Then it is accepted as 'sha256' — the config tokeniser strips before the grammar ever sees it", async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat =   sha256  \n',
          );

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.objectFormat).toBe('sha256');
        });
      });
    });

    describe('Given extensions.objectFormat = sha256 then sha1', () => {
      describe('When readRepositoryFormat runs', () => {
        it("Then last-wins yields 'sha1'", async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha256\n\tobjectFormat = sha1\n',
          );

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.objectFormat).toBe('sha1');
        });
      });
    });

    describe('Given extensions.objectFormat = sha1 then sha256', () => {
      describe('When readRepositoryFormat runs', () => {
        it("Then last-wins yields 'sha256' — proven in both orders", async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8(
            '/repo/.git/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha1\n\tobjectFormat = sha256\n',
          );

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.objectFormat).toBe('sha256');
        });
      });
    });

    describe('Given extensions.objectFormat = sha256 with NO core.repositoryformatversion key', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then the extension is inert and the format stays sha1 — git ignores extensions below version 1', async () => {
          // Arrange — measured on git 2.55.0: this exact config opens cleanly
          // and `rev-parse --show-object-format` reports sha1. Adopting sha256
          // here would read every oid, index entry and pack at 32 bytes in a
          // repository git reads at 20.
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8('/repo/.git/config', '[extensions]\n\tobjectFormat = sha256\n');

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.objectFormat).toBe('sha1');
          expect(result.refusal).toBeUndefined();
        });
      });
    });

    describe('Given an INVALID extensions.objectFormat with NO core.repositoryformatversion key', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it still refuses — the grammar is checked at every version, only the adoption is gated', async () => {
          // Arrange — the companion to the row above, and the reason the
          // version gate wraps the ADOPTION rather than the resolve: measured,
          // git refuses this with `invalid value for 'extensions.objectformat'`
          // even though it would have ignored a well-formed value here.
          const caught = await catchObjectFormat('[extensions]\n\tobjectFormat = SHA256\n');

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('CONFIG_INVALID_ENUM_VALUE');
          if (data.code !== 'CONFIG_INVALID_ENUM_VALUE') expect.unreachable();
          expect(data.value).toBe('SHA256');
        });
      });
    });

    describe('Given extensions.objectFormat = sha256 planted only in config.worktree, with worktreeConfig true', () => {
      describe('When readRepositoryFormat runs', () => {
        it('Then it is inert and the format stays sha1 — the format keys are never scoped to config.worktree', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await fs.writeUtf8('/repo/.git/config', '[extensions]\n\tworktreeConfig = true\n');
          await fs.writeUtf8(
            '/repo/.git/config.worktree',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha256\n',
          );

          // Act
          const result = await readRepositoryFormat(
            fileSystemLayoutProbe(fs),
            '/repo/.git',
            '/repo/.git',
            posixPolicy,
          );

          // Assert
          expect(result.objectFormat).toBe('sha1');
        });
      });
    });
  });
});
