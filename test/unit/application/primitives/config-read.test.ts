import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  __resetConfigCacheForTests,
  type ConfigToken,
  findFirstInvalidBoolean,
  findFirstInvalidBooleanInSection,
  findFirstInvalidCompression,
  findFirstInvalidLogAllRefUpdates,
  findFirstInvalidPushGpgSign,
  findFirstValuelessEntry,
  findFirstValuelessInSection,
  findInvalidPushDefault,
  findLastInvalidMaxTreeDepth,
  type IniSection,
  invalidateConfigCache,
  parseGitBoolean,
  parseGitInt,
  parseIniSections,
  readConfig,
  tokenizeConfig,
} from '../../../../src/application/primitives/config-read.js';
import {
  __resetSectionsCacheForTests,
  getAllConfigValues,
  getConfigValue,
  invalidateScopedConfigCache,
  readConfigSections,
} from '../../../../src/application/primitives/config-scoped-read.js';
import { qualifyKey } from '../../../../src/application/primitives/internal/config-key.js';
import { parseConfigKey } from '../../../../src/domain/commands/config-key.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Context } from '../../../../src/ports/context.js';

const seed = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

describe('primitives/config-read', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  describe('Given missing .git/config', () => {
    describe('When readConfig', () => {
      it('Then returns empty parsed config', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result).toEqual({});
      });
    });
  });

  describe('Given a config with a [core] bare value', () => {
    describe('When readConfig', () => {
      it.each([
        { value: 'true', expected: true, label: 'parsed.core.bare is true' },
        { value: 'false', expected: false, label: 'parsed.core.bare is false' },
        { value: 'nope', expected: undefined, label: 'an unparseable boolean is absent' },
        { value: 'yes', expected: true, label: 'parsed.core.bare is true (yes truthy alias)' },
        { value: 'no', expected: false, label: 'parsed.core.bare is false (no falsy alias)' },
        { value: 'on', expected: true, label: 'parsed.core.bare is true (on truthy alias)' },
        { value: 'off', expected: false, label: 'parsed.core.bare is false (off falsy alias)' },
      ])('Then $label', async ({ value, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, `[core]\nbare = ${value}\n`);

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.bare).toBe(expected);
      });
    });
  });

  describe('Given a config with a [core] logallrefupdates value', () => {
    describe('When readConfig', () => {
      it.each([
        { value: 'true', expected: true, label: 'logAllRefUpdates is true' },
        { value: 'false', expected: false, label: 'logAllRefUpdates is false' },
        { value: 'always', expected: 'always', label: "logAllRefUpdates is 'always'" },
        { value: 'ALWAYS', expected: 'always', label: 'matching is case-insensitive' },
      ])('Then $label', async ({ value, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, `[core]\n  logallrefupdates = ${value}\n`);

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.logAllRefUpdates).toBe(expected);
      });
    });
  });

  describe('Given a config without logallrefupdates', () => {
    describe('When readConfig', () => {
      it('Then core has no logAllRefUpdates key', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — strict shape: no `logAllRefUpdates` key is emitted at all,
        // not even as an explicit `undefined`.
        expect(result.core).toStrictEqual({ bare: true });
      });
    });
  });

  describe('Given a [core] key that must not promote core into existence, When readConfig', () => {
    it.each([
      {
        config: '[core]\n  autocrlf = always\n',
        label: 'an unrecognised key (autocrlf is a real git key tsgit ignores)',
      },
      {
        config: '[core]\n  bareX\n',
        label: 'an unrecognized valueless key (bareX, not consumed by the [core] merge)',
      },
      {
        config: '[core]\n  excludesfile\n',
        label: 'a string-typed key as a valueless entry (excludesfile skipped)',
      },
    ])('Then core stays undefined ($label)', async ({ config }) => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, config);

      // Act
      const result = await readConfig(ctx);

      // Assert
      expect(result.core).toBeUndefined();
    });
  });

  describe('Given only logallrefupdates in [core]', () => {
    describe('When readConfig', () => {
      it('Then core is emitted with that field', async () => {
        // Arrange — guards the finalize() arm that now also checks logAllRefUpdates.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  logallrefupdates = always\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core).toEqual({ logAllRefUpdates: 'always' });
      });
    });
  });

  describe('Given [core] hooksPath set', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.hooksPath carries the value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  hooksPath = /opt/githooks\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.hooksPath).toBe('/opt/githooks');
      });
    });
  });

  describe('Given [core] HooksPath in mixed case', () => {
    describe('When readConfig', () => {
      it('Then the key match is case-insensitive', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  HooksPath = .husky\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.hooksPath).toBe('.husky');
      });
    });
  });

  describe('Given only hooksPath in [core]', () => {
    describe('When readConfig', () => {
      it('Then core is emitted with that field', async () => {
        // Arrange — guards the finalize() arm that now also checks hooksPath.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  hooksPath = /opt/githooks\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core).toEqual({ hooksPath: '/opt/githooks' });
      });
    });
  });

  describe('Given [core] notesRef set', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.notesRef carries the value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  notesRef = refs/notes/custom\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.notesRef).toBe('refs/notes/custom');
      });
    });
  });

  describe('Given [core] notesref in lowercase', () => {
    describe('When readConfig', () => {
      it('Then key match is case-insensitive', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  notesref = refs/notes/custom\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.notesRef).toBe('refs/notes/custom');
      });
    });
  });

  describe('Given a config with [user] name and email', () => {
    describe('When readConfig', () => {
      it('Then parsed.user is populated', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n  name = Ada Lovelace\n  email = ada@example.com\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.user?.name).toBe('Ada Lovelace');
        expect(result.user?.email).toBe('ada@example.com');
      });
    });
  });

  describe('Given a config that must not populate [user], When readConfig', () => {
    it.each([
      { config: '[user]\n  name = Solo\n', label: 'name only (email required too)' },
      { config: '[user]\n  email = ada@example.com\n', label: 'email only (name required too)' },
      {
        config: '[foo]\n  name = X\n  email = e@x.com\n',
        label: 'name and email under a non-user section',
      },
      {
        config: '[user "sub"]\n  name = X\n  email = e@x.com\n',
        label: 'name and email under a subsectioned [user "sub"]',
      },
      {
        config: '[user]\n  name = N\n  bogus = B\n',
        label: 'name and an unrecognized key (not treated as email)',
      },
    ])('Then parsed.user is undefined ($label)', async ({ config }) => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, config);

      // Act
      const result = await readConfig(ctx);

      // Assert
      expect(result.user).toBeUndefined();
    });
  });

  describe('Given a config with [user] signingKey', () => {
    describe('When readConfig', () => {
      it('Then user.signingKey is the configured value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n  signingKey = ABCD1234\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.user?.signingKey).toBe('ABCD1234');
      });
    });
  });

  describe('Given [user] signingKey with no name/email', () => {
    describe('When readConfig', () => {
      it('Then user has exactly the signingKey key with no name/email keys', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n  signingKey = ABCD1234\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — strict key set: name/email must be absent, not present-and-undefined
        expect(result.user).toStrictEqual({ signingKey: 'ABCD1234' });
      });
    });
  });

  describe('Given [user] name and email but no signingKey', () => {
    describe('When readConfig', () => {
      it('Then user has exactly the name and email keys with no signingKey key', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n  name = Ada Lovelace\n  email = ada@example.com\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — strict key set: signingKey must be absent, not present-and-undefined
        expect(result.user).toStrictEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
      });
    });
  });

  describe('Given a [remote "origin"] section with url', () => {
    describe('When readConfig', () => {
      it('Then parsed.remote.get("origin")?.url is set', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n  url = https://example.com/r.git\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('origin')?.url).toBe('https://example.com/r.git');
      });
    });
  });

  describe('Given a [remote "origin"] section with multiple fetch lines', () => {
    describe('When readConfig', () => {
      it('Then all fetch refspecs are collected in order', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[remote "origin"]\n  url = https://example.com/r.git\n  fetch = +refs/heads/*:refs/remotes/origin/*\n  fetch = +refs/tags/*:refs/tags/*\n',
        );

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('origin')?.fetch).toEqual([
          '+refs/heads/*:refs/remotes/origin/*',
          '+refs/tags/*:refs/tags/*',
        ]);
      });
    });
  });

  describe('Given a [branch "main"] section with remote and merge', () => {
    describe('When readConfig', () => {
      it('Then parsed.branch.get("main") populated', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "main"]\n  remote = origin\n  merge = refs/heads/main\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.branch?.get('main')?.remote).toBe('origin');
        expect(result.branch?.get('main')?.merge).toBe('refs/heads/main');
      });
    });
  });

  describe('Given a [branch "main"] section with pushRemote', () => {
    describe('When readConfig', () => {
      it('Then parsed.branch.get("main").pushRemote is set', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "main"]\n  remote = origin\n  pushRemote = upstream\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.branch?.get('main')?.pushRemote).toBe('upstream');
      });
    });
  });

  describe('Given a [branch "main"] section with pushRemote in a different case', () => {
    describe('When readConfig', () => {
      it('Then the PUSHREMOTE key is matched case-insensitively', async () => {
        // Arrange — git config keys are case-insensitive; `PUSHREMOTE` must fold to `pushremote`.
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "main"]\n  PUSHREMOTE = upstream\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.branch?.get('main')?.pushRemote).toBe('upstream');
      });
    });
  });

  describe('Given a [branch "main"] section without pushRemote', () => {
    describe('When readConfig', () => {
      it('Then parsed.branch.get("main").pushRemote is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "main"]\n  remote = origin\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.branch?.get('main')?.pushRemote).toBeUndefined();
      });
    });
  });

  describe('Given a [branch "main"] section with an unrelated key', () => {
    describe('When readConfig', () => {
      it('Then pushRemote stays undefined (only remote/merge/pushRemote are read)', async () => {
        // Arrange — `foo` is none of remote/merge/pushRemote, so it must never set pushRemote.
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "main"]\n  foo = bar\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.branch?.get('main')?.pushRemote).toBeUndefined();
      });
    });
  });

  describe('Given a [branch "main"] section with a valueless pushRemote key', () => {
    describe('When readConfig', () => {
      it('Then pushRemote is skipped (valueless key treated as absent)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "main"]\n  pushRemote\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.branch?.get('main')?.pushRemote).toBeUndefined();
      });
    });
  });

  describe('Given a [submodule "libs/a"] section with url, active and update', () => {
    describe('When readConfig', () => {
      it('Then parsed.submodule.get("libs/a") is populated', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[submodule "libs/a"]\n  active = true\n  url = ../a\n  update = rebase\n  ignore = dirty\n',
        );

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.submodule?.get('libs/a')?.url).toBe('../a');
        expect(result.submodule?.get('libs/a')?.active).toBe(true);
        expect(result.submodule?.get('libs/a')?.update).toBe('rebase');
      });
    });
  });

  describe('Given two [submodule "libs/a"] sections carrying different keys', () => {
    describe('When readConfig', () => {
      it('Then the later block accumulates onto the earlier one (url and active both survive)', async () => {
        // Arrange — git merges repeated same-name blocks; keys accumulate.
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[submodule "libs/a"]\n  url = ../a\n[submodule "libs/a"]\n  active = true\n',
        );

        // Act
        const result = await readConfig(ctx);

        // Assert — url from the first block is not clobbered by the second.
        expect(result.submodule?.get('libs/a')?.url).toBe('../a');
        expect(result.submodule?.get('libs/a')?.active).toBe(true);
      });
    });
  });

  describe('Given a config with no submodule section', () => {
    describe('When readConfig', () => {
      it('Then parsed.submodule is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = false\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.submodule).toBeUndefined();
      });
    });
  });

  describe('Given a [merge "custom"] section with name, driver and recursive', () => {
    describe('When readConfig', () => {
      it('Then parsed.merge.get("custom") is populated', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[merge "custom"]\n  name = my driver\n  driver = run %O %A %B\n  recursive = binary\n',
        );

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.merge?.get('custom')?.name).toBe('my driver');
        expect(result.merge?.get('custom')?.driver).toBe('run %O %A %B');
        expect(result.merge?.get('custom')?.recursive).toBe('binary');
      });
    });
  });

  describe('Given two [merge "<name>"] sections', () => {
    describe('When readConfig', () => {
      it('Then each driver is parsed independently', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[merge "a"]\n  driver = tool-a\n[merge "b"]\n  driver = tool-b\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.merge?.get('a')?.driver).toBe('tool-a');
        expect(result.merge?.get('b')?.driver).toBe('tool-b');
      });
    });
  });

  describe('Given two [merge "custom"] sections carrying different keys', () => {
    describe('When readConfig', () => {
      it('Then the later block accumulates onto the earlier one (name and driver both survive)', async () => {
        // Arrange — git merges repeated same-name blocks; keys accumulate.
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[merge "custom"]\n  name = my driver\n[merge "custom"]\n  driver = tool\n',
        );

        // Act
        const result = await readConfig(ctx);

        // Assert — name from the first block is not clobbered by the second.
        expect(result.merge?.get('custom')?.name).toBe('my driver');
        expect(result.merge?.get('custom')?.driver).toBe('tool');
      });
    });
  });

  describe('Given a [merge "custom"] section with only a driver', () => {
    describe('When readConfig', () => {
      it('Then name and recursive are undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[merge "custom"]\n  driver = tool\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.merge?.get('custom')?.driver).toBe('tool');
        expect(result.merge?.get('custom')?.name).toBeUndefined();
        expect(result.merge?.get('custom')?.recursive).toBeUndefined();
      });
    });
  });

  describe('Given a [merge "custom"] section with an unrelated key', () => {
    describe('When readConfig', () => {
      it('Then recursive stays undefined (an unrelated key sets neither name, driver nor recursive)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[merge "custom"]\n  name = drv\n  unrelated = binary\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — the recursive branch must only fire for a `recursive` key.
        expect(result.merge?.get('custom')?.name).toBe('drv');
        expect(result.merge?.get('custom')?.recursive).toBeUndefined();
      });
    });
  });

  describe('Given a subsectionless [merge] section', () => {
    describe('When readConfig', () => {
      it('Then it is ignored', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[merge]\n  driver = tool\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.merge).toBeUndefined();
      });
    });
  });

  describe('Given a config with no merge section', () => {
    describe('When readConfig', () => {
      it('Then parsed.merge is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = false\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.merge).toBeUndefined();
      });
    });
  });

  describe('Given a [diff "upper"] section with textconv', () => {
    describe('When readConfig', () => {
      it('Then parsed.diff.get("upper").textconv is the command string', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[diff "upper"]\n\ttextconv = up\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.diff?.get('upper')?.textconv).toBe('up');
        expect(result.diff?.get('upper')?.cachetextconv).toBeUndefined();
      });
    });
  });

  describe('Given a [diff "upper"] section with an unrelated key', () => {
    describe('When readConfig', () => {
      it('Then cachetextconv stays undefined (an unrelated key is not read as cachetextconv)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[diff "upper"]\n\ttextconv = up\n\tunrelated = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — the cachetextconv branch must only fire for a `cachetextconv` key.
        expect(result.diff?.get('upper')?.textconv).toBe('up');
        expect(result.diff?.get('upper')?.cachetextconv).toBeUndefined();
      });
    });
  });

  describe('Given a [diff "upper"] section with textconv and cachetextconv=true', () => {
    describe('When readConfig', () => {
      it('Then parsed.diff.get("upper") has both textconv and cachetextconv true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[diff "upper"]\n\ttextconv = up\n\tcachetextconv = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.diff?.get('upper')?.textconv).toBe('up');
        expect(result.diff?.get('upper')?.cachetextconv).toBe(true);
      });
    });
  });

  describe('Given a [diff "upper"] section with valueless cachetextconv (git NULL)', () => {
    describe('When readConfig', () => {
      it('Then cachetextconv is true (git NULL boolean-true semantics)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[diff "upper"]\n\ttextconv = up\n\tcachetextconv\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.diff?.get('upper')?.cachetextconv).toBe(true);
      });
    });
  });

  describe('Given two [diff "<name>"] sections', () => {
    describe('When readConfig', () => {
      it('Then each diff driver is parsed independently', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[diff "a"]\n\ttextconv = tool-a\n[diff "b"]\n\ttextconv = tool-b\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.diff?.get('a')?.textconv).toBe('tool-a');
        expect(result.diff?.get('b')?.textconv).toBe('tool-b');
      });
    });
  });

  describe('Given two [diff "upper"] sections carrying different keys', () => {
    describe('When readConfig', () => {
      it('Then the later block accumulates onto the earlier one (textconv and cachetextconv both survive)', async () => {
        // Arrange — git merges repeated same-name blocks; keys accumulate.
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[diff "upper"]\n\ttextconv = up\n[diff "upper"]\n\tcachetextconv = true\n',
        );

        // Act
        const result = await readConfig(ctx);

        // Assert — textconv from the first block is not clobbered by the second.
        expect(result.diff?.get('upper')?.textconv).toBe('up');
        expect(result.diff?.get('upper')?.cachetextconv).toBe(true);
      });
    });
  });

  describe('Given a config with no diff section', () => {
    describe('When readConfig', () => {
      it('Then parsed.diff is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = false\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.diff).toBeUndefined();
      });
    });
  });

  describe('Given a subsectionless [diff] section', () => {
    describe('When readConfig', () => {
      it('Then it is ignored and diff remains undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[diff]\n\ttextconv = up\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.diff).toBeUndefined();
      });
    });
  });

  describe('Given a [filter "myf"] section with clean and smudge', () => {
    describe('When readConfig', () => {
      it('Then parsed.filter.get("myf") has clean and smudge', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[filter "myf"]\n\tclean = up\n\tsmudge = down\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.filter?.get('myf')?.clean).toBe('up');
        expect(result.filter?.get('myf')?.smudge).toBe('down');
        expect(result.filter?.get('myf')?.process).toBeUndefined();
        expect(result.filter?.get('myf')?.required).toBeUndefined();
      });
    });
  });

  describe('Given a [filter "myf"] section with clean only', () => {
    describe('When readConfig', () => {
      it('Then smudge is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[filter "myf"]\n\tclean = up\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.filter?.get('myf')?.clean).toBe('up');
        expect(result.filter?.get('myf')?.smudge).toBeUndefined();
      });
    });
  });

  describe('Given a [filter "myf"] section with an unrelated key', () => {
    describe('When readConfig', () => {
      it('Then process stays undefined (an unrelated key is not read as process)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[filter "myf"]\n\tclean = up\n\tunrelated = pr\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — the process branch must only fire for a `process` key.
        expect(result.filter?.get('myf')?.clean).toBe('up');
        expect(result.filter?.get('myf')?.process).toBeUndefined();
      });
    });
  });

  describe('Given a [filter "f"] section with valueless required (git NULL)', () => {
    describe('When readConfig', () => {
      it('Then required is true (git NULL boolean-true semantics)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[filter "f"]\n\tclean = up\n\trequired\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.filter?.get('f')?.required).toBe(true);
      });
    });
  });

  describe('Given a [filter "f"] section with all four keys', () => {
    describe('When readConfig', () => {
      it('Then all four keys are parsed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[filter "f"]\n\tclean = cl\n\tsmudge = sm\n\tprocess = pr\n\trequired = true\n',
        );

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.filter?.get('f')?.clean).toBe('cl');
        expect(result.filter?.get('f')?.smudge).toBe('sm');
        expect(result.filter?.get('f')?.process).toBe('pr');
        expect(result.filter?.get('f')?.required).toBe(true);
      });
    });
  });

  describe('Given two [filter "<name>"] sections', () => {
    describe('When readConfig', () => {
      it('Then each filter driver is parsed independently', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[filter "a"]\n\tclean = tool-a\n[filter "b"]\n\tsmudge = tool-b\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.filter?.get('a')?.clean).toBe('tool-a');
        expect(result.filter?.get('b')?.smudge).toBe('tool-b');
      });
    });
  });

  describe('Given two [filter "myf"] sections carrying different keys', () => {
    describe('When readConfig', () => {
      it('Then the later block accumulates onto the earlier one (clean and smudge both survive)', async () => {
        // Arrange — git merges repeated same-name blocks; keys accumulate.
        const ctx = createMemoryContext();
        await seed(ctx, '[filter "myf"]\n\tclean = cl\n[filter "myf"]\n\tsmudge = sm\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — clean from the first block is not clobbered by the second.
        expect(result.filter?.get('myf')?.clean).toBe('cl');
        expect(result.filter?.get('myf')?.smudge).toBe('sm');
      });
    });
  });

  describe('Given a config with no filter section', () => {
    describe('When readConfig', () => {
      it('Then parsed.filter is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = false\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.filter).toBeUndefined();
      });
    });
  });

  describe('Given a subsectionless [filter] section', () => {
    describe('When readConfig', () => {
      it('Then it is ignored and filter remains undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[filter]\n\tclean = up\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.filter).toBeUndefined();
      });
    });
  });

  describe('Given a config with # comments and ; comments', () => {
    describe('When readConfig', () => {
      it('Then comments are skipped', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '# top comment\n; another comment\n[core]\n  bare = true # trailing\n  ; another\n',
        );

        // Act
        const result = await readConfig(ctx);

        // Assert — comments do not leak into values; bare is still parsed.
        expect(result.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a config with a malformed line outside any section', () => {
    describe('When readConfig', () => {
      it('Then the line is ignored (lenient parser)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'orphan = value\n[core]\n  bare = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a config with continuation (line ending in backslash)', () => {
    describe('When readConfig', () => {
      it('Then the next line is concatenated with its leading whitespace preserved', async () => {
        // Arrange — Git supports backslash line continuation; the continuation
        // line's leading whitespace is interior to the value and survives.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n  url = https://example.com/\\\n    really-long.git\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('origin')?.url).toBe('https://example.com/    really-long.git');
      });
    });
  });

  describe('Given a config with section names containing dot (e.g. core.subsection)', () => {
    describe('When readConfig', () => {
      it('Then unknown sections are ignored', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[unknown]\n  key = value\n[core]\n  bare = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.bare).toBe(true);
      });
    });
  });

  describe('Given two consecutive readConfig calls', () => {
    describe('When called', () => {
      it('Then second hits cache (fs.readUtf8 invoked once)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');
        const spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        await readConfig(ctx);
        await readConfig(ctx);

        // Assert — only one underlying read.
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a config that was missing on first call', () => {
    describe('When readConfig is called twice', () => {
      it('Then second call also hits cache', async () => {
        // Arrange — even an empty parsed config is cached so we don't re-stat per call.
        const ctx = createMemoryContext();
        const spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        await readConfig(ctx);
        await readConfig(ctx);

        // Assert
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a config with [user] containing whitespace + tabs', () => {
    describe('When readConfig', () => {
      it('Then values are trimmed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n\tname\t=\tBob\t\n\temail\t=\tbob@x.com\t\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.user?.name).toBe('Bob');
        expect(result.user?.email).toBe('bob@x.com');
      });
    });
  });

  describe('Given a [remote] section without subsection (no quotes)', () => {
    describe('When readConfig', () => {
      it('Then it is ignored', async () => {
        // Arrange — `[remote]` without a name is meaningless.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote]\n  url = https://example.com/r.git\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote).toBeUndefined();
      });
    });
  });

  describe('Given two [remote "origin"] sections', () => {
    describe('When readConfig', () => {
      it('Then later url overrides earlier and fetch lines accumulate across sections', async () => {
        // Arrange — accumulator semantics across multiple sections of the same name.
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[remote "origin"]\n  url = https://first.example/r.git\n  fetch = +a:b\n[remote "origin"]\n  url = https://second.example/r.git\n  fetch = +c:d\n',
        );

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('origin')?.url).toBe('https://second.example/r.git');
        expect(result.remote?.get('origin')?.fetch).toEqual(['+a:b', '+c:d']);
      });
    });
  });

  describe('Given two [branch "main"] sections', () => {
    describe('When readConfig', () => {
      it('Then later values win', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[branch "main"]\n  remote = a\n  merge = refs/heads/x\n[branch "main"]\n  remote = b\n  merge = refs/heads/y\n',
        );

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.branch?.get('main')?.remote).toBe('b');
        expect(result.branch?.get('main')?.merge).toBe('refs/heads/y');
      });
    });
  });

  describe('Given a [remote "X"] without url but with fetch', () => {
    describe('When readConfig', () => {
      it('Then the entry is present with only fetch (no url)', async () => {
        // Arrange — accumulator must not synthesize a url when none is given.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "x"]\n  fetch = +a:b\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('x')?.url).toBeUndefined();
        expect(result.remote?.get('x')?.fetch).toEqual(['+a:b']);
      });
    });
  });

  describe('Given a section header without closing bracket', () => {
    describe('When readConfig', () => {
      it('Then it refuses with CONFIG_PARSE_ERROR on line 1 like git', async () => {
        // Arrange — `[core` has no closing `]`; git refuses the whole file
        // (bad config line 1) rather than skipping the malformed header.
        const ctx = createMemoryContext();
        await seed(ctx, '[core\n  bare = true\n[user]\n  name = X\n  email = x@y.com\n');

        // Act + Assert
        try {
          await readConfig(ctx);
          expect.unreachable('readConfig must refuse an unclosed section header');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          if (err.data.code === 'CONFIG_PARSE_ERROR') {
            expect(err.data.line).toBe(1);
            expect(err.data.source).toBe(`${ctx.layout.gitDir}/config`);
          }
        }
      });
    });
  });

  describe('Given an inline comment after a value', () => {
    describe('When readConfig', () => {
      it('Then the comment is stripped from the value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n  url = https://example.com/r.git # trailing\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('origin')?.url).toBe('https://example.com/r.git');
      });
    });
  });

  describe('Given a value containing a quoted `#`', () => {
    describe('When readConfig', () => {
      it('Then the `#` inside the quotes is preserved', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n  url = "https://example.com/r#frag.git"\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('origin')?.url).toContain('#frag');
      });
    });
  });

  describe('Given a cached config and an explicit cache reset on the same context', () => {
    describe('When readConfig is called again', () => {
      it('Then the file is re-read', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');
        const spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        await readConfig(ctx);
        __resetConfigCacheForTests();
        await readConfig(ctx);

        // Assert — reset replaces the WeakMap, so the second call misses the cache.
        expect(spy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given fs.readUtf8 rejects with a non-TsgitError', () => {
    describe('When readConfig', () => {
      it('Then the error is rethrown', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const boom = new Error('disk on fire');
        vi.spyOn(ctx.fs, 'readUtf8').mockRejectedValue(boom);

        // Act
        let caught: unknown;
        try {
          await readConfig(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(boom);
      });
    });
  });

  describe('Given fs.readUtf8 rejects with a TsgitError that is not FILE_NOT_FOUND', () => {
    describe('When readConfig', () => {
      it('Then the error is rethrown', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const denied = new TsgitError({ code: 'PERMISSION_DENIED', path: '/x/config' });
        vi.spyOn(ctx.fs, 'readUtf8').mockRejectedValue(denied);

        // Act
        let caught: unknown;
        try {
          await readConfig(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert — only FILE_NOT_FOUND is swallowed; other codes propagate.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'PERMISSION_DENIED',
          path: '/x/config',
        });
      });
    });
  });

  describe('Given a section header line preceded by leading whitespace', () => {
    describe('When readConfig', () => {
      it('Then the header is recognized after trimming', async () => {
        // Arrange — stripInlineComment(line) must be trimmed before header parsing.
        const ctx = createMemoryContext();
        await seed(ctx, '  [core]\n  bare = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a continuation line with no leading whitespace but internal spaces', () => {
    describe('When readConfig', () => {
      it('Then only leading whitespace would be stripped (internal spaces kept)', async () => {
        // Arrange — continuation join uses /^\s+/, so internal spaces survive.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n  url = ab\\\ncd ef.git\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('origin')?.url).toBe('abcd ef.git');
      });
    });
  });

  describe('Given a config whose final line ends with a backslash continuation', () => {
    describe('When readConfig', () => {
      it('Then the leftover pending content is still flushed', async () => {
        // Arrange — no trailing newline; the last physical line ends with `\`.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\\');

        // Act
        const result = await readConfig(ctx);

        // Assert — pending must be pushed at EOF or `bare` is lost.
        expect(result.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a `;` inline comment after a value', () => {
    describe('When readConfig', () => {
      it('Then the comment is stripped from the value', async () => {
        // Arrange — indexOfUnquoted must search for `;` as well as `#`.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true ; trailing semicolon comment\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a value with both `#` and `;` inline comments', () => {
    describe('When readConfig', () => {
      it('Then the value is cut at the earliest comment marker', async () => {
        // Arrange — `#` appears before `;`; Math.min picks the `#` position.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true # hash ; semi\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — cutting at `;` instead would leave `true # hash` (unparseable → false).
        expect(result.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a header missing `[` but ending with `]`', () => {
    describe('When readConfig', () => {
      it('Then it throws CONFIG_PARSE_ERROR (junk no-`=` line refused)', async () => {
        // Arrange — `.core]` starts with `.` so the valueless-key grammar refuses
        // it; git emits `bad config line 1 in file F` for the same input.
        const ctx = createMemoryContext();
        await seed(ctx, '.core]\n  bare = true\n');

        // Act + Assert
        try {
          await readConfig(ctx);
          expect.unreachable('readConfig must throw on a junk no-`=` line');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 1 });
        }
      });
    });
  });

  describe('Given a header starting with `[` but missing `]`', () => {
    describe('When readConfig', () => {
      it('Then it refuses with CONFIG_PARSE_ERROR on line 1 like git', async () => {
        // Arrange — `[core.` starts with `[` but never closes; git refuses it.
        const ctx = createMemoryContext();
        await seed(ctx, '[core.\n  bare = true\n');

        // Act + Assert
        try {
          await readConfig(ctx);
          expect.unreachable('readConfig must refuse a header missing its `]`');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          if (err.data.code === 'CONFIG_PARSE_ERROR') {
            expect(err.data.line).toBe(1);
          }
        }
      });
    });
  });

  describe('Given a header with neither bracket where one is required', () => {
    describe('When readConfig', () => {
      it('Then it refuses with CONFIG_PARSE_ERROR on line 1 like git', async () => {
        // Arrange — `[core)` has `[` but `)` not `]`, so it never closes; git refuses.
        const ctx = createMemoryContext();
        await seed(ctx, '[core)\n  bare = true\n');

        // Act + Assert
        try {
          await readConfig(ctx);
          expect.unreachable('readConfig must refuse a header with no closing bracket');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          if (err.data.code === 'CONFIG_PARSE_ERROR') {
            expect(err.data.line).toBe(1);
          }
        }
      });
    });
  });

  describe('Given a `[remote "origin]` header with an unterminated subsection quote', () => {
    describe('When readConfig', () => {
      it('Then it throws CONFIG_PARSE_ERROR on the offending line', async () => {
        // Arrange — unclosed quote: git refuses the file with "bad config line N"
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin]\n  url = https://example.com/r.git\n');

        // Act + Assert
        try {
          await readConfig(ctx);
          expect.unreachable('readConfig must throw on an unclosed subsection quote');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 1 });
        }
      });
    });
  });

  describe('Given a `[core "sub"]` section before a plain `[core]`', () => {
    describe('When readConfig', () => {
      it('Then the subsectioned core is ignored', async () => {
        // Arrange — core with a subsection must NOT be treated as `[core]`.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = false\n[core "weird"]\n  bare = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — `[core "weird"]` is ignored, so `bare` stays false.
        expect(result.core?.bare).toBe(false);
      });
    });
  });

  describe('Given a non-branch subsectionless section with branch-like keys', () => {
    describe('When readConfig', () => {
      it('Then it is not parsed as `[branch]`', async () => {
        // Arrange — `[foo]` must not satisfy the `[branch]` branch.
        const ctx = createMemoryContext();
        await seed(ctx, '[foo]\n  remote = origin\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.branch).toBeUndefined();
      });
    });
  });

  describe('Given a `[remote]` section with url and an unrecognized key', () => {
    describe('When readConfig', () => {
      it('Then the unrecognized key is not treated as fetch', async () => {
        // Arrange — only the literal key `fetch` may append to remote.fetch.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "o"]\n  url = u\n  bogus = B\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('o')?.fetch).toBeUndefined();
      });
    });
  });

  describe('Given a `[remote]` section with url and an unrecognized valued key', () => {
    describe('When readConfig', () => {
      it('Then the unrecognized key is not treated as partialCloneFilter', async () => {
        // Arrange — only the literal key `partialclonefilter` may set that field.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "o"]\n  url = u\n  bogus = B\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('o')?.partialCloneFilter).toBeUndefined();
      });
    });
  });

  describe('Given a `[remote]` section with a url but no fetch lines', () => {
    describe('When readConfig', () => {
      it('Then fetch stays absent (not an empty array)', async () => {
        // Arrange — finalize must not synthesize an empty fetch array.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "o"]\n  url = u\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('o')?.fetch).toBeUndefined();
      });
    });
  });

  describe('Given a subsectionless `[remote]` section with pushDefault', () => {
    describe('When readConfig', () => {
      it('Then remotePushDefault is set to the configured remote name', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote]\n  pushDefault = origin\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remotePushDefault).toBe('origin');
      });
    });
  });

  describe('Given a subsectionless `[remote]` section with an unrelated key', () => {
    describe('When readConfig', () => {
      it('Then remotePushDefault stays undefined (only pushDefault is read)', async () => {
        // Arrange — `foo` is not `pushDefault`, so it must never set remotePushDefault.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote]\n  foo = bar\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remotePushDefault).toBeUndefined();
      });
    });
  });

  describe('Given a `[remote "origin"]` subsection with pushDefault', () => {
    describe('When readConfig', () => {
      it('Then remotePushDefault stays undefined (per-remote pushDefault is ignored)', async () => {
        // Arrange — only the subsectionless `[remote]` carries remote.pushDefault.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n  url = u\n  pushDefault = other\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remotePushDefault).toBeUndefined();
      });
    });
  });

  describe('Given two `[branch "main"]` sections each setting a different single key', () => {
    describe('When readConfig', () => {
      it('Then both keys accumulate', async () => {
        // Arrange — the second section must merge onto the first, not replace it.
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "main"]\n  remote = a\n[branch "main"]\n  merge = m\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — `remote` from the first section must survive the second merge.
        expect(result.branch?.get('main')?.remote).toBe('a');
        expect(result.branch?.get('main')?.merge).toBe('m');
      });
    });
  });

  describe('Given a `[branch]` section with remote and an unrecognized key', () => {
    describe('When readConfig', () => {
      it('Then the unrecognized key is not treated as merge', async () => {
        // Arrange — only the literal key `merge` may populate branch.merge.
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "main"]\n  remote = origin\n  bogus = B\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.branch?.get('main')?.merge).toBeUndefined();
      });
    });
  });

  describe('Given a config with no `[core]` section', () => {
    describe('When readConfig', () => {
      it('Then `core` is absent from the result', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n  name = N\n  email = e@x.com\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — `core` key must not be present at all.
        expect('core' in result).toBe(false);
      });
    });
  });

  describe('Given a `[core]` section with only excludesFile', () => {
    describe('When readConfig', () => {
      it('Then `bare` is absent from core', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  excludesfile = /etc/gitignore\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — no `bare` key when bare was never configured.
        expect(result.core?.excludesFile).toBe('/etc/gitignore');
        expect('bare' in (result.core ?? {})).toBe(false);
      });
    });
  });

  describe('Given a `[core]` section with only bare', () => {
    describe('When readConfig', () => {
      it('Then `excludesFile` is absent from core', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — no `excludesFile` key when it was never configured.
        expect(result.core?.bare).toBe(true);
        expect('excludesFile' in (result.core ?? {})).toBe(false);
      });
    });
  });

  describe('Given a `[core]` section with only sshCommand', () => {
    describe('When readConfig', () => {
      it('Then `sshCommand` is set and `bare` is absent from core', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sshCommand = ssh -v\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — sshCommand round-trips verbatim; no `bare` key when unconfigured.
        expect(result.core?.sshCommand).toBe('ssh -v');
        expect('bare' in (result.core ?? {})).toBe(false);
      });
    });
  });

  describe('Given a `[core]` section with a valueless sshCommand key', () => {
    describe('When readConfig', () => {
      it('Then `sshCommand` is absent from core', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sshCommand\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — a valueless key is treated as absent for the string-typed field.
        expect('sshCommand' in (result.core ?? {})).toBe(false);
      });
    });
  });

  describe('Given a config with no `[remote]` section', () => {
    describe('When readConfig', () => {
      it('Then `remote` is absent from the result', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect('remote' in result).toBe(false);
      });
    });
  });

  describe('Given a config with no `[branch]` section', () => {
    describe('When readConfig', () => {
      it('Then `branch` is absent from the result', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect('branch' in result).toBe(false);
      });
    });
  });

  describe('Given a section header with whitespace inside the brackets (`[ core ]`)', () => {
    describe('When readConfig', () => {
      it('Then it refuses with CONFIG_PARSE_ERROR on line 1 like git (no trim-accept)', async () => {
        // Arrange — git's unquoted section grammar is `[A-Za-z0-9.-]+` with no
        // whitespace; `[ core ]` is not trimmed to `core` but refused outright.
        const ctx = createMemoryContext();
        await seed(ctx, '[ core ]\n  bare = true\n');

        // Act + Assert
        try {
          await readConfig(ctx);
          expect.unreachable('readConfig must refuse a whitespace-bearing header');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          if (err.data.code === 'CONFIG_PARSE_ERROR') {
            expect(err.data.line).toBe(1);
            expect(err.data.source).toBe(`${ctx.layout.gitDir}/config`);
          }
        }
      });
    });
  });

  describe('Given a `[foo "bar"]` section (subsectioned, not branch) carrying remote/merge keys', () => {
    describe('When readConfig', () => {
      it('Then it is NOT parsed as `[branch]`', async () => {
        // Arrange — `[foo "bar"]` has a subsection but section name `foo`.
        // Forcing the `sec.section === 'branch'` operand to `true` would make
        // any subsectioned section populate `branch`.
        const ctx = createMemoryContext();
        await seed(ctx, '[foo "bar"]\n  remote = origin\n  merge = refs/heads/x\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — branch must stay absent; the `foo` section is unknown.
        expect(result.branch).toBeUndefined();
      });
    });
  });

  describe('Given a config with a [core] sparseCheckout value', () => {
    describe('When readConfig', () => {
      it.each([
        {
          config: '[core]\n  sparseCheckout = true\n',
          expected: true,
          label: 'parsed.core.sparseCheckout is true',
        },
        {
          config: '[core]\n  sparseCheckout = false\n',
          expected: false,
          label: 'parsed.core.sparseCheckout is false',
        },
        {
          config: '[core]\n  SPARSECHECKOUT = true\n',
          expected: true,
          label: 'the key match is case-insensitive',
        },
        {
          config: '[core]\n  sparseCheckout = yes\n',
          expected: true,
          label: 'parsed.core.sparseCheckout is true (truthy alias)',
        },
      ])('Then $label', async ({ config, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, config);

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.sparseCheckout).toBe(expected);
      });
    });
  });

  describe('Given a config with a [core] sparseCheckoutCone value', () => {
    describe('When readConfig', () => {
      it.each([
        {
          config: '[core]\n  sparseCheckoutCone = true\n',
          expected: true,
          label: 'parsed.core.sparseCheckoutCone is true',
        },
        {
          config: '[core]\n  sparseCheckoutCone = false\n',
          expected: false,
          label: 'parsed.core.sparseCheckoutCone is false',
        },
        {
          config: '[core]\n  SparseCheckoutCone = on\n',
          expected: true,
          label: 'the key match is case-insensitive',
        },
      ])('Then $label', async ({ config, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, config);

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.sparseCheckoutCone).toBe(expected);
      });
    });
  });

  describe('Given only sparseCheckout in [core]', () => {
    describe('When readConfig', () => {
      it('Then core is emitted with just that field', async () => {
        // Arrange — guards the finalizeCore arm for sparseCheckout: it must be the
        // sole key in the emitted object, with no sibling keys synthesized.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sparseCheckout = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core).toEqual({ sparseCheckout: true });
      });
    });
  });

  describe('Given only sparseCheckoutCone in [core]', () => {
    describe('When readConfig', () => {
      it('Then core is emitted with just that field', async () => {
        // Arrange — guards the finalizeCore arm for sparseCheckoutCone in isolation.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sparseCheckoutCone = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core).toEqual({ sparseCheckoutCone: true });
      });
    });
  });

  describe('Given a [core] with bare set but no sparse keys', () => {
    describe('When readConfig', () => {
      it('Then no sparse keys are emitted', async () => {
        // Arrange — the finalizeCore `!== undefined` arms must not synthesize the
        // sparse keys when they were never configured.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — strict shape: only `bare`, neither sparse key present.
        expect(result.core).toStrictEqual({ bare: true });
      });
    });
  });

  describe('Given both sparseCheckout and sparseCheckoutCone set', () => {
    describe('When readConfig', () => {
      it('Then both round-trip independently', async () => {
        // Arrange — sparseCheckout=true, sparseCheckoutCone=false: distinct values
        // prove the two arms parse separate keys, not the same one.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sparseCheckout = true\n  sparseCheckoutCone = false\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core).toEqual({ sparseCheckout: true, sparseCheckoutCone: false });
      });
    });
  });

  describe('Given a config with a [core] compression value', () => {
    describe('When readConfig', () => {
      it.each([
        {
          config: '[core]\n  loosecompression = 9\n',
          expected: 9,
          label: 'parsed.core.looseCompression is 9',
        },
        {
          config: '[core]\n  loosecompression = 1k\n',
          expected: 1024,
          label: 'parsed.core.looseCompression is 1024 (unit multiplier wired)',
        },
        {
          config: '[core]\n  loosecompression = 1\n  compression = 9\n',
          expected: 1,
          label: 'looseCompression is 1 (loosecompression wins when it appears before compression)',
        },
        {
          config: '[core]\n  compression = 9\n  loosecompression = 1\n',
          expected: 1,
          label: 'looseCompression is 1 (loosecompression wins when it appears after compression)',
        },
        {
          config: '[core]\n  compression = 9\n',
          expected: 9,
          label: 'looseCompression is 9 (compression fallback)',
        },
      ])('Then $label', async ({ config, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, config);

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.looseCompression).toBe(expected);
      });
    });
  });

  describe('Given a [core] section with no valid compression value', () => {
    describe('When readConfig', () => {
      it.each([
        {
          config: '[core]\n  bare = true\n',
          label: 'parsed.core.looseCompression is absent (no int compression key)',
        },
        {
          config: '[core]\n\tloosecompression\n',
          label: 'looseCompression is absent and no exception is thrown (valueless)',
        },
        {
          config: '[core]\n  loosecompression = abc\n',
          label: 'looseCompression is absent and no exception is thrown (invalid int, lenient)',
        },
      ])('Then $label', async ({ config }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, config);

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.looseCompression).toBeUndefined();
      });
    });
  });

  describe('Given only loosecompression = 9 in [core]', () => {
    describe('When readConfig', () => {
      it('Then core is emitted with just that field', async () => {
        // Arrange — guards the finalizeCore arm for looseCompression in isolation
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  loosecompression = 9\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core).toEqual({ looseCompression: 9 });
      });
    });
  });

  describe('Given a config with a [core] maxTreeDepth value', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.maxTreeDepth carries the value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\tmaxTreeDepth = 4096\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.maxTreeDepth).toBe(4096);
      });
    });
  });

  describe('Given a [core] section with an invalid maxTreeDepth value', () => {
    describe('When readConfig', () => {
      it.each([
        { config: '[core]\n\tmaxTreeDepth = 2.5\n', label: 'invalid unit (2.5)' },
        {
          config: '[core]\n\tmaxTreeDepth = 2147483648\n',
          label: 'out of range (2147483648 — the C-int narrowing applies here too)',
        },
      ])(
        'Then maxTreeDepth is absent and readConfig does not throw ($label)',
        async ({ config }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, config);

          // Act
          const result = await readConfig(ctx);

          // Assert
          expect(result.core?.maxTreeDepth).toBeUndefined();
        },
      );
    });
  });

  describe('Given a cached config and invalidateConfigCache for that context', () => {
    describe('When readConfig is called again', () => {
      it('Then the file is re-read', async () => {
        // Arrange — the production per-context invalidator drops the stale entry.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');
        const spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        await readConfig(ctx);
        invalidateConfigCache(ctx);
        await readConfig(ctx);

        // Assert — the dropped entry forces a second underlying read.
        expect(spy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given invalidateConfigCache for one context', () => {
    describe('When another context reads', () => {
      it('Then the other context keeps its cache', async () => {
        // Arrange — invalidation is per-context: dropping ctxA must not evict ctxB.
        const ctxA = createMemoryContext();
        const ctxB = createMemoryContext();
        await seed(ctxA, '[core]\n  bare = true\n');
        await seed(ctxB, '[core]\n  bare = true\n');
        const spyB = vi.spyOn(ctxB.fs, 'readUtf8');

        // Act
        await readConfig(ctxA);
        await readConfig(ctxB);
        invalidateConfigCache(ctxA);
        await readConfig(ctxB);

        // Assert — ctxB still served from cache: only one read.
        expect(spyB).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a context never read before', () => {
    describe('When invalidateConfigCache is called', () => {
      it('Then no error is thrown', async () => {
        // Arrange — `cache.delete` of an absent key is a harmless no-op.
        const ctx = createMemoryContext();

        // Assert
        expect(() => invalidateConfigCache(ctx)).not.toThrow();
      });
    });
  });

  describe('Given readConfig has warmed the cache for a config with a valueless [core] path-like', () => {
    describe('When findFirstValuelessEntry runs on the same context', () => {
      it('Then fs.readUtf8 for the config path is invoked once across both', async () => {
        // Arrange — one tokenize/read shared between the parse and the finder.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\texcludesfile\n');
        const spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        await readConfig(ctx);
        const result = await findFirstValuelessEntry(ctx, 'core', undefined, ['excludesfile']);

        // Assert — the finder served the cached tokens, no second read.
        expect(result?.key).toBe('core.excludesfile');
        expect(result?.line).toBe(2);
        expect(result?.source).toBe(`${ctx.layout.gitDir}/config`);
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('Then after invalidateConfigCache the next finder re-reads (spy count 2)', async () => {
        // Arrange — shared invalidation drops both parse and tokens together.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\texcludesfile\n');
        const spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        await readConfig(ctx);
        invalidateConfigCache(ctx);
        await findFirstValuelessEntry(ctx, 'core', undefined, ['excludesfile']);

        // Assert
        expect(spy).toHaveBeenCalledTimes(2);
      });
    });

    describe('When findFirstValuelessEntry runs before readConfig', () => {
      it('Then a finder before readConfig also serves the cache (single read)', async () => {
        // Arrange — the finder warms the same entry readConfig then reuses.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\texcludesfile\n');
        const spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        const found = await findFirstValuelessEntry(ctx, 'core', undefined, ['excludesfile']);
        const parsed = await readConfig(ctx);

        // Assert — one read, and readConfig yields the parse built from those tokens.
        expect(found?.key).toBe('core.excludesfile');
        expect(parsed.core).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given an absent config the cache has warmed', () => {
    describe('When findFirstValuelessEntry runs on the same context', () => {
      it('Then an absent config is served from cache without a second fs hit', async () => {
        // Arrange — the FILE_NOT_FOUND outcome caches tokens: [] for the finder.
        const ctx = createMemoryContext();
        const spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        await readConfig(ctx);
        const result = await findFirstValuelessEntry(ctx, 'core', undefined, ['excludesfile']);

        // Assert
        expect(result).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('partial-clone keys', () => {
    describe('Given an [extensions] partialClone entry', () => {
      describe('When readConfig', () => {
        it('Then extensions.partialClone is set', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[extensions]\n\tpartialClone = origin\n');

          // Act
          const result = await readConfig(ctx);

          // Assert
          expect(result.extensions?.partialClone).toBe('origin');
        });
      });
    });

    describe('Given an [extensions] partialclone key in lower case', () => {
      describe('When readConfig', () => {
        it('Then it is still parsed', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[extensions]\n\tpartialclone = upstream\n');

          // Act
          const result = await readConfig(ctx);

          // Assert
          expect(result.extensions?.partialClone).toBe('upstream');
        });
      });
    });

    describe('Given a config with no matching [extensions] section, When readConfig', () => {
      it.each([
        { config: '[core]\n\tbare = false\n', label: 'no [extensions] section at all' },
        {
          config: '[other]\npartialclone = origin\n',
          label: 'a partialclone key under a non-extensions section',
        },
        {
          config: '[extensions "sub"]\n\tpartialclone = origin\n',
          label: 'an [extensions "sub"] subsection (not treated as [extensions])',
        },
      ])('Then extensions is undefined ($label)', async ({ config }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, config);

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.extensions).toBeUndefined();
      });
    });

    describe('Given a [remote] promisor = true', () => {
      describe('When readConfig', () => {
        it('Then the remote entry is a promisor', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://example.com/r.git\n\tpromisor = true\n',
          );

          // Act
          const result = await readConfig(ctx);

          // Assert
          expect(result.remote?.get('origin')?.promisor).toBe(true);
        });
      });
    });

    describe('Given a [remote] partialclonefilter', () => {
      describe('When readConfig', () => {
        it('Then the stored filter is parsed', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://example.com/r.git\n\tpartialclonefilter = blob:none\n',
          );

          // Act
          const result = await readConfig(ctx);

          // Assert
          expect(result.remote?.get('origin')?.partialCloneFilter).toBe('blob:none');
        });
      });
    });

    describe('Given a [remote] url key in upper case', () => {
      describe('When readConfig', () => {
        it('Then it is still parsed', async () => {
          // Arrange — git config keys are case-insensitive.
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\tURL = https://example.com/r.git\n');

          // Act
          const result = await readConfig(ctx);

          // Assert
          expect(result.remote?.get('origin')?.url).toBe('https://example.com/r.git');
        });
      });
    });

    describe('Given a [remote] with only a url', () => {
      describe('When readConfig', () => {
        it('Then promisor and filter stay undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = https://example.com/r.git\n');

          // Act
          const result = await readConfig(ctx);

          // Assert
          const remote = result.remote?.get('origin');
          expect(remote?.promisor).toBeUndefined();
          expect(remote?.partialCloneFilter).toBeUndefined();
        });
      });
    });

    describe('Given a [remote] pushurl set', () => {
      describe('When readConfig', () => {
        it('Then pushUrl is parsed alongside url', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e.com/r.git\n\tpushurl = git@e.com:r.git\n',
          );

          // Act
          const result = await readConfig(ctx);

          // Assert
          const remote = result.remote?.get('origin');
          expect(remote?.url).toBe('https://e.com/r.git');
          expect(remote?.pushUrl).toBe('git@e.com:r.git');
        });
      });
    });

    describe('Given a [remote] without pushurl', () => {
      describe('When readConfig', () => {
        it('Then pushUrl stays undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = https://e.com/r.git\n');

          // Act
          const result = await readConfig(ctx);

          // Assert
          expect(result.remote?.get('origin')?.pushUrl).toBeUndefined();
        });
      });
    });

    describe('Given a [remote] PUSHURL upper-cased', () => {
      describe('When readConfig', () => {
        it('Then it is parsed (case-insensitive key)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\tPUSHURL = git@e.com:r.git\n');

          // Act
          const result = await readConfig(ctx);

          // Assert
          expect(result.remote?.get('origin')?.pushUrl).toBe('git@e.com:r.git');
        });
      });
    });

    describe('Given a [remote] section with an unrecognised key', () => {
      describe('When readConfig', () => {
        it('Then partialCloneFilter stays undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e/r.git\n\tpushurl = https://e/p.git\n',
          );

          // Act
          const result = await readConfig(ctx);

          // Assert — only the `partialclonefilter` key sets the field.
          expect(result.remote?.get('origin')?.partialCloneFilter).toBeUndefined();
        });
      });
    });

    describe('Given an [extensions] section with a non-partialclone key', () => {
      describe('When readConfig', () => {
        it('Then partialClone stays undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[extensions]\nname = enabled\n');

          // Act
          const result = await readConfig(ctx);

          // Assert — only the `partialclone` key populates extensions.
          expect(result.extensions?.partialClone).toBeUndefined();
        });
      });
    });
  });
});

describe('primitives/config-read parseIniSections', () => {
  describe('Given INI text with a subsection, comment, and continuation', () => {
    describe('When parseIniSections', () => {
      it('Then sections carry section/subsection/entries', () => {
        // Arrange
        const text =
          '[core]\n\tbare = true\n# a comment\n[remote "origin"]\n\turl = https://e\\\n/r.git\n';

        // Act
        const result: ReadonlyArray<IniSection> = parseIniSections(text);

        // Assert
        expect(result).toEqual([
          { section: 'core', subsection: undefined, entries: [{ key: 'bare', value: 'true' }] },
          {
            section: 'remote',
            subsection: 'origin',
            entries: [{ key: 'url', value: 'https://e/r.git' }],
          },
        ]);
      });
    });
  });

  describe('Given empty text', () => {
    describe('When parseIniSections', () => {
      it('Then returns no sections', () => {
        // Arrange
        const text = '';

        // Act
        const result = parseIniSections(text);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });
});

describe('primitives/config-read value grammar', () => {
  const configTextFor = (raw: string): string => `[test]\n\tv = ${raw}\n`;

  const firstValue = (sections: ReadonlyArray<IniSection>): string | null | undefined =>
    sections[0]?.entries[0]?.value;

  describe('Given a quoted or quote-toggled value, When parseIniSections', () => {
    it.each([
      ['"a b"', 'a b'],
      ['a" b "c', 'a b c'],
      ['""', ''],
      ['"a "', 'a '],
      ['"a # c"', 'a # c'],
      ['"a ; c"', 'a ; c'],
    ])('Then %j parses to %j (quotes stripped, spans concatenated)', (raw, expected) => {
      // Arrange
      const text = configTextFor(raw);

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(firstValue(result)).toBe(expected);
    });
  });

  describe('Given escape sequences inside and outside quotes, When parseIniSections', () => {
    it.each([
      ['a\\nb', 'a\nb'],
      ['a\\tb', 'a\tb'],
      ['a\\bb', 'a\bb'],
      ['a\\"b', 'a"b'],
      ['a\\\\b', 'a\\b'],
      ['"a\\nb"', 'a\nb'],
      ['"a\\tb"', 'a\tb'],
      ['"a\\\\b"', 'a\\b'],
    ])('Then %j decodes to %j', (raw, expected) => {
      // Arrange
      const text = configTextFor(raw);

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(firstValue(result)).toBe(expected);
    });
  });

  describe('Given whitespace around and inside the value, When parseIniSections', () => {
    it.each([
      ['   a', 'a'],
      ['a   ', 'a'],
      ['a   b', 'a   b'],
      ['a\tb', 'a\tb'],
      ['a\r', 'a'],
      ['\ra', 'a'],
      ['a\rb', 'a\rb'],
      ['"a\r"', 'a\r'],
      ['\x0ba', '\x0ba'],
      ['a\x0b', 'a\x0b'],
      ['a\x0c', 'a\x0c'],
    ])('Then %j parses to %j (GIT_SPACE trim: space/tab/CR only)', (raw, expected) => {
      // Arrange
      const text = configTextFor(raw);

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(firstValue(result)).toBe(expected);
    });

    it('Then a quote toggle resets the trailing-whitespace trim', () => {
      // Arrange
      const text = configTextFor('a ""');

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(firstValue(result)).toBe('a ');
    });

    it('Then an escape append resets the trailing-whitespace trim', () => {
      // Arrange
      const text = configTextFor('a \\t');

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(firstValue(result)).toBe('a \t');
    });
  });

  describe('Given backslash continuations, When parseIniSections', () => {
    it('Then the continuation line leading whitespace is preserved as interior', () => {
      // Arrange
      const text = '[test]\n\tv = a\\\n   b\n';

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(result[0]?.entries).toEqual([{ key: 'v', value: 'a   b' }]);
    });

    it('Then an escaped backslash at end of line is not a continuation', () => {
      // Arrange
      const text = '[test]\n\tv = a\\\\\n\tw = c\n';

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(result[0]?.entries).toEqual([
        { key: 'v', value: 'a\\' },
        { key: 'w', value: 'c' },
      ]);
    });

    it('Then a continuation inside a quote span carries the quote state across lines', () => {
      // Arrange
      const text = '[test]\n\tv = "a\\\nb"\n';

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(result[0]?.entries).toEqual([{ key: 'v', value: 'ab' }]);
    });

    it('Then a continuation on the final line ends the value without error', () => {
      // Arrange — git fakes an end-of-line at EOF.
      const text = '[test]\n\tv = a\\';

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(result[0]?.entries).toEqual([{ key: 'v', value: 'a' }]);
    });

    it('Then a section header after a continued value is still recognized', () => {
      // Arrange
      const text = '[test]\n\tv = a\\\nb\n[next]\n\tw = c\n';

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(result).toEqual([
        { section: 'test', subsection: undefined, entries: [{ key: 'v', value: 'ab' }] },
        { section: 'next', subsection: undefined, entries: [{ key: 'w', value: 'c' }] },
      ]);
    });
  });

  describe('Given comment characters, When parseIniSections', () => {
    it('Then an unquoted hash starts a comment and trailing whitespace is trimmed', () => {
      // Arrange
      const text = configTextFor('a # c');

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(firstValue(result)).toBe('a');
    });

    it.each([
      ['hash', '[test]\n\tab#cd = x\n\tv = ok\n'],
      ['semicolon', '[test]\n\tab;cd = x\n\tv = ok\n'],
    ])('Then a %s comment before the equals sign causes CONFIG_PARSE_ERROR', (_label, text) => {
      // Arrange + Act + Assert — the comment swallows the `=`, landing the line on the
      // valueless-key path; `ab#cd` / `ab;cd` fail the key grammar → git refuses.
      try {
        parseIniSections(text, 'test.cfg');
        expect.unreachable('parseIniSections must throw when comment swallows =');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
      }
    });

    it('Then a line with a semicolon before = and a hash after = causes CONFIG_PARSE_ERROR', () => {
      // Arrange — the `;` before `=` swallows the `=`; `a;b` fails the key
      // grammar (semicolon is not alnum/dash) → git refuses the file.
      const text = '[test]\n\ta;b = x # y\n\tv = ok\n';

      // Act + Assert
      try {
        parseIniSections(text, 'test.cfg');
        expect.unreachable('parseIniSections must throw on comment-swallowed = line');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
      }
    });

    it('Then an unindented comment-swallowed line causes CONFIG_PARSE_ERROR', () => {
      // Arrange — without indentation the key starts at column 0; the `;` still
      // fails the grammar and git refuses the file with `bad config line N`.
      const text = '[test]\na;b = x # y\nv = ok\n';

      // Act + Assert
      try {
        parseIniSections(text, 'test.cfg');
        expect.unreachable('parseIniSections must throw on unindented comment-swallowed line');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
      }
    });
  });

  describe('Given section headers carrying comments and quoted names, When parseIniSections', () => {
    it.each([
      ['hash-then-semicolon', '[test] # c ; d\n\tv = ok\n'],
      ['semicolon-then-hash', '[test] ; c # d\n\tv = ok\n'],
    ])('Then a %s trailing comment is cut at the earliest marker', (_label, text) => {
      // Arrange & Act
      const result = parseIniSections(text);

      // Assert
      expect(result).toEqual([
        { section: 'test', subsection: undefined, entries: [{ key: 'v', value: 'ok' }] },
      ]);
    });

    it('Then a comment after a closed quoted subsection is still cut', () => {
      // Arrange — the quote span must CLOSE at its second `"` so the later
      // `#` is unquoted again and the trailing comment is stripped.
      const text = '[branch "a"] # c\n\tv = ok\n';

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(result).toEqual([
        { section: 'branch', subsection: 'a', entries: [{ key: 'v', value: 'ok' }] },
      ]);
    });

    it('Then a hash inside a quoted subsection is not a comment', () => {
      // Arrange
      const text = '[branch "a#b"]\n\tv = ok\n';

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(result).toEqual([
        { section: 'branch', subsection: 'a#b', entries: [{ key: 'v', value: 'ok' }] },
      ]);
    });

    it('Then a backslash-escaped quote inside a quoted subsection is decoded and does not close the span', () => {
      // Arrange — `\"` decodes to `"` (not verbatim `\"`); the `#` after it stays
      // inside the span and becomes part of the subsection name, not a comment.
      const text = '[branch "a\\"#b"]\n\tv = ok\n';

      // Act
      const result = parseIniSections(text);

      // Assert
      expect(result).toEqual([
        { section: 'branch', subsection: 'a"#b', entries: [{ key: 'v', value: 'ok' }] },
      ]);
    });
  });

  describe('Given a quoted subsection with escape sequences, When parseIniSections', () => {
    it.each([
      {
        text: '[s "a\\"b"]\n\tk = v\n',
        subsection: 'a"b',
        label: '`\\"` in the subsection is decoded to `"`',
      },
      {
        text: '[s "a\\\\b"]\n\tk = v\n',
        subsection: 'a\\b',
        label: '`\\\\` in the subsection is decoded to `\\`',
      },
      {
        text: '[s "a\\tb"]\n\tk = v\n',
        subsection: 'atb',
        label: '`\\t` (backslash + letter t) is decoded to `t` — no named escapes',
      },
      {
        text: '[s "a]b"]\n\tk = v\n',
        subsection: 'a]b',
        label: 'a literal `]` inside the quoted subsection is content, not the header close',
      },
      {
        text: '[s "a#b"]\n\tk = v\n',
        subsection: 'a#b',
        label: '`#` inside the quoted subsection is content, not a comment',
      },
      {
        text: '[s "a;b"]\n\tk = v\n',
        subsection: 'a;b',
        label: '`;` inside the quoted subsection is content, not a comment',
      },
      {
        text: '[s "a\rb"]\n\tk = v\n',
        subsection: 'a\rb',
        label: 'a raw CR inside the quoted subsection is content',
      },
      {
        text: '[s\t"a"]\n\tk = v\n',
        subsection: 'a',
        label: 'a TAB between the section name and the opening quote is accepted (GIT_SPACE)',
      },
      {
        text: '[s "a"] # trailing comment\n\tk = v\n',
        subsection: 'a',
        label: 'a trailing comment after the closing `]` is stripped',
      },
      {
        text: '[s ""]\n\tk = v\n',
        subsection: '',
        label: 'an empty quoted subsection `""` yields an empty string (not undefined)',
      },
    ])('Then $label', ({ text, subsection }) => {
      // Arrange & Act
      const result = parseIniSections(text);

      // Assert
      expect(result).toEqual([{ section: 's', subsection, entries: [{ key: 'k', value: 'v' }] }]);
    });
  });

  describe('Given a malformed quoted subsection header, When parseIniSections', () => {
    it.each([
      {
        text: '[s "a" x]\n\tk = v\n',
        expectedData: { line: 1, source: 'test-source', partialSectionName: 's.a' },
        label:
          '`[s "a" x]` — junk after the closing quote — throws CONFIG_PARSE_ERROR with partial `s.a`',
      },
      {
        text: '[s "a" ]\n\tk = v\n',
        expectedData: { line: 1, source: 'test-source', partialSectionName: 's.a' },
        label:
          '`[s "a" ]` — space before closing `]` — throws CONFIG_PARSE_ERROR with partial `s.a`',
      },
      {
        text: '[s"a"]\n\tk = v\n',
        expectedData: { line: 1, source: 'test-source', partialSectionName: 's' },
        label: '`[s"a"]` — no space before the quote — throws CONFIG_PARSE_ERROR with partial `s`',
      },
      {
        text: '["a"]\n\tk = v\n',
        expectedData: { line: 1, source: 'test-source', partialSectionName: '' },
        label:
          '`["a"]` — no section, quote directly after `[` — throws CONFIG_PARSE_ERROR with partial `"` empty',
      },
      {
        text: '[s "a]\n\tk = v\n',
        expectedData: { line: 1, source: 'test-source', partialSectionName: 's.a]' },
        label: '`[s "a]` — unclosed quote — throws CONFIG_PARSE_ERROR with partial `s.a]`',
      },
      {
        text: '[s "a\\"b]\n\tk = v\n',
        expectedData: { line: 1, source: 'test-source', partialSectionName: 's.a"b]' },
        label:
          '`[s "a\\"b]` — escaped quote then unclosed — throws CONFIG_PARSE_ERROR with partial `s.a"b]`',
      },
      {
        text: '[s "ab\\\n\tk = v\n',
        expectedData: { line: 1, source: 'test-source', partialSectionName: 's.ab' },
        label:
          '`[s "ab\\` — dangling backslash at end of line — throws CONFIG_PARSE_ERROR with partial `s.ab`',
      },
      {
        text: '[S "a" x]\n\tk = v\n',
        expectedData: { line: 1, source: 'test-source', partialSectionName: 's.a' },
        label: '`[S "a" x]` — uppercase section — throws with partial `s.a` (section lowercased)',
      },
      {
        text: '[a]\n\tk = v\n[s "bad" x]\n\tw = ok\n',
        expectedData: { line: 3 },
        label: 'a malformed header on line 3 of a multi-line file reports `line: 3`',
      },
    ])('Then $label', ({ text, expectedData }) => {
      // Arrange + Act + Assert
      try {
        parseIniSections(text, 'test-source');
        expect.unreachable('parseIniSections must throw on a malformed quoted subsection header');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject(expectedData);
      }
    });
  });

  describe('Given a malformed value, When parseIniSections', () => {
    it.each([
      {
        text: '[test]\n\tv = a\\xb\n',
        line: 2,
        label: 'an unknown escape throws CONFIG_PARSE_ERROR with the physical line',
      },
      {
        text: '[a]\nk = ok\n[test]\nv = "good"\nw = "bad\n',
        line: 5,
        label: 'an unclosed quote throws CONFIG_PARSE_ERROR with the physical line',
      },
      {
        text: '[test]\n\tv = a\\\nb\\q\n',
        line: 3,
        label: 'a failure on a continuation line reports the continuation physical line',
      },
    ])('Then $label', ({ text, line }) => {
      // Arrange + Act + Assert
      try {
        parseIniSections(text);
        expect.unreachable('parseIniSections must throw on a malformed value');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line });
      }
    });

    it('Then the source label is carried when provided', () => {
      // Arrange
      const text = '[test]\n\tv = "bad\n';

      // Act + Assert
      try {
        parseIniSections(text, 'some/config');
        expect.unreachable('parseIniSections must throw on an unclosed quote');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data).toMatchObject({ code: 'CONFIG_PARSE_ERROR', source: 'some/config' });
      }
    });

    it('Then the source label is absent when not provided', () => {
      // Arrange
      const text = '[test]\n\tv = "bad\n';

      // Act + Assert
      try {
        parseIniSections(text);
        expect.unreachable('parseIniSections must throw on an unclosed quote');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(Object.hasOwn(err.data, 'source')).toBe(false);
      }
    });
  });

  describe('Given a malformed .git/config, When readConfig', () => {
    beforeEach(() => {
      __resetConfigCacheForTests();
    });

    it('Then it rejects with CONFIG_PARSE_ERROR carrying the config path as source', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[core]\n\tbare = a\\x\n');

      // Act + Assert
      try {
        await readConfig(ctx);
        expect.unreachable('readConfig must reject on a malformed config');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data).toMatchObject({
          code: 'CONFIG_PARSE_ERROR',
          line: 2,
          source: `${ctx.layout.gitDir}/config`,
        });
      }
    });

    it('Then the rejection is cached (single underlying read)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[core]\n\tbare = "open\n');
      const spy = vi.spyOn(ctx.fs, 'readUtf8');

      // Act
      const first = readConfig(ctx).catch((err: unknown) => err);
      const second = readConfig(ctx).catch((err: unknown) => err);
      const [a, b] = await Promise.all([first, second]);

      // Assert — both rejections come from one read.
      expect((a as TsgitError).data.code).toBe('CONFIG_PARSE_ERROR');
      expect((b as TsgitError).data.code).toBe('CONFIG_PARSE_ERROR');
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Given a malformed local config, When getConfigValue reads scoped sections', () => {
    beforeEach(() => {
      __resetConfigCacheForTests();
      __resetSectionsCacheForTests();
    });

    it('Then the CONFIG_PARSE_ERROR propagates (not swallowed as a missing scope)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = "open\n');

      // Act + Assert
      try {
        await getConfigValue({ ctx, key: 'user.name' });
        expect.unreachable('getConfigValue must reject on a malformed config');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
      }
    });
  });
});

describe('readConfigSections / getConfigValue / getAllConfigValues', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  describe('Given a local config with one [user] section, When readConfigSections runs for scope local', () => {
    it('Then returns one tagged section', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = ada\n');

      // Act
      const result = await readConfigSections({ ctx, scope: 'local' });

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]?.scope).toBe('local');
      expect(result[0]?.section.section).toBe('user');
    });
  });

  describe('Given an absent local config, When readConfigSections runs for scope local', () => {
    it('Then returns an empty array (missing file is not an error)', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      const result = await readConfigSections({ ctx, scope: 'local' });

      // Assert
      expect(result).toEqual([]);
    });
  });

  describe('Given two consecutive readConfigSections calls for the same scope, When the second runs', () => {
    it('Then fs.readUtf8 is called exactly once (cache hit)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = ada\n');
      const spy = vi.spyOn(ctx.fs, 'readUtf8');

      // Act
      await readConfigSections({ ctx, scope: 'local' });
      await readConfigSections({ ctx, scope: 'local' });

      // Assert
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Given a scoped-cache invalidation between two calls, When the second readConfigSections runs', () => {
    it('Then fs.readUtf8 is called twice (cache miss after invalidate)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = ada\n');
      const spy = vi.spyOn(ctx.fs, 'readUtf8');

      // Act
      await readConfigSections({ ctx, scope: 'local' });
      invalidateScopedConfigCache(ctx);
      await readConfigSections({ ctx, scope: 'local' });

      // Assert
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('Given getConfigValue with the key present once, When called', () => {
    it('Then returns { key, value, scope: local }', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = ada\n');

      // Act
      const result = await getConfigValue({ ctx, key: 'user.name', scope: 'local' });

      // Assert
      expect(result).toEqual({ key: 'user.name', value: 'ada', scope: 'local' });
    });
  });

  describe('Given getConfigValue with the key absent, When called', () => {
    it('Then returns { key, value: undefined } (no scope)', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      const result = await getConfigValue({ ctx, key: 'user.name', scope: 'local' });

      // Assert
      expect(result).toEqual({ key: 'user.name', value: undefined });
    });
  });

  describe('Given getConfigValue with the key appearing twice in local, When called', () => {
    it('Then throws CONFIG_MULTIPLE_VALUES with requested=read, count=2, scope=local', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = ada\n\tname = bob\n');
      let caught: TsgitError | undefined;

      // Act
      try {
        await getConfigValue({ ctx, key: 'user.name', scope: 'local' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'CONFIG_MULTIPLE_VALUES',
        key: 'user.name',
        count: 2,
        requested: 'read',
        scope: 'local',
      });
    });
  });

  describe('Given getAllConfigValues for a multi-valued key, When called', () => {
    it('Then returns all values in physical order tagged with their scope', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(
        ctx,
        '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\tfetch = +refs/tags/*:refs/tags/*\n',
      );

      // Act
      const result = await getAllConfigValues({
        ctx,
        key: 'remote.origin.fetch',
        scope: 'local',
      });

      // Assert
      expect(result.values).toEqual([
        { value: '+refs/heads/*:refs/remotes/origin/*', scope: 'local' },
        { value: '+refs/tags/*:refs/tags/*', scope: 'local' },
      ]);
    });
  });

  describe('Given getAllConfigValues for an absent key, When called', () => {
    it('Then returns { key, values: [] }', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      const result = await getAllConfigValues({ ctx, key: 'user.email', scope: 'local' });

      // Assert
      expect(result).toEqual({ key: 'user.email', values: [] });
    });
  });

  describe('Given a valueless key, When getConfigValue', () => {
    it('Then returns { key, value: null, scope } (distinct from absent → value: undefined)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[core]\nbare\n');

      // Act
      const result = await getConfigValue({ ctx, key: 'core.bare', scope: 'local' });

      // Assert
      expect(result).toEqual({ key: 'core.bare', value: null, scope: 'local' });
    });
  });

  describe('Given an absent key, When getConfigValue', () => {
    it('Then returns { key, value: undefined } (distinct from valueless → value: null)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[core]\n');

      // Act
      const result = await getConfigValue({ ctx, key: 'core.bare', scope: 'local' });

      // Assert
      expect(result).toEqual({ key: 'core.bare', value: undefined });
    });
  });

  describe('Given a key with one valued and one valueless occurrence, When getAllConfigValues', () => {
    it('Then values array carries null in physical file order', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(
        ctx,
        '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\tfetch\n',
      );

      // Act
      const result = await getAllConfigValues({
        ctx,
        key: 'remote.origin.fetch',
        scope: 'local',
      });

      // Assert
      expect(result.values).toEqual([
        { value: '+refs/heads/*:refs/remotes/origin/*', scope: 'local' },
        { value: null, scope: 'local' },
      ]);
    });
  });

  describe('Given a populated scoped cache, When __resetSectionsCacheForTests runs between two reads', () => {
    it('Then the cache is cleared so fs.readUtf8 is called again', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = ada\n');
      const spy = vi.spyOn(ctx.fs, 'readUtf8');

      // Act
      await readConfigSections({ ctx, scope: 'local' });
      __resetSectionsCacheForTests();
      await readConfigSections({ ctx, scope: 'local' });

      // Assert
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('Given fs.readUtf8 rejects with a TsgitError that is neither FILE_NOT_FOUND nor PERMISSION_DENIED, When readConfigSections reads a single scope', () => {
    it('Then the error propagates (only missing or denied scopes are swallowed as empty)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const boom = new TsgitError({ code: 'NOT_A_DIRECTORY', path: '/repo/.git/config' });
      vi.spyOn(ctx.fs, 'readUtf8').mockRejectedValue(boom);
      let caught: TsgitError | undefined;

      // Act
      try {
        await readConfigSections({ ctx, scope: 'local' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({ code: 'NOT_A_DIRECTORY', path: '/repo/.git/config' });
    });
  });

  describe('Given a memory adapter whose system config path is unresolved, When readConfigSections merges every scope', () => {
    it('Then the system scope is silently skipped and the available scopes still surface', async () => {
      // Arrange — an empty system path makes resolveScopePath raise CONFIG_SYSTEM_PATH_UNRESOLVED.
      const ctx = createMemoryContext({ systemConfig: '' });
      await seed(ctx, '[user]\n\tname = ada\n');

      // Act
      const result = await readConfigSections({ ctx });

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]?.scope).toBe('local');
      expect(result[0]?.section.section).toBe('user');
    });
  });

  describe('Given a key present only in local, When getConfigValue reads an explicit empty scope', () => {
    it('Then only that scope is consulted (absent), never a merge that would surface the local value', async () => {
      // Arrange — user.name lives in local; the global scope is empty on the memory adapter.
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = ada\n');

      // Act
      const result = await getConfigValue({ ctx, key: 'user.name', scope: 'global' });

      // Assert
      expect(result).toEqual({ key: 'user.name', value: undefined });
    });
  });
});

describe('primitives/config-read valueless keys', () => {
  describe('parseIniSections — valueless entry tokenisation', () => {
    describe('Given [a]\\n\\tkey\\n, When parseIniSections', () => {
      it('Then one entry with key and value null', () => {
        // Arrange & Act
        const result = parseIniSections('[a]\n\tkey\n');

        // Assert
        expect(result).toEqual([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: null }] },
        ]);
      });
    });

    describe('Given a valueless key with trailing or leading whitespace variations, When parseIniSections', () => {
      it.each([
        { input: '[a]\n\tkey   \n', key: 'key', label: 'value is null (trailing spaces accepted)' },
        { input: '[a]\n\tkey\t\n', key: 'key', label: 'value is null (trailing tab accepted)' },
        { input: '[a]\n\tkey\r\n', key: 'key', label: 'value is null (CR at EOL accepted)' },
        {
          input: '[a]\n   key\n',
          key: 'key',
          label: 'value is null (leading whitespace accepted)',
        },
        {
          input: '[a]\n\tWith-CAPS\n',
          key: 'With-CAPS',
          label: 'key case is preserved and value is null',
        },
        { input: '[a]\nkey', key: 'key', label: 'value is null (no trailing newline accepted)' },
      ])('Then $label', ({ input, key }) => {
        // Arrange & Act
        const result = parseIniSections(input);

        // Assert
        expect(result[0]?.entries).toEqual([{ key, value: null }]);
      });
    });
  });

  describe('parseIniSections — refusal matrix', () => {
    describe('Given a key line that violates the key grammar, When parseIniSections', () => {
      it.each([
        { text: '[a]\nkey ; c\n', label: 'inline semicolon comment (key ; c)' },
        { text: '[a]\nkey # c\n', label: 'inline hash comment (key # c)' },
        { text: '[a]\nbad!key\n', label: 'exclamation (bad!key)' },
        { text: '[a]\n9key\n', label: 'digit-first key (9key)' },
        { text: '[a]\n-key\n', label: 'dash-first key (-key)' },
        { text: '[a]\nunder_score\n', label: 'underscore (under_score)' },
        { text: '[a]\nkey\r \n', label: 'lone CR before trailing space (key\\r )' },
        { text: '[a]\n\tab#cd = x\n', label: 'a comment swallowing the = (ab#cd = x)' },
      ])('Then throws CONFIG_PARSE_ERROR with line 2 and the source ($label)', ({ text }) => {
        // Arrange + Act + Assert
        try {
          parseIniSections(text, 'test.cfg');
          expect.unreachable('must throw on a key that violates the grammar');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
        }
      });
    });
  });

  describe('parseIniSections — leniency preserved', () => {
    describe('Given a valid valueless key before any section (orphan), When parseIniSections', () => {
      it('Then the orphan records under the empty section ahead of the named section', () => {
        // Arrange & Act
        const result = parseIniSections('key\n[a]\n\tv = ok\n');

        // Assert
        expect(result).toEqual([
          { section: '', subsection: undefined, entries: [{ key: 'key', value: null }] },
          { section: 'a', subsection: undefined, entries: [{ key: 'v', value: 'ok' }] },
        ]);
      });
    });

    describe('Given `[a] key` on a header line followed by a body entry, When parseIniSections', () => {
      it('Then the header opens a section and the same-line valueless key joins the body entry', () => {
        // Arrange + Act — `[a] key` is a header `[a]` plus a same-line valueless entry;
        // the following `v = ok` lands in the same re-opened section.
        const result = parseIniSections('[a]\n[a] key\n\tv = ok\n');

        // Assert — first `[a]` is empty; the second carries the same-line key and `v`.
        expect(result).toEqual([
          { section: 'a', subsection: undefined, entries: [] },
          {
            section: 'a',
            subsection: undefined,
            entries: [
              { key: 'key', value: null },
              { key: 'v', value: 'ok' },
            ],
          },
        ]);
      });
    });

    describe('Given a full-line comment, When parseIniSections', () => {
      it('Then skipped and no throw', () => {
        // Arrange & Act
        const result = parseIniSections('[a]\n# comment\n\tv = ok\n');

        // Assert
        expect(result).toEqual([
          { section: 'a', subsection: undefined, entries: [{ key: 'v', value: 'ok' }] },
        ]);
      });
    });

    describe('Given a blank line, When parseIniSections', () => {
      it('Then skipped and no throw', () => {
        // Arrange & Act
        const result = parseIniSections('[a]\n\n\tv = ok\n');

        // Assert
        expect(result).toEqual([
          { section: 'a', subsection: undefined, entries: [{ key: 'v', value: 'ok' }] },
        ]);
      });
    });
  });

  describe('readConfig — bool semantics via valueless keys', () => {
    beforeEach(() => {
      __resetConfigCacheForTests();
    });

    describe('Given [core]\\nbare (valueless), When readConfig', () => {
      it('Then core.bare is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\nbare\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.bare).toBe(true);
      });
    });

    describe('Given [core]\\nsparsecheckout (valueless), When readConfig', () => {
      it('Then core.sparseCheckout is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\nsparsecheckout\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.sparseCheckout).toBe(true);
      });
    });

    describe('Given [core]\\nlogallrefupdates (valueless), When readConfig', () => {
      it('Then core.logAllRefUpdates is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\nlogallrefupdates\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.logAllRefUpdates).toBe(true);
      });
    });

    describe('Given [core]\\nbare = (empty value), When readConfig', () => {
      it('Then core.bare is false (empty string is falsy)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\nbare =\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.bare).toBe(false);
      });
    });
  });

  describe('readConfig — string-typed fields skip valueless entries', () => {
    beforeEach(() => {
      __resetConfigCacheForTests();
    });

    describe('Given [user]\\nname\\nemail = e, When readConfig', () => {
      it('Then user is undefined (valueless name skipped, pair incomplete)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\nname\nemail = e\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.user).toBeUndefined();
      });
    });

    describe('Given [remote "o"]\\nurl\\nfetch (both valueless), When readConfig', () => {
      it('Then remote o has no url and no fetch entries', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "o"]\nurl\nfetch\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        const remote = result.remote?.get('o');
        expect(remote?.url).toBeUndefined();
        expect(remote?.fetch).toBeUndefined();
      });
    });

    describe('Given [merge "d"]\\ndriver (valueless), When readConfig', () => {
      it('Then merge driver d has no driver field (valueless string skipped)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[merge "d"]\ndriver\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — the section is present but driver (string field) skips null
        expect(result.merge?.get('d')?.driver).toBeUndefined();
      });
    });

    describe('Given [submodule "s"]\\nactive (valueless bool), When readConfig', () => {
      it('Then submodule s has active true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[submodule "s"]\nactive\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.submodule?.get('s')?.active).toBe(true);
      });
    });

    describe('Given [remote "o"]\\npromisor (valueless bool), When readConfig', () => {
      it('Then remote o has promisor true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "o"]\nurl = u\npromisor\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('o')?.promisor).toBe(true);
      });
    });

    describe('Given [branch "b"]\\nremote\\nmerge (both valueless), When readConfig', () => {
      it('Then branch b has neither remote nor merge (valueless strings skipped)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "b"]\nremote\nmerge\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — the section is present but both string fields skip null
        expect(result.branch?.get('b')?.remote).toBeUndefined();
        expect(result.branch?.get('b')?.merge).toBeUndefined();
      });
    });
  });
});

describe('primitives/config-read tokenizeConfig', () => {
  describe('Given a simple section with one entry, When tokenizeConfig', () => {
    it('Then returns a header token followed by an entry token with correct span', () => {
      // Arrange & Act
      const result = tokenizeConfig('[a]\n\tkey = v\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'key', value: 'v', startLine: 1, endLine: 2 },
      ]);
    });
  });

  describe('Given a backslash continuation, When tokenizeConfig', () => {
    it('Then the entry spans both physical lines with the joined value', () => {
      // Arrange & Act
      const result = tokenizeConfig('[a]\n\tkey = one\\\n   two\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'key', value: 'one   two', startLine: 1, endLine: 3 },
      ]);
    });
  });

  describe('Given chained backslash continuations, When tokenizeConfig', () => {
    it('Then the entry spans all physical lines with endLine equal to the last continuation plus one', () => {
      // Arrange & Act
      const result = tokenizeConfig('[a]\n\tkey = one\\\n   two\\\n   three\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'key', value: 'one   two   three', startLine: 1, endLine: 4 },
      ]);
    });
  });

  describe('Given a quoted continuation, When tokenizeConfig', () => {
    it('Then the entry spans both physical lines with the concatenated quoted value', () => {
      // Arrange & Act
      const result = tokenizeConfig('[a]\n\tkey = "one\\\n   two"\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'key', value: 'one   two', startLine: 1, endLine: 3 },
      ]);
    });
  });

  describe('Given a backslash inside a trailing comment, When tokenizeConfig', () => {
    it('Then the backslash is not a continuation and the next line is a separate entry', () => {
      // Arrange & Act
      const result = tokenizeConfig('[a]\n\tkey = one # c\\\n\tnext = x\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'key', value: 'one', startLine: 1, endLine: 2 },
        { kind: 'entry', key: 'next', value: 'x', startLine: 2, endLine: 3 },
      ]);
    });
  });

  describe('Given a continuation tail that looks like a key line, When tokenizeConfig', () => {
    it('Then the tail is value content and only the real url entry is emitted', () => {
      // Arrange & Act
      const result = tokenizeConfig('[a]\n\tnote = first\\\n\turl = fake\n\turl = real\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'note', value: 'first\turl = fake', startLine: 1, endLine: 3 },
        { kind: 'entry', key: 'url', value: 'real', startLine: 3, endLine: 4 },
      ]);
    });
  });

  describe('Given a continuation tail that looks like a section header, When tokenizeConfig', () => {
    it('Then only one header token is emitted and note spans both physical lines', () => {
      // Arrange & Act
      const result = tokenizeConfig('[a]\n\tnote = v\\\n[x]\n\tkey = old\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'note', value: 'v[x]', startLine: 1, endLine: 3 },
        { kind: 'entry', key: 'key', value: 'old', startLine: 3, endLine: 4 },
      ]);
    });
  });

  describe('Given blank lines and comment lines, When tokenizeConfig', () => {
    it('Then blank lines emit blank tokens and comment lines emit comment tokens', () => {
      // Arrange & Act
      const result = tokenizeConfig('[a]\n\n# c\n   ; c\n   \n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'blank', line: 1 },
        { kind: 'comment', line: 2 },
        { kind: 'comment', line: 3 },
        { kind: 'blank', line: 4 },
      ]);
    });
  });

  describe('Given a header with or without an inline comment, When tokenizeConfig', () => {
    it('Then hasComment is true when an unquoted inline comment is present and false otherwise', () => {
      // Arrange & Act
      const withComment = tokenizeConfig('[a] # note\n');
      const withSemicolonComment = tokenizeConfig('[a] ; note\n');
      const withoutComment = tokenizeConfig('[a]\n');
      const quotedHash = tokenizeConfig('[a "x#y"]\n');

      // Assert
      expect((withComment[0] as Extract<ConfigToken, { kind: 'header' }>).hasComment).toBe(true);
      expect((withSemicolonComment[0] as Extract<ConfigToken, { kind: 'header' }>).hasComment).toBe(
        true,
      );
      expect((withoutComment[0] as Extract<ConfigToken, { kind: 'header' }>).hasComment).toBe(
        false,
      );
      expect((quotedHash[0] as Extract<ConfigToken, { kind: 'header' }>).hasComment).toBe(false);
    });
  });

  describe('Given a not-header body line starting with [ (`[half`), When tokenizeConfig', () => {
    it('Then it refuses with CONFIG_PARSE_ERROR on its physical line like git', () => {
      // Arrange + Act + Assert — `[half` is not a valid header and has no key char at column 0,
      // so git refuses it (bad config line 2); the parser must not skip it.
      try {
        tokenizeConfig('[a]\n\t[half\n');
        expect.unreachable('tokenizeConfig must refuse a bracket-shaped non-header line');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        if (err.data.code === 'CONFIG_PARSE_ERROR') {
          expect(err.data.line).toBe(2);
        }
      }
    });
  });

  describe('Given a valueless entry, When tokenizeConfig', () => {
    it('Then the entry token has a null value and a single-line span', () => {
      // Arrange & Act
      const result = tokenizeConfig('[a]\n\tkey\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'key', value: null, startLine: 1, endLine: 2 },
      ]);
    });
  });

  describe('Given a line whose key is missing (`\\t= v`), When tokenizeConfig', () => {
    it('Then it refuses with CONFIG_PARSE_ERROR on its physical line (no key char before `=`)', () => {
      // Arrange
      const input = '[a]\n\t= v\n';

      // Act + Assert — the key scanner requires an alpha first char
      try {
        tokenizeConfig(input);
        expect.unreachable('tokenizeConfig must refuse a line with no key');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        if (err.data.code === 'CONFIG_PARSE_ERROR') {
          expect(err.data.line).toBe(2);
        }
      }
    });
  });

  describe('Given an orphan entry before any header, When tokenizeConfig', () => {
    it('Then the orphan entry token precedes the header token and parseIniSections records the orphan section', () => {
      // Arrange
      const input = 'key = v\n[a]\n';

      // Act
      const tokens = tokenizeConfig(input);
      const sections = parseIniSections(input);

      // Assert
      expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'entry', key: 'key', value: 'v', startLine: 0, endLine: 1 },
        { kind: 'header', section: 'a', subsection: undefined, line: 1, hasComment: false },
      ]);
      // fold parity: the orphan entry records under the empty section, ahead of [a]
      expect(sections).toEqual<ReadonlyArray<IniSection>>([
        { section: '', subsection: undefined, entries: [{ key: 'key', value: 'v' }] },
        { section: 'a', subsection: undefined, entries: [] },
      ]);
    });
  });

  describe('Given text with a single trailing newline versus two trailing newlines, When tokenizeConfig', () => {
    it('Then the LF terminator emits no token but a second blank line does emit a blank token', () => {
      // Arrange & Act
      const singleNewline = tokenizeConfig('[a]\n');
      const doubleNewline = tokenizeConfig('[a]\n\n');

      // Assert
      expect(singleNewline).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
      ]);
      expect(doubleNewline).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'blank', line: 1 },
      ]);
    });
  });

  describe('Given a continuation that consumes the EOF terminator, When tokenizeConfig', () => {
    it('Then the entry endLine equals the split-array length pinning the exclusive-end contract at EOF', () => {
      // Arrange
      const input = '[a]\n\tk = v\\\n';

      // Act
      const result = tokenizeConfig(input);

      // Assert
      const lines = input.split('\n');
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'k', value: 'v', startLine: 1, endLine: lines.length },
      ]);
    });
  });

  describe('Given a malformed section header', () => {
    describe('When tokenizeConfig parses it', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1 and the partial section name', () => {
        // Arrange + Act + Assert
        try {
          tokenizeConfig('[s "a" x]\n\tk = v\n');
          expect.unreachable('tokenizeConfig must refuse a malformed header');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 1, partialSectionName: 's.a' });
        }
      });
    });
  });

  describe('Given a bad key line under a valid header', () => {
    describe('When tokenizeConfig parses it', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        try {
          tokenizeConfig('[a]\nbad!key\n');
          expect.unreachable('tokenizeConfig must refuse a bad key line');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2 });
        }
      });
    });
  });

  describe('Given an entry value with an unclosed quote', () => {
    describe('When tokenizeConfig parses it', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        try {
          tokenizeConfig('[a]\nk = "unclosed\n');
          expect.unreachable('tokenizeConfig must refuse an unclosed quote');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2 });
        }
      });
    });
  });

  describe('Given a malformed header and a source label', () => {
    describe('When tokenizeConfig and parseIniSections parse it', () => {
      it('Then both errors carry the source label', () => {
        // Arrange
        const source = 'my-config';

        // Act + Assert — tokenizeConfig carries the source label
        try {
          tokenizeConfig('[s "a" x]\n\tk = v\n', source);
          expect.unreachable('tokenizeConfig must refuse a malformed header');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data).toMatchObject({ code: 'CONFIG_PARSE_ERROR', source });
        }

        // Act + Assert — parseIniSections carries the same source label
        try {
          parseIniSections('[s "a" x]\n\tk = v\n', source);
          expect.unreachable('parseIniSections must refuse a malformed header');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data).toMatchObject({ code: 'CONFIG_PARSE_ERROR', source });
        }
      });
    });
  });
});

describe('Given a config with valueless/valued entries', () => {
  describe('When findFirstValuelessEntry', () => {
    it('Then returns the valueless entry for a matching key (step 2: single valueless key)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname\n\temail = a@b.c\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result?.key).toBe('user.name');
      expect(result?.line).toBe(2);
      expect(result?.source).toBe(`${ctx.layout.gitDir}/config`);
    });

    it('Then returns undefined when all keys are valued (step 3: valued only)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = Ada\n\temail = a@b.c\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns undefined when the key is absent (step 4: key absent)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\temail = a@b.c\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns undefined when config is empty (step 4: empty config)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns undefined when config file does not exist (step 4: missing file)', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns the valueless email when name is valued (step 5: file-order, valued name)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = Ada\n\temail\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result?.key).toBe('user.email');
      expect(result?.line).toBe(3);
    });

    it('Then returns the first valueless when name appears before email (step 6: both valueless, name earlier)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname\n\temail\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result?.key).toBe('user.name');
      expect(result?.line).toBe(2);
    });

    it('Then returns the first valueless when email appears before name (step 7: discriminator — file-position order)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\temail\n\tname\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result?.key).toBe('user.email');
      expect(result?.line).toBe(2);
    });

    it('Then matches the key case-insensitively and returns canonical lower-case (step 8)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tNAME\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name']);

      // Assert
      expect(result?.key).toBe('user.name');
      expect(result?.line).toBe(2);
    });

    it('Then does not match entries under the wrong section (step 9: negative scoping)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[other]\n\tname\n[user]\n\temail = a@b.c\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns the entry only under the correct section (step 9: positive scoping)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[other]\n\tname\n[user]\n\tname\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name']);

      // Assert
      expect(result?.key).toBe('user.name');
      expect(result?.line).toBe(4);
    });

    it('Then returns the full qualified key including subsection (step 10: subsection match)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[remote "origin"]\n\turl\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'remote', 'origin', ['url']);

      // Assert
      expect(result?.key).toBe('remote.origin.url');
      expect(result?.line).toBe(2);
      expect(result?.source).toBe(`${ctx.layout.gitDir}/config`);
    });

    it('Then returns undefined when subsection does not match (step 10: subsection mismatch)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[remote "origin"]\n\turl\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'remote', 'other', ['url']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then matches the subsection case-sensitively (a differing case does not match)', async () => {
      // Arrange — git subsection names are case-SENSITIVE, unlike section names.
      const ctx = createMemoryContext();
      await seed(ctx, '[remote "Origin"]\n\turl\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'remote', 'origin', ['url']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns undefined for a valueless target key that appears before any section header', async () => {
      // Arrange — a pre-header bare key must NOT match: inSection starts false
      // and is only set to true when a matching [section] header is seen.
      // Mutant (inSection=true) would wrongly return the pre-header entry.
      const ctx = createMemoryContext();
      await seed(ctx, '\tname\n[user]\n\temail = a@b.c\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns undefined for a valueless non-target key under the matching section', async () => {
      // Arrange — a valueless key that is NOT in the requested key set must be
      // skipped. Mutant (!keySet.has → false) would wrongly return it.
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tfoo\n\temail = a@b.c\n');

      // Act
      const result = await findFirstValuelessEntry(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('Given a section with valueless/valued entries across subsections', () => {
  describe('When findFirstValuelessInSection scans every subsection of the section', () => {
    it('Then it reports a valueless key in the only subsection with its verbatim subsection', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[merge "custom"]\n\tdriver\n');

      // Act
      const result = await findFirstValuelessInSection(ctx, 'merge', ['driver', 'name']);

      // Assert
      expect(result?.key).toBe('merge.custom.driver');
      expect(result?.line).toBe(2);
      expect(result?.source).toBe(`${ctx.layout.gitDir}/config`);
    });

    it('Then it reports the earlier-by-line key across two subsections with its verbatim subsection', async () => {
      // Arrange — name valueless at line 2 (subsection zzz), driver valueless at
      // line 4 (subsection aaa); the earlier line wins regardless of lexical order.
      const ctx = createMemoryContext();
      await seed(ctx, '[merge "zzz"]\n\tname\n[merge "aaa"]\n\tdriver\n');

      // Act
      const result = await findFirstValuelessInSection(ctx, 'merge', ['driver', 'name']);

      // Assert
      expect(result?.key).toBe('merge.zzz.name');
      expect(result?.line).toBe(2);
    });

    it('Then it does not report a valueless key under a non-matching section', async () => {
      // Arrange — the valueless key sits under [other], not [merge].
      const ctx = createMemoryContext();
      await seed(ctx, '[other "custom"]\n\tdriver\n');

      // Act
      const result = await findFirstValuelessInSection(ctx, 'merge', ['driver', 'name']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then it does not report an empty-string (valued) key, only a null one', async () => {
      // Arrange — `driver = ` is valued (empty string), not valueless.
      const ctx = createMemoryContext();
      await seed(ctx, '[merge "custom"]\n\tdriver = \n');

      // Act
      const result = await findFirstValuelessInSection(ctx, 'merge', ['driver', 'name']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then it does not report a valueless non-target key under a matching subsection', async () => {
      // Arrange — `recursive` is not in the requested key set.
      const ctx = createMemoryContext();
      await seed(ctx, '[merge "custom"]\n\trecursive\n\tdriver = mycmd\n');

      // Act
      const result = await findFirstValuelessInSection(ctx, 'merge', ['driver', 'name']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then it lower-cases the section and key but keeps the subsection verbatim', async () => {
      // Arrange — section/key matched case-insensitively; subsection case preserved.
      const ctx = createMemoryContext();
      await seed(ctx, '[Merge "Custom"]\n\tDRIVER\n');

      // Act
      const result = await findFirstValuelessInSection(ctx, 'merge', ['driver', 'name']);

      // Assert
      expect(result?.key).toBe('merge.Custom.driver');
      expect(result?.line).toBe(2);
    });

    it('Then a flat (no-subsection) section key has no subsection segment', async () => {
      // Arrange — a flat `[merge]` (no subsection) holding a valueless `driver`; the
      // qualified key omits the subsection segment (`merge.driver`, not `merge..driver`).
      const ctx = createMemoryContext();
      await seed(ctx, '[merge]\n\tdriver\n');

      // Act
      const result = await findFirstValuelessInSection(ctx, 'merge', ['driver', 'name']);

      // Assert
      expect(result?.key).toBe('merge.driver');
      expect(result?.line).toBe(2);
    });

    it('Then requireSubsection skips a subsectionless valueless key (inert to git)', async () => {
      // Arrange — git's merge-driver keys are only meaningful under a subsection, so a
      // subsectionless `[merge] driver` is inert; requireSubsection must not report it.
      const ctx = createMemoryContext();
      await seed(ctx, '[merge]\n\tdriver\n');

      // Act
      const result = await findFirstValuelessInSection(ctx, 'merge', ['driver', 'name'], {
        requireSubsection: true,
      });

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then requireSubsection still reports a subsectioned valueless key', async () => {
      // Arrange — a subsectioned valueless driver IS git's death; requireSubsection keeps it.
      const ctx = createMemoryContext();
      await seed(ctx, '[merge "custom"]\n\tdriver\n');

      // Act
      const result = await findFirstValuelessInSection(ctx, 'merge', ['driver', 'name'], {
        requireSubsection: true,
      });

      // Assert
      expect(result?.key).toBe('merge.custom.driver');
    });

    it('Then it ignores a matching valueless key that precedes any header (orphan)', async () => {
      // Arrange — a valueless `driver` in the orphan region (before any header) must
      // not be reported; only the one under the real [merge "custom"] header counts.
      const ctx = createMemoryContext();
      await seed(ctx, 'driver\n[merge "custom"]\n\tdriver\n');

      // Act
      const result = await findFirstValuelessInSection(ctx, 'merge', ['driver', 'name']);

      // Assert — the orphan key at line 1 is skipped; the [merge "custom"] key at line 3 wins.
      expect(result?.key).toBe('merge.custom.driver');
      expect(result?.line).toBe(3);
    });
  });
});

describe('Char-wise same-line, orphan, and key-grammar config parsing', () => {
  const headerToken = (
    section: string,
    subsection: string | undefined,
    line: number,
  ): ConfigToken => ({ kind: 'header', section, subsection, line, hasComment: false });

  const assertParseConfigRefuses = (input: string, line: number): void => {
    try {
      parseIniSections(input, 'test.cfg');
      expect.unreachable(`must throw CONFIG_PARSE_ERROR on line ${line}`);
    } catch (err) {
      if (!(err instanceof TsgitError)) throw err;
      expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
      if (err.data.code === 'CONFIG_PARSE_ERROR') {
        expect(err.data.line).toBe(line);
        expect(err.data.source).toBe('test.cfg');
      }
    }
  };

  describe('header and entry on the same physical line', () => {
    describe('Given `[a] key = v`, When tokenizeConfig', () => {
      it('Then a header token is followed by a shared-line entry token and the section records a.key = v', () => {
        // Arrange & Act
        const tokens = tokenizeConfig('[a] key = v\n');
        const sections = parseIniSections('[a] key = v\n');

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          {
            kind: 'entry',
            key: 'key',
            value: 'v',
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 4,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'v' }] },
        ]);
      });
    });

    describe('Given `[a] key` (valueless same-line), When tokenizeConfig', () => {
      it('Then a shared-line valueless entry token follows the header', () => {
        // Arrange & Act
        const tokens = tokenizeConfig('[a] key\n');
        const sections = parseIniSections('[a] key\n');

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          {
            kind: 'entry',
            key: 'key',
            value: null,
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 4,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: null }] },
        ]);
      });
    });

    describe('Given `[a]key=v` (no gap after the bracket), When tokenizeConfig', () => {
      it('Then the shared-line entry starts right after the bracket and records a.key = v', () => {
        // Arrange & Act
        const tokens = tokenizeConfig('[a]key=v\n');
        const sections = parseIniSections('[a]key=v\n');

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          {
            kind: 'entry',
            key: 'key',
            value: 'v',
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 3,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'v' }] },
        ]);
      });
    });

    describe('Given `[a]\\tkey = v` (TAB gap after the bracket), When parseIniSections', () => {
      it('Then a.key = v is recorded', () => {
        // Arrange & Act
        const result = parseIniSections('[a]\tkey = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'v' }] },
        ]);
      });
    });

    describe('Given `[a "s"] key = v` (subsectioned header + same-line entry), When tokenizeConfig', () => {
      it('Then the shared-line entry starts past the closing quote+bracket and records a.s.key = v', () => {
        // Arrange & Act
        const tokens = tokenizeConfig('[a "s"] key = v\n');
        const sections = parseIniSections('[a "s"] key = v\n');

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', 's', 0),
          {
            kind: 'entry',
            key: 'key',
            value: 'v',
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 8,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: 's', entries: [{ key: 'key', value: 'v' }] },
        ]);
      });
    });

    describe('Given `[a]key` (no gap, valueless), When parseIniSections', () => {
      it('Then a.key valueless is recorded', () => {
        // Arrange & Act
        const result = parseIniSections('[a]key\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: null }] },
        ]);
      });
    });

    describe('Given `[a] key=` (empty value), When parseIniSections', () => {
      it('Then a.key records the empty string distinct from valueless', () => {
        // Arrange & Act
        const result = parseIniSections('[a] key=\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: '' }] },
        ]);
      });
    });

    describe('Given `[a] key = v\\n\\tk2 = v2` (same-line entry then a following entry), When parseIniSections', () => {
      it('Then both a.key = v and a.k2 = v2 are recorded', () => {
        // Arrange & Act
        const result = parseIniSections('[a] key = v\n\tk2 = v2\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          {
            section: 'a',
            subsection: undefined,
            entries: [
              { key: 'key', value: 'v' },
              { key: 'k2', value: 'v2' },
            ],
          },
        ]);
      });
    });

    describe('Given `[a] key = a=b` (first `=` splits, rest is value), When parseIniSections', () => {
      it('Then a.key records the value a=b', () => {
        // Arrange & Act
        const result = parseIniSections('[a] key = a=b\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'a=b' }] },
        ]);
      });
    });

    describe('Given `[a]  key  =  v` (surrounding spaces), When parseIniSections', () => {
      it('Then a.key = v is recorded with the value trimmed', () => {
        // Arrange & Act
        const result = parseIniSections('[a]  key  =  v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'v' }] },
        ]);
      });
    });

    describe('Given `[a] key = one\\\\\\n  two` (same-line continuation), When tokenizeConfig', () => {
      it('Then the shared-line entry spans onto the next physical line with value one␣␣two', () => {
        // Arrange
        const input = '[a] key = one\\\n  two\n';

        // Act
        const tokens = tokenizeConfig(input);
        const sections = parseIniSections(input);

        // Assert — endLine crosses the physical line boundary
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          {
            kind: 'entry',
            key: 'key',
            value: 'one  two',
            startLine: 0,
            endLine: 2,
            sharesHeaderLine: true,
            startCol: 4,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'one  two' }] },
        ]);
      });
    });

    describe('Given `[a] key = v\\r` (CRLF line), When parseIniSections', () => {
      it('Then a.key = v is recorded ignoring the trailing CR', () => {
        // Arrange & Act
        const result = parseIniSections('[a] key = v\r\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'v' }] },
        ]);
      });
    });

    describe('Given `[a] # c` (same-line comment after header), When tokenizeConfig', () => {
      it('Then only the header token is emitted with no entry', () => {
        // Arrange & Act
        const tokens = tokenizeConfig('[a] # c\n');
        const sections = parseIniSections('[a] # c\n');

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: true },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
        ]);
      });
    });

    describe('Given `[a] ; c` (same-line semicolon comment), When tokenizeConfig', () => {
      it('Then only the header token is emitted with no entry', () => {
        // Arrange & Act
        const result = tokenizeConfig('[a] ; c\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<ConfigToken>>([
          { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: true },
        ]);
      });
    });
  });

  describe('chained section headers on one physical line', () => {
    describe('Given `[a][b]\\nx=1` (chain then body entry), When tokenizeConfig', () => {
      it('Then two header tokens at line 0 precede the body entry recorded under the last section', () => {
        // Arrange
        const input = '[a][b]\nx=1\n';

        // Act
        const tokens = tokenizeConfig(input);
        const sections = parseIniSections(input);

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          headerToken('b', undefined, 0),
          { kind: 'entry', key: 'x', value: '1', startLine: 1, endLine: 2 },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: undefined, entries: [{ key: 'x', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a][b]k=1` (chain then same-line entry, no gap), When tokenizeConfig', () => {
      it('Then the same-line entry shares the last header line and records b.k = 1', () => {
        // Arrange
        const input = '[a][b]k=1\n';

        // Act
        const tokens = tokenizeConfig(input);
        const sections = parseIniSections(input);

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          headerToken('b', undefined, 0),
          {
            kind: 'entry',
            key: 'k',
            value: '1',
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 6,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a] [b] k=1` (chain with gaps then same-line entry), When parseIniSections', () => {
      it('Then b.k = 1 is recorded under the last section', () => {
        // Arrange & Act
        const result = parseIniSections('[a] [b] k=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a][b][c] k=1` (three-header chain then same-line entry), When tokenizeConfig', () => {
      it('Then three header tokens at line 0 precede the entry recorded under the last section', () => {
        // Arrange
        const input = '[a][b][c] k=1\n';

        // Act
        const tokens = tokenizeConfig(input);
        const sections = parseIniSections(input);

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          headerToken('b', undefined, 0),
          headerToken('c', undefined, 0),
          {
            kind: 'entry',
            key: 'k',
            value: '1',
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 10,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: undefined, entries: [] },
          { section: 'c', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a]\\n[b][c]\\nk=1` (header, then a chain on its own line, then a body entry), When parseIniSections', () => {
      it('Then the body entry records under the last chained section', () => {
        // Arrange & Act
        const result = parseIniSections('[a]\n[b][c]\nk=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: undefined, entries: [] },
          { section: 'c', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a][b "s"] k=1` (plain header chained to a subsectioned header), When tokenizeConfig', () => {
      it('Then the entry records under the subsectioned last section b.s.k = 1', () => {
        // Arrange
        const input = '[a][b "s"] k=1\n';

        // Act
        const tokens = tokenizeConfig(input);
        const sections = parseIniSections(input);

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          headerToken('b', 's', 0),
          {
            kind: 'entry',
            key: 'k',
            value: '1',
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 11,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: 's', entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a "s"][b] k=1` (subsectioned header chained to a plain header), When parseIniSections', () => {
      it('Then the entry records under the plain last section b.k = 1', () => {
        // Arrange & Act
        const result = parseIniSections('[a "s"][b] k=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: 's', entries: [] },
          { section: 'b', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a][b]` (chain with no entry), When tokenizeConfig', () => {
      it('Then both headers are emitted as empty sections with no entry', () => {
        // Arrange
        const input = '[a][b]\n';

        // Act
        const tokens = tokenizeConfig(input);
        const sections = parseIniSections(input);

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          headerToken('b', undefined, 0),
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: undefined, entries: [] },
        ]);
      });
    });

    describe('Given `[a][b] # c` (chain then a same-line comment), When tokenizeConfig', () => {
      it('Then both headers are emitted, the last carrying the comment flag, with no entry', () => {
        // Arrange & Act
        const result = tokenizeConfig('[a][b] # c\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<ConfigToken>>([
          { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
          { kind: 'header', section: 'b', subsection: undefined, line: 0, hasComment: true },
        ]);
      });
    });

    describe('Given `[a][b` (a valid header chained to an unclosed second span), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a][b\n', 1);
      });
    });

    describe('Given `[a][]` (a valid header chained to an empty second span), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a][]\n', 1);
      });
    });

    describe('Given `[a][ b]` (a valid header chained to an interior-whitespace second span), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a][ b]\n', 1);
      });
    });
  });

  describe('the unified key grammar refuses what git refuses', () => {
    describe('Given `[a] bad!key = v` (exclamation in same-line key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a] bad!key = v\n', 1);
      });
    });

    describe('Given `[a] foo bar = v` (space inside same-line key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a] foo bar = v\n', 1);
      });
    });

    describe('Given `[a] foo.dot = v` (dot in same-line key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a] foo.dot = v\n', 1);
      });
    });

    describe('Given `\\tbad!key = v` under a header (exclamation), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tbad!key = v\n', 2);
      });
    });

    describe('Given `\\tunder_score = v` under a header (underscore), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tunder_score = v\n', 2);
      });
    });

    describe('Given `\\t9key = v` under a header (digit-first), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\t9key = v\n', 2);
      });
    });

    describe('Given `\\t-key = v` under a header (dash-first), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\t-key = v\n', 2);
      });
    });

    describe('Given `\\tkey.dot = v` under a header (dot in key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tkey.dot = v\n', 2);
      });
    });

    describe('Given `\\tkey@at = v` under a header (at in key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tkey@at = v\n', 2);
      });
    });

    describe('Given `\\tkey x = v` under a header (space then non-`=`), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tkey x = v\n', 2);
      });
    });
  });

  describe('the unquoted section-name grammar accepts what git accepts', () => {
    describe('Given `[1a]` (digit-first section, unlike keys), When parseIniSections', () => {
      it('Then the section records as 1a', () => {
        // Arrange & Act
        const result = parseIniSections('[1a]\nk=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: '1a', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a.b]` (dot in section), When parseIniSections', () => {
      it('Then the section records as a.b', () => {
        // Arrange & Act
        const result = parseIniSections('[a.b]\nk=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a.b', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a-b]` (dash in section), When parseIniSections', () => {
      it('Then the section records as a-b', () => {
        // Arrange & Act
        const result = parseIniSections('[a-b]\nk=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a-b', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a] ` (trailing space after the bracket), When parseIniSections', () => {
      it('Then the section records as a with the trailing gap ignored', () => {
        // Arrange + Act — a gap after `]` is fine; only whitespace INSIDE the brackets refuses
        const result = parseIniSections('[a] \nk=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });
  });

  describe('the unquoted section-name grammar refuses what git refuses', () => {
    describe('Given `[a ]` (whitespace before the close), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a ]\nk=1\n', 1);
      });
    });

    describe('Given `[ a]` (whitespace after the open), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[ a]\nk=1\n', 1);
      });
    });

    describe('Given `[a b]` (interior whitespace), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a b]\nk=1\n', 1);
      });
    });

    describe('Given `[ core ]` (padded section name), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[ core ]\nk=1\n', 1);
      });
    });

    describe('Given `[a_b]` (underscore in section, outside the grammar), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a_b]\nk=1\n', 1);
      });
    });
  });

  describe('the unified key grammar accepts what git accepts', () => {
    describe('Given `\\tk = v` under a header, When parseIniSections', () => {
      it('Then a.k = v is recorded', () => {
        // Arrange & Act
        const result = parseIniSections('[a]\n\tk = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });

    describe('Given `\\tk   = v` under a header (spaces before `=`), When parseIniSections', () => {
      it('Then a.k = v is recorded', () => {
        // Arrange & Act
        const result = parseIniSections('[a]\n\tk   = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });

    describe('Given `\\tk\\t= v` under a header (TAB before `=`), When parseIniSections', () => {
      it('Then a.k = v is recorded', () => {
        // Arrange & Act
        const result = parseIniSections('[a]\n\tk\t= v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });

    describe('Given `\\tkey   ` under a header (trailing spaces, no `=`), When parseIniSections', () => {
      it('Then a.key valueless is recorded', () => {
        // Arrange & Act
        const result = parseIniSections('[a]\n\tkey   \n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: null }] },
        ]);
      });
    });
  });

  describe('orphan (sectionless) keys', () => {
    describe('Given `orphan = v` before any header, When parseIniSections', () => {
      it('Then it records under the empty section with no subsection', () => {
        // Arrange & Act
        const result = parseIniSections('orphan = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: '', subsection: undefined, entries: [{ key: 'orphan', value: 'v' }] },
        ]);
      });
    });

    describe('Given `orphan` (valueless) before any header, When parseIniSections', () => {
      it('Then it records valueless under the empty section', () => {
        // Arrange & Act
        const result = parseIniSections('orphan\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: '', subsection: undefined, entries: [{ key: 'orphan', value: null }] },
        ]);
      });
    });

    describe('Given `orphan = v\\n[a]\\n\\tk = w` (orphan then a section), When parseIniSections', () => {
      it('Then the orphan section precedes the named section', () => {
        // Arrange & Act
        const result = parseIniSections('orphan = v\n[a]\n\tk = w\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: '', subsection: undefined, entries: [{ key: 'orphan', value: 'v' }] },
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'w' }] },
        ]);
      });
    });

    describe('Given a header-only file, When parseIniSections', () => {
      it('Then no empty orphan section is emitted', () => {
        // Arrange & Act
        const result = parseIniSections('[a]\n\tk = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });

    describe('Given `bad!orphan = v` before any header, When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('bad!orphan = v\n', 1);
      });
    });

    describe('Given `9orphan = v` before any header, When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('9orphan = v\n', 1);
      });
    });

    describe('Given the three empty-section identities, When qualifyKey', () => {
      it('Then an orphan (undefined subsection) renders the bare key with no dot', () => {
        // Arrange & Act
        const result = qualifyKey({ section: '', subsection: undefined, entries: [] }, 'Key');

        // Assert
        expect(result).toBe('key');
      });

      it('Then an empty section with an empty subsection renders both dots before the key', () => {
        // Arrange & Act
        const result = qualifyKey({ section: '', subsection: '', entries: [] }, 'Key');

        // Assert
        expect(result).toBe('..key');
      });

      it('Then a named empty-section subsection renders .subsection.key', () => {
        // Arrange & Act
        const result = qualifyKey({ section: '', subsection: 'x', entries: [] }, 'Key');

        // Assert
        expect(result).toBe('.x.key');
      });
    });

    describe('Given the orphan key `orphan`, When parseConfigKey', () => {
      it('Then it is unaddressable — CONFIG_KEY_INVALID with reason missing-name', () => {
        // Arrange + Act + Assert
        try {
          parseConfigKey('orphan');
          expect.unreachable('orphan key must be unaddressable');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_KEY_INVALID');
          if (err.data.code === 'CONFIG_KEY_INVALID') {
            expect(err.data.reason).toBe('missing-name');
          }
        }
      });
    });
  });

  describe('mid-key and comment preservation forms', () => {
    describe('Given `\\tab#cd = x` under a header (hash inside the key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tab#cd = x\n', 2);
      });
    });

    describe('Given `\\tab;cd = x` under a header (semicolon inside the key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tab;cd = x\n', 2);
      });
    });

    describe('Given `\\tab # cd = x` under a header (space-hash inside the key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tab # cd = x\n', 2);
      });
    });

    describe('Given `\\tkey#=v` under a header (hash before the `=`), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tkey#=v\n', 2);
      });
    });

    describe('Given `\\t#whole = line` under a header (whole-line comment), When tokenizeConfig', () => {
      it('Then it is a comment token and no entry records', () => {
        // Arrange & Act
        const tokens = tokenizeConfig('[a]\n\t#whole = line\n');
        const sections = parseIniSections('[a]\n\t#whole = line\n');

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          { kind: 'comment', line: 1 },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
        ]);
      });
    });

    describe('Given a `;`-led whole-line comment that also holds a later `#`, When tokenizeConfig', () => {
      it('Then the earliest marker (the `;`) starts the comment so the line is one comment token', () => {
        // Arrange + Act — `;` sits at column 0, before the `#`; the earliest marker must win.
        const tokens = tokenizeConfig('; a # b\n');

        // Assert — cutting at the later `#` instead would leave `; a`, which the key grammar refuses.
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([{ kind: 'comment', line: 0 }]);
      });
    });

    describe('Given `\\tk = v # trailing` under a header (value-side comment), When parseIniSections', () => {
      it('Then a.k = v is recorded with the comment dropped', () => {
        // Arrange & Act
        const result = parseIniSections('[a]\n\tk = v # trailing\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });
  });

  describe('key-scanner guard isolation', () => {
    describe('Given a first character that is not a letter, When parseIniSections', () => {
      it('Then the digit-first key alone refuses on its physical line', () => {
        // Arrange + Act + Assert — isolates the first-char-alpha guard
        assertParseConfigRefuses('[a]\n\t1 = v\n', 2);
      });
    });

    describe('Given a key followed by spaces then `=` (`k   =`), When parseIniSections', () => {
      it('Then the space run is skipped and a.k = v is recorded', () => {
        // Arrange + Act — isolates the post-key space skip on the `=` branch
        const result = parseIniSections('[a]\n\tk   = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });

    describe('Given a key followed by a TAB then `=` (`k\\t=`), When parseIniSections', () => {
      it('Then the TAB is skipped and a.k = v is recorded', () => {
        // Arrange + Act — isolates the post-key TAB skip on the `=` branch
        const result = parseIniSections('[a]\n\tk\t= v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });

    describe('Given the post-key terminator branches, When parseIniSections', () => {
      it('Then a bare EOL records a valueless entry', () => {
        // Arrange + Act — isolates the EOL branch
        const result = parseIniSections('[a]\n\tk\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: null }] },
        ]);
      });

      it('Then a CR-at-EOL records a valueless entry', () => {
        // Arrange + Act — isolates the CR-at-EOL branch
        const result = parseIniSections('[a]\n\tk\r\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: null }] },
        ]);
      });

      it('Then an `=` records a valued entry', () => {
        // Arrange + Act — isolates the `=` branch
        const result = parseIniSections('[a]\n\tk = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });

      it('Then any other char after the key refuses', () => {
        // Arrange + Act + Assert — isolates the catch-all parse-error branch
        assertParseConfigRefuses('[a]\n\tk: v\n', 2);
      });
    });
  });

  describe('parseGitInt', () => {
    describe('Given a 0x-prefixed hex value', () => {
      describe('When parseGitInt', () => {
        it('Then it parses base-16 to the exact magnitude (0xFF is 255)', () => {
          // Arrange & Act
          const result = parseGitInt('0xFF');

          // Assert
          expect(result).toStrictEqual({ ok: true, value: 255 });
        });
      });
    });

    describe('Given a leading-zero octal value', () => {
      describe('When parseGitInt', () => {
        it('Then it parses base-8 to the exact magnitude (017 is 15)', () => {
          // Arrange & Act
          const result = parseGitInt('017');

          // Assert
          expect(result).toStrictEqual({ ok: true, value: 15 });
        });
      });
    });

    describe('Given a decimal value with a k unit suffix', () => {
      describe('When parseGitInt', () => {
        it('Then it multiplies the magnitude by 1024 (10k is 10240)', () => {
          // Arrange & Act
          const result = parseGitInt('10k');

          // Assert
          expect(result).toStrictEqual({ ok: true, value: 10240 });
        });
      });
    });

    describe('Given a value with leading ASCII whitespace', () => {
      describe('When parseGitInt', () => {
        it('Then the leading spaces and tabs are trimmed before parsing (5 is 5)', () => {
          // Arrange & Act
          const result = parseGitInt(' \t5');

          // Assert
          expect(result).toStrictEqual({ ok: true, value: 5 });
        });
      });
    });

    describe('Given a value with trailing non-unit garbage', () => {
      describe('When parseGitInt', () => {
        it('Then it fails with reason invalid unit (5x is rejected, not 5)', () => {
          // Arrange & Act
          const result = parseGitInt('5x');

          // Assert
          expect(result).toStrictEqual({ ok: false, reason: 'invalid unit' });
        });
      });
    });

    describe('Given a magnitude one past the int64 maximum', () => {
      describe('When parseGitInt', () => {
        it('Then it fails with reason out of range', () => {
          // Arrange & Act
          const result = parseGitInt('9223372036854775808');

          // Assert
          expect(result).toStrictEqual({ ok: false, reason: 'out of range' });
        });
      });
    });
  });

  describe('parseGitBoolean grammar (Pin K)', () => {
    describe('Given a case-insensitive true word', () => {
      describe('When parseGitBoolean', () => {
        it.each([
          { value: 'true', label: 'true' },
          { value: 'TRUE', label: 'TRUE' },
          { value: 'TrUe', label: 'TrUe' },
          { value: 'yes', label: 'yes' },
          { value: 'Yes', label: 'Yes' },
          { value: 'yEs', label: 'yEs' },
          { value: 'on', label: 'on' },
          { value: 'ON', label: 'ON' },
        ])('Then parseGitBoolean($label) is { ok: true, value: true }', ({ value }) => {
          // Arrange & Act
          const result = parseGitBoolean(value);

          // Assert
          expect(result).toStrictEqual({ ok: true, value: true });
        });
      });
    });

    describe('Given a case-insensitive false word', () => {
      describe('When parseGitBoolean', () => {
        it.each([
          { value: 'false', label: 'false' },
          { value: 'FALSE', label: 'FALSE' },
          { value: 'no', label: 'no' },
          { value: 'No', label: 'No' },
          { value: 'off', label: 'off' },
          { value: 'OFF', label: 'OFF' },
          { value: 'oFf', label: 'oFf' },
        ])('Then parseGitBoolean($label) is { ok: true, value: false }', ({ value }) => {
          // Arrange & Act
          const result = parseGitBoolean(value);

          // Assert
          expect(result).toStrictEqual({ ok: true, value: false });
        });
      });
    });

    describe('Given a valueless key (null, git internal NULL)', () => {
      describe('When parseGitBoolean', () => {
        it('Then it is { ok: true, value: true }', () => {
          // Arrange & Act
          const result = parseGitBoolean(null);

          // Assert
          expect(result).toStrictEqual({ ok: true, value: true });
        });
      });
    });

    describe('Given an empty value', () => {
      describe('When parseGitBoolean', () => {
        it('Then it is { ok: true, value: false }', () => {
          // Arrange & Act
          const result = parseGitBoolean('');

          // Assert
          expect(result).toStrictEqual({ ok: true, value: false });
        });
      });
    });

    describe('Given a single quoted space (not empty)', () => {
      describe('When parseGitBoolean', () => {
        it('Then it refuses', () => {
          // Arrange & Act
          const result = parseGitBoolean(' ');

          // Assert
          expect(result).toStrictEqual({ ok: false });
        });
      });
    });

    describe('Given an integer-arm value git accepts as true', () => {
      describe('When parseGitBoolean', () => {
        it.each([
          { value: '1', label: '1' },
          { value: '2', label: '2' },
          { value: '-1', label: '-1' },
          { value: '+1', label: '+1' },
          { value: '007', label: '007 (octal 7)' },
          { value: '0x1', label: '0x1' },
          { value: '0x7fffffff', label: '0x7fffffff (INT_MAX in hex)' },
          { value: '1k', label: '1k' },
          { value: '1K', label: '1K' },
          { value: '1m', label: '1m' },
          { value: '1M', label: '1M' },
          { value: '1g', label: '1g' },
          { value: '1G', label: '1G' },
          { value: '2147483647', label: '2147483647 (INT_MAX, boundary)' },
          { value: '-2147483648', label: '-2147483648 (INT_MIN, boundary)' },
        ])('Then parseGitBoolean($label) is { ok: true, value: true }', ({ value }) => {
          // Arrange & Act
          const result = parseGitBoolean(value);

          // Assert
          expect(result).toStrictEqual({ ok: true, value: true });
        });
      });
    });

    describe('Given an integer-arm value git accepts as false (zero in every radix)', () => {
      describe('When parseGitBoolean', () => {
        it.each([
          { value: '0', label: '0' },
          { value: '00', label: '00' },
          { value: '0x0', label: '0x0' },
          { value: '0k', label: '0k' },
        ])('Then parseGitBoolean($label) is { ok: true, value: false }', ({ value }) => {
          // Arrange & Act
          const result = parseGitBoolean(value);

          // Assert
          expect(result).toStrictEqual({ ok: true, value: false });
        });
      });
    });

    describe('Given an integer-arm value that overflows the C int range', () => {
      describe('When parseGitBoolean', () => {
        it.each([
          { value: '2147483648', label: '2147483648 (one past INT_MAX)' },
          { value: '-2147483649', label: '-2147483649 (one past INT_MIN)' },
          { value: '0x80000000', label: '0x80000000 (same overflow, hex)' },
          { value: '2g', label: '2g (same overflow, scaled)' },
        ])('Then parseGitBoolean($label) refuses', ({ value }) => {
          // Arrange & Act
          const result = parseGitBoolean(value);

          // Assert
          expect(result).toStrictEqual({ ok: false });
        });
      });
    });

    describe('Given a value that is neither a word nor an integer', () => {
      describe('When parseGitBoolean', () => {
        it.each([
          { value: 'maybe', label: 'maybe' },
          { value: 'truthy', label: 'truthy' },
          { value: '1.0', label: '1.0' },
        ])('Then parseGitBoolean($label) refuses', ({ value }) => {
          // Arrange & Act
          const result = parseGitBoolean(value);

          // Assert
          expect(result).toStrictEqual({ ok: false });
        });
      });
    });
  });

  describe('findFirstInvalidCompression', () => {
    describe('Given a config with no invalid compression value', () => {
      describe('When findFirstInvalidCompression', () => {
        it.each([
          { config: '[user]\n\tname = Bob\n', label: 'no [core] section' },
          { config: '[core]\n\tbare = false\n', label: 'core.loosecompression is absent' },
          {
            config: '[core]\n\tloosecompression = 5\n',
            label: 'core.loosecompression = 5 (valid)',
          },
          {
            config: '[core]\n\tcompression = 9\n',
            label: 'core.compression = 9 (zlib maximum, valid)',
          },
        ])('Then returns undefined ($label)', async ({ config }) => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);

          // Act
          const result = await findFirstInvalidCompression(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a loosecompression or compression value with an invalid unit, When findFirstInvalidCompression', () => {
      it.each([
        {
          config: '[core]\n\tloosecompression\n',
          key: 'core.loosecompression',
          value: '',
          label: 'loosecompression is valueless (null value)',
        },
        {
          config: '[core]\n\tloosecompression = abc\n',
          key: 'core.loosecompression',
          value: 'abc',
          label: 'loosecompression = abc',
        },
        {
          config: '[core]\n\tcompression = abc\n',
          key: 'core.compression',
          value: 'abc',
          label: 'compression = abc',
        },
      ])(
        'Then returns numeric failure with reason invalid unit ($label)',
        async ({ config, key, value }) => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);

          // Act
          const result = await findFirstInvalidCompression(ctx);

          // Assert
          expect(result).not.toBeUndefined();
          expect(result?.key).toBe(key);
          expect(result?.failure.kind).toBe('numeric');
          if (result?.failure.kind === 'numeric') {
            expect(result.failure.value).toBe(value);
            expect(result.failure.reason).toBe('invalid unit');
          }
        },
      );
    });

    describe('Given core.loosecompression = 999999999999999999999999 (out of range)', () => {
      describe('When findFirstInvalidCompression', () => {
        it('Then returns numeric failure with reason out of range', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/config`,
            '[core]\n\tloosecompression = 999999999999999999999999\n',
          );

          // Act
          const result = await findFirstInvalidCompression(ctx);

          // Assert
          expect(result).not.toBeUndefined();
          expect(result?.failure.kind).toBe('numeric');
          if (result?.failure.kind === 'numeric') {
            expect(result.failure.reason).toBe('out of range');
          }
        });
      });
    });

    describe('Given a loosecompression or compression value outside the zlib range, When findFirstInvalidCompression', () => {
      it.each([
        {
          config: '[core]\n\tloosecompression = 99\n',
          level: 99,
          label: 'loosecompression = 99 (valid int, outside zlib range)',
        },
        {
          config: '[core]\n\tloosecompression = -2\n',
          level: -2,
          label: 'loosecompression = -2 (valid int, below zlib min)',
        },
        {
          config: '[core]\n\tcompression = 10\n',
          level: 10,
          label: 'compression = 10 (one past the zlib maximum)',
        },
      ])('Then returns zlib failure with the level ($label)', async ({ config, level }) => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);

        // Act
        const result = await findFirstInvalidCompression(ctx);

        // Assert
        expect(result).not.toBeUndefined();
        expect(result?.failure.kind).toBe('zlib');
        if (result?.failure.kind === 'zlib') {
          expect(result.failure.level).toBe(level);
        }
      });
    });

    describe('Given loosecompression = abc (line 2) before compression = abc (line 3)', () => {
      describe('When findFirstInvalidCompression', () => {
        it('Then returns the loosecompression entry (first failing by line)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/config`,
            '[core]\n\tloosecompression = abc\n\tcompression = abc\n',
          );

          // Act
          const result = await findFirstInvalidCompression(ctx);

          // Assert
          expect(result?.key).toBe('core.loosecompression');
        });
      });
    });

    describe('Given compression = abc (line 2) before loosecompression = abc (line 3)', () => {
      describe('When findFirstInvalidCompression', () => {
        it('Then returns the compression entry (first failing by line)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/config`,
            '[core]\n\tcompression = abc\n\tloosecompression = abc\n',
          );

          // Act
          const result = await findFirstInvalidCompression(ctx);

          // Assert
          expect(result?.key).toBe('core.compression');
        });
      });
    });
  });

  describe('findLastInvalidMaxTreeDepth', () => {
    describe('Given core.maxTreeDepth = 2.5 (line 2) then core.maxTreeDepth = 2048 (line 3)', () => {
      describe('When findLastInvalidMaxTreeDepth', () => {
        it('Then returns undefined (the last, valid entry is the effective one)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/config`,
            '[core]\n\tmaxTreeDepth = 2.5\n\tmaxTreeDepth = 2048\n',
          );

          // Act
          const result = await findLastInvalidMaxTreeDepth(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given core.maxTreeDepth = 2048 (line 2) then core.maxTreeDepth = 2.5 (line 3)', () => {
      describe('When findLastInvalidMaxTreeDepth', () => {
        it('Then returns the entry for 2.5 (only the last entry is validated)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/config`,
            '[core]\n\tmaxTreeDepth = 2048\n\tmaxTreeDepth = 2.5\n',
          );

          // Act
          const result = await findLastInvalidMaxTreeDepth(ctx);

          // Assert
          expect(result).not.toBeUndefined();
          expect(result?.key).toBe('core.maxtreedepth');
          expect(result?.value).toBe('2.5');
          expect(result?.reason).toBe('invalid unit');
        });
      });
    });

    describe('Given a valueless core.maxTreeDepth entry (no "=")', () => {
      describe('When findLastInvalidMaxTreeDepth', () => {
        it("Then returns an entry with value '' and reason invalid unit", async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth\n');

          // Act
          const result = await findLastInvalidMaxTreeDepth(ctx);

          // Assert
          expect(result?.value).toBe('');
          expect(result?.reason).toBe('invalid unit');
        });
      });
    });

    describe('Given an empty core.maxTreeDepth value ("maxTreeDepth =")', () => {
      describe('When findLastInvalidMaxTreeDepth', () => {
        it("Then returns an entry with value '' and reason invalid unit", async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth =\n');

          // Act
          const result = await findLastInvalidMaxTreeDepth(ctx);

          // Assert
          expect(result?.value).toBe('');
          expect(result?.reason).toBe('invalid unit');
        });
      });
    });

    describe('Given a mixed-case core.MaxTreeDepth key with an invalid value', () => {
      describe('When findLastInvalidMaxTreeDepth', () => {
        it('Then reports the qualified key all-lowercase', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tMaxTreeDepth = 2.5\n');

          // Act
          const result = await findLastInvalidMaxTreeDepth(ctx);

          // Assert
          expect(result?.key).toBe('core.maxtreedepth');
        });
      });
    });
  });

  describe('findFirstInvalidBoolean', () => {
    describe('Given two malformed boolean keys under [core]', () => {
      describe('When findFirstInvalidBoolean', () => {
        it('Then it returns the lower-line entry', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tsparseCheckout = maybe\n\tsparseCheckoutCone = also-bad\n');

          // Act
          const result = await findFirstInvalidBoolean(ctx, 'core', undefined, [
            'sparsecheckout',
            'sparsecheckoutcone',
          ]);

          // Assert
          expect(result?.key).toBe('core.sparsecheckout');
          expect(result?.value).toBe('maybe');
          expect(result?.line).toBe(2);
        });
      });
    });

    describe('Given a malformed key under [core] but the caller asks about [commit]', () => {
      describe('When findFirstInvalidBoolean', () => {
        it('Then it returns undefined (out of section)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tsparseCheckout = maybe\n');

          // Act
          const result = await findFirstInvalidBoolean(ctx, 'commit', undefined, ['gpgsign']);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a valid boolean value', () => {
      describe('When findFirstInvalidBoolean', () => {
        it('Then it returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tsparseCheckout = true\n');

          // Act
          const result = await findFirstInvalidBoolean(ctx, 'core', undefined, ['sparsecheckout']);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given the requested key is absent', () => {
      describe('When findFirstInvalidBoolean', () => {
        it('Then it returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tbare = true\n');

          // Act
          const result = await findFirstInvalidBoolean(ctx, 'core', undefined, ['sparsecheckout']);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a malformed key under an explicit subsection', () => {
      describe('When findFirstInvalidBoolean', () => {
        it('Then it returns the qualified key with the subsection verbatim', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[diff "MyDriver"]\n\tcachetextconv = maybe\n');

          // Act
          const result = await findFirstInvalidBoolean(ctx, 'diff', 'MyDriver', ['cachetextconv']);

          // Assert
          expect(result?.key).toBe('diff.MyDriver.cachetextconv');
        });
      });
    });
  });

  describe('findFirstInvalidBooleanInSection', () => {
    describe('Given [diff "a"] valid and [diff "MyDriver"] malformed cachetextconv', () => {
      describe('When findFirstInvalidBooleanInSection', () => {
        it('Then it returns the lower-line entry with the subsection kept verbatim', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[diff "a"]\n\tcachetextconv = true\n[diff "MyDriver"]\n\tcachetextconv = maybe\n',
          );

          // Act
          const result = await findFirstInvalidBooleanInSection(ctx, 'diff', ['cachetextconv']);

          // Assert
          expect(result?.key).toBe('diff.MyDriver.cachetextconv');
          expect(result?.value).toBe('maybe');
          expect(result?.line).toBe(4);
        });
      });
    });

    describe('Given a malformed key under a flat (no-subsection) section', () => {
      describe('When findFirstInvalidBooleanInSection', () => {
        it('Then the qualified key has no subsection segment', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[diff]\n\tcachetextconv = maybe\n');

          // Act
          const result = await findFirstInvalidBooleanInSection(ctx, 'diff', ['cachetextconv']);

          // Assert
          expect(result?.key).toBe('diff.cachetextconv');
        });
      });
    });

    describe('Given a malformed key under a non-matching section', () => {
      describe('When findFirstInvalidBooleanInSection', () => {
        it('Then it returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[other "x"]\n\tcachetextconv = maybe\n');

          // Act
          const result = await findFirstInvalidBooleanInSection(ctx, 'diff', ['cachetextconv']);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a malformed non-target key under a matching subsection', () => {
      describe('When findFirstInvalidBooleanInSection', () => {
        it('Then it returns undefined', async () => {
          // Arrange — `textconv` is not in the requested key set.
          const ctx = createMemoryContext();
          await seed(ctx, '[diff "a"]\n\ttextconv = maybe\n');

          // Act
          const result = await findFirstInvalidBooleanInSection(ctx, 'diff', ['cachetextconv']);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });
  });

  describe('findFirstInvalidLogAllRefUpdates', () => {
    describe('Given core.logAllRefUpdates holds a value that fails both the tri-state literal and the boolean grammar', () => {
      describe('When findFirstInvalidLogAllRefUpdates', () => {
        it('Then it returns the entry', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tlogAllRefUpdates = maybe\n');

          // Act
          const result = await findFirstInvalidLogAllRefUpdates(ctx);

          // Assert
          expect(result?.key).toBe('core.logallrefupdates');
          expect(result?.value).toBe('maybe');
          expect(result?.line).toBe(2);
        });
      });
    });

    describe('Given core.logAllRefUpdates holds the tri-state literal "always" (any case)', () => {
      describe('When findFirstInvalidLogAllRefUpdates', () => {
        it.each([
          { value: 'always', label: 'lower-case' },
          { value: 'Always', label: 'mixed-case' },
          { value: 'ALWAYS', label: 'upper-case' },
        ])('Then it returns undefined ($label)', async ({ value }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, `[core]\n\tlogAllRefUpdates = ${value}\n`);

          // Act
          const result = await findFirstInvalidLogAllRefUpdates(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given core.logAllRefUpdates holds a valid boolean value', () => {
      describe('When findFirstInvalidLogAllRefUpdates', () => {
        it('Then it returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tlogAllRefUpdates = true\n');

          // Act
          const result = await findFirstInvalidLogAllRefUpdates(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given core.logAllRefUpdates is valueless', () => {
      describe('When findFirstInvalidLogAllRefUpdates', () => {
        it('Then it returns undefined (valueless is boolean-true)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tlogAllRefUpdates\n');

          // Act
          const result = await findFirstInvalidLogAllRefUpdates(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given the key is absent', () => {
      describe('When findFirstInvalidLogAllRefUpdates', () => {
        it('Then it returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tbare = true\n');

          // Act
          const result = await findFirstInvalidLogAllRefUpdates(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a malformed value sits under a non-[core] section', () => {
      describe('When findFirstInvalidLogAllRefUpdates', () => {
        it('Then it returns undefined (out of section)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[other]\n\tlogAllRefUpdates = maybe\n');

          // Act
          const result = await findFirstInvalidLogAllRefUpdates(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });
  });

  describe('findFirstInvalidPushGpgSign', () => {
    describe('Given push.gpgSign holds a value that fails both the tri-state literal and the boolean grammar', () => {
      describe('When findFirstInvalidPushGpgSign', () => {
        it('Then it returns the entry', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[push]\n\tgpgSign = maybe\n');

          // Act
          const result = await findFirstInvalidPushGpgSign(ctx);

          // Assert
          expect(result?.key).toBe('push.gpgsign');
          expect(result?.value).toBe('maybe');
          expect(result?.line).toBe(2);
        });
      });
    });

    describe('Given push.gpgSign holds the tri-state literal "if-asked" (any case)', () => {
      describe('When findFirstInvalidPushGpgSign', () => {
        it.each([
          { value: 'if-asked', label: 'lower-case' },
          { value: 'If-Asked', label: 'mixed-case' },
          { value: 'IF-ASKED', label: 'upper-case' },
        ])('Then it returns undefined ($label)', async ({ value }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, `[push]\n\tgpgSign = ${value}\n`);

          // Act
          const result = await findFirstInvalidPushGpgSign(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given push.gpgSign holds a valid boolean value', () => {
      describe('When findFirstInvalidPushGpgSign', () => {
        it('Then it returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[push]\n\tgpgSign = true\n');

          // Act
          const result = await findFirstInvalidPushGpgSign(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given push.gpgSign is valueless', () => {
      describe('When findFirstInvalidPushGpgSign', () => {
        it('Then it returns undefined (valueless is boolean-true)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[push]\n\tgpgSign\n');

          // Act
          const result = await findFirstInvalidPushGpgSign(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given the key is absent', () => {
      describe('When findFirstInvalidPushGpgSign', () => {
        it('Then it returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[push]\n\tdefault = simple\n');

          // Act
          const result = await findFirstInvalidPushGpgSign(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a malformed value sits under a non-[push] section', () => {
      describe('When findFirstInvalidPushGpgSign', () => {
        it('Then it returns undefined (out of section)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[other]\n\tgpgSign = maybe\n');

          // Act
          const result = await findFirstInvalidPushGpgSign(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });
  });

  describe('Given [commit] gpgsign = true', () => {
    describe('When readConfig', () => {
      it('Then commit.gpgSign is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[commit]\n  gpgsign = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.commit?.gpgSign).toBe(true);
      });
    });
  });

  describe('Given [commit] with only a non-gpgsign key', () => {
    describe('When readConfig', () => {
      it('Then commit config stays undefined (only gpgsign populates it)', async () => {
        // Arrange — `template` is not gpgsign, so the commit sub-map must never be created.
        const ctx = createMemoryContext();
        await seed(ctx, '[commit]\n  template = /path/to/tpl\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.commit).toBeUndefined();
      });
    });
  });

  describe('Given [commit] gpgsign = false', () => {
    describe('When readConfig', () => {
      it('Then commit.gpgSign is false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[commit]\n  gpgsign = false\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.commit?.gpgSign).toBe(false);
      });
    });
  });

  describe('Given [tag] gpgSign = true', () => {
    describe('When readConfig', () => {
      it('Then tag.gpgSign is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[tag]\n  gpgSign = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.tag?.gpgSign).toBe(true);
      });
    });
  });

  describe('Given [tag] with only a non-gpgsign key', () => {
    describe('When readConfig', () => {
      it('Then tag config stays undefined (only gpgsign populates it)', async () => {
        // Arrange — `sort` is not gpgsign, so the tag sub-map must never be created.
        const ctx = createMemoryContext();
        await seed(ctx, '[tag]\n  sort = version:refname\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.tag).toBeUndefined();
      });
    });
  });

  describe('Given [pack] writeReverseIndex = true', () => {
    describe('When readConfig', () => {
      it('Then pack.writeReverseIndex is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[pack]\n  writeReverseIndex = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.pack?.writeReverseIndex).toBe(true);
      });
    });
  });

  describe('Given [pack] writeReverseIndex = false', () => {
    describe('When readConfig', () => {
      it('Then pack.writeReverseIndex is false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[pack]\n  writeReverseIndex = false\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.pack?.writeReverseIndex).toBe(false);
      });
    });
  });

  describe('Given [pack] writeReverseIndex is valueless', () => {
    describe('When readConfig', () => {
      it('Then pack.writeReverseIndex is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[pack]\n  writeReverseIndex\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.pack?.writeReverseIndex).toBe(true);
      });
    });
  });

  describe('Given [pack] writeReverseIndex in mixed case', () => {
    describe('When readConfig', () => {
      it('Then the key is still matched and parsed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[pack]\n  WriteReverseIndex = true\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.pack?.writeReverseIndex).toBe(true);
      });
    });
  });

  describe('Given [pack] writeReverseIndex = 2', () => {
    describe('When readConfig', () => {
      it("Then pack.writeReverseIndex is true (git's integer arm: non-zero is true)", async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[pack]\n  writeReverseIndex = 2\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.pack?.writeReverseIndex).toBe(true);
      });
    });
  });

  describe('Given [pack] writeReverseIndex = 0', () => {
    describe('When readConfig', () => {
      it('Then pack.writeReverseIndex is false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[pack]\n  writeReverseIndex = 0\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.pack?.writeReverseIndex).toBe(false);
      });
    });
  });

  describe('Given no [pack] section', () => {
    describe('When readConfig', () => {
      it('Then config.pack is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = false\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.pack).toBeUndefined();
      });
    });
  });

  describe('Given a [pack] section with an unrelated key (not writeReverseIndex)', () => {
    describe('When readConfig', () => {
      it('Then config.pack is undefined — the key guard only matches writeReverseIndex', async () => {
        // Arrange — an always-true key guard would wrongly boolean-parse this
        // unrelated (but real git) pack.* key and populate pack.writeReverseIndex.
        const ctx = createMemoryContext();
        await seed(ctx, '[pack]\n  threads = 4\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.pack).toBeUndefined();
      });
    });
  });

  describe('Given a config with a [push] gpgSign value', () => {
    describe('When readConfig', () => {
      it.each([
        { value: 'true', label: "push.gpgSign is 'true'" },
        { value: 'false', label: "push.gpgSign is 'false'" },
        { value: 'if-asked', label: "push.gpgSign is 'if-asked'" },
      ])('Then $label', async ({ value }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, `[push]\n  gpgSign = ${value}\n`);

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.push?.gpgSign).toBe(value);
      });
    });
  });

  describe('Given a config with a [push] default value, When readConfig', () => {
    it.each([
      {
        config: '[push]\n  default = nothing\n',
        expected: 'nothing',
        label: "push.default is 'nothing'",
      },
      {
        config: '[push]\n  default = current\n',
        expected: 'current',
        label: "push.default is 'current'",
      },
      {
        config: '[push]\n  default = upstream\n',
        expected: 'upstream',
        label: "push.default is 'upstream'",
      },
      {
        config: '[push]\n  default = simple\n',
        expected: 'simple',
        label: "push.default is 'simple'",
      },
      {
        config: '[push]\n  default = matching\n',
        expected: 'matching',
        label: "push.default is 'matching'",
      },
      {
        config: '[push]\n  default = tracking\n',
        expected: 'upstream',
        label: "push.default is canonicalized to 'upstream' (deprecated alias)",
      },
      {
        config: '[push]\n  Default = simple\n',
        expected: 'simple',
        label: 'the Default key is matched case-insensitively',
      },
    ])('Then $label', async ({ config, expected }) => {
      // Arrange — git config keys are case-insensitive, so `Default` folds to `default`;
      // value matching stays case-sensitive (see the `Simple` (wrong case) test below).
      const ctx = createMemoryContext();
      await seed(ctx, config);

      // Act
      const result = await readConfig(ctx);

      // Assert
      expect(result.push?.default).toBe(expected);
    });
  });

  describe('Given a config with a [push] section that does not set a valid default, When readConfig', () => {
    it.each([
      {
        config: '[push]\n  default = Simple\n',
        label: 'push.default stays undefined (case-sensitive match)',
      },
      {
        config: '[push]\n  default = bogus\n',
        label: 'push.default stays undefined (lenient parse)',
      },
      {
        config: '[push]\n  foo = simple\n',
        label: 'push.default stays undefined (only the `default` key is read)',
      },
      { config: '[push]\n  gpgSign = true\n', label: 'push.default is undefined' },
    ])('Then $label', async ({ config }) => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, config);

      // Act
      const result = await readConfig(ctx);

      // Assert
      expect(result.push?.default).toBeUndefined();
    });
  });

  describe('Given a config that findInvalidPushDefault accepts, When findInvalidPushDefault', () => {
    it.each([
      { config: '[user]\n  name = Bob\n', label: 'no [push] section' },
      { config: '[push]\n  default = simple\n', label: 'default = simple (valid)' },
      {
        config: '[push]\n  default = tracking\n',
        label: 'default = tracking (legacy alias for upstream)',
      },
      { config: '[push]\n  default\n', label: 'default is valueless (treated as absent)' },
      {
        config: '  default = bogus\n[push]\n  default = simple\n',
        label: 'a bogus default entry before any section header (not inside [push])',
      },
    ])('Then returns undefined ($label)', async ({ config }) => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, config);

      // Act
      const result = await findInvalidPushDefault(ctx);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given [push] default = bogus (unrecognized value)', () => {
    describe('When findInvalidPushDefault', () => {
      it('Then returns the raw value, source, and line', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n  name = Bob\n[push]\n  default = bogus\n');

        // Act
        const result = await findInvalidPushDefault(ctx);

        // Assert
        expect(result?.key).toBe('push.default');
        expect(result?.value).toBe('bogus');
        expect(result?.line).toBe(4);
        expect(result?.source).toBe(`${ctx.layout.gitDir}/config`);
      });
    });
  });

  describe('Given [push] default = Simple (wrong case is invalid)', () => {
    describe('When findInvalidPushDefault', () => {
      it('Then returns the entry (case-sensitive match)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[push]\n  default = Simple\n');

        // Act
        const result = await findInvalidPushDefault(ctx);

        // Assert
        expect(result?.value).toBe('Simple');
      });
    });
  });

  describe('Given a valid default followed by an invalid one in the same [push] section', () => {
    describe('When findInvalidPushDefault', () => {
      it('Then returns the FIRST invalid entry, ignoring the earlier valid one', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[push]\n  default = current\n  default = bogus\n');

        // Act
        const result = await findInvalidPushDefault(ctx);

        // Assert
        expect(result?.value).toBe('bogus');
        expect(result?.line).toBe(3);
      });
    });
  });

  describe('Given a config with a [gpg] format value, When readConfig', () => {
    it.each([
      { value: 'openpgp', label: "gpg.format is 'openpgp'" },
      { value: 'ssh', label: "gpg.format is 'ssh'" },
      { value: 'x509', label: "gpg.format is 'x509'" },
    ])('Then $label', async ({ value }) => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, `[gpg]\n  format = ${value}\n`);

      // Act
      const result = await readConfig(ctx);

      // Assert
      expect(result.gpg?.format).toBe(value);
    });
  });

  describe('Given [gpg] program = /usr/bin/gpg2', () => {
    describe('When readConfig', () => {
      it("Then gpg.program is '/usr/bin/gpg2'", async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[gpg]\n  program = /usr/bin/gpg2\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.gpg?.program).toBe('/usr/bin/gpg2');
      });
    });
  });

  describe('Given [gpg "ssh"] program = /usr/bin/ssh-keygen', () => {
    describe('When readConfig', () => {
      it("Then gpg.ssh.program is '/usr/bin/ssh-keygen'", async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[gpg "ssh"]\n  program = /usr/bin/ssh-keygen\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.gpg?.ssh?.program).toBe('/usr/bin/ssh-keygen');
      });
    });
  });

  describe('Given a config that does not populate [gpg], When readConfig', () => {
    it.each([
      {
        config: '[unknown]\n  format = ssh\n',
        label: 'gpg stays undefined (only the [gpg] section feeds gpg)',
      },
      {
        config: '[gpg]\n  minTrustLevel = marginal\n',
        label: 'gpg is undefined (an unrelated key sets neither format nor program)',
      },
      {
        config: '[gpg]\n  format = bogus\n',
        label: 'gpg is undefined (an unrecognised format value is not stored)',
      },
      {
        config: '[foo "ssh"]\n  program = /usr/bin/ssh-keygen\n',
        label: 'gpg is undefined (a non-gpg "ssh" subsection is not routed to gpg.ssh)',
      },
      {
        config: '[gpg "not-ssh"]\n  program = /usr/bin/ssh-keygen\n',
        label: 'gpg is undefined (only the "ssh" gpg subsection is recognised)',
      },
      {
        config: '[gpg "ssh"]\n  unrelated = /usr/bin/ssh-keygen\n',
        label: 'gpg is undefined (a non-program key under gpg.ssh is not stored)',
      },
    ])('Then $label', async ({ config }) => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, config);

      // Act
      const result = await readConfig(ctx);

      // Assert
      expect(result.gpg).toBeUndefined();
    });
  });

  describe('Given a config with none of the signing keys', () => {
    describe('When readConfig', () => {
      it('Then commit/tag/push/gpg are all undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = false\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.commit).toBeUndefined();
        expect(result.tag).toBeUndefined();
        expect(result.push).toBeUndefined();
        expect(result.gpg).toBeUndefined();
      });
    });
  });

  describe('Given a boolean-typed config field with a value git refuses', () => {
    describe('When readConfig', () => {
      it('Then core.bare is absent, not false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\tbare = maybe\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.bare).toBeUndefined();
      });

      it('Then core.bare is true for an integer-true value (2)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\tbare = 2\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.bare).toBe(true);
      });

      it('Then push.gpgSign is absent, not a guessed default', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[push]\n\tgpgSign = maybe\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.push?.gpgSign).toBeUndefined();
      });

      it('Then core.logAllRefUpdates is absent for a malformed value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\tlogAllRefUpdates = maybe\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.logAllRefUpdates).toBeUndefined();
      });

      it("Then core.logAllRefUpdates still yields 'always' (pre-check ahead of the boolean parse)", async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\tlogAllRefUpdates = always\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.logAllRefUpdates).toBe('always');
      });
    });
  });

  describe('Given every remaining boolean-typed field set to a value git refuses', () => {
    describe('When readConfig', () => {
      it.each([
        {
          config: '[core]\n\tsparseCheckout = maybe\n',
          label: 'core.sparseCheckout',
          read: (result: Awaited<ReturnType<typeof readConfig>>) => result.core?.sparseCheckout,
        },
        {
          config: '[core]\n\tsparseCheckoutCone = maybe\n',
          label: 'core.sparseCheckoutCone',
          read: (result: Awaited<ReturnType<typeof readConfig>>) => result.core?.sparseCheckoutCone,
        },
        {
          config: '[remote "origin"]\n\turl = u\n\tpromisor = maybe\n',
          label: 'remote.<n>.promisor',
          read: (result: Awaited<ReturnType<typeof readConfig>>) =>
            result.remote?.get('origin')?.promisor,
        },
        {
          config: '[submodule "libs/a"]\n\tactive = maybe\n',
          label: 'submodule.<n>.active',
          read: (result: Awaited<ReturnType<typeof readConfig>>) =>
            result.submodule?.get('libs/a')?.active,
        },
        {
          config: '[diff "upper"]\n\tcachetextconv = maybe\n',
          label: 'diff.<d>.cachetextconv',
          read: (result: Awaited<ReturnType<typeof readConfig>>) =>
            result.diff?.get('upper')?.cachetextconv,
        },
        {
          config: '[filter "f"]\n\trequired = maybe\n',
          label: 'filter.<d>.required',
          read: (result: Awaited<ReturnType<typeof readConfig>>) =>
            result.filter?.get('f')?.required,
        },
        {
          config: '[commit]\n\tgpgSign = maybe\n',
          label: 'commit.gpgSign',
          read: (result: Awaited<ReturnType<typeof readConfig>>) => result.commit?.gpgSign,
        },
        {
          config: '[tag]\n\tgpgSign = maybe\n',
          label: 'tag.gpgSign',
          read: (result: Awaited<ReturnType<typeof readConfig>>) => result.tag?.gpgSign,
        },
        {
          config: '[pack]\n\twriteReverseIndex = maybe\n',
          label: 'pack.writeReverseIndex (the whole pack bucket stays absent)',
          read: (result: Awaited<ReturnType<typeof readConfig>>) => result.pack,
        },
      ])('Then $label is absent, not a guessed default', async ({ config, read }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, config);

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(read(result)).toBeUndefined();
      });
    });
  });
});
