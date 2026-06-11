import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  configGet,
  configGetAll,
  configGetRegexp,
  configList,
  configRemoveSection,
  configRenameSection,
  configSet,
  configUnset,
  configUnsetAll,
} from '../../../../src/application/commands/config.js';
import type { TsgitError } from '../../../../src/domain/error.js';

const u8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const repoCtx = () => {
  const ctx = createMemoryContext({
    files: { '/repo/.git/HEAD': u8('ref: refs/heads/main\n') },
  });
  return ctx;
};

describe('configGet', () => {
  describe('Given user.name=Ada in local, When configGet({ key: user.name }) runs', () => {
    it('Then it returns { key, value: Ada, scope: local }', async () => {
      // Arrange
      const ctx = repoCtx();
      await configSet(ctx, { key: 'user.name', value: 'Ada' });

      // Act
      const sut = await configGet(ctx, { key: 'user.name' });

      // Assert
      expect(sut).toEqual({ key: 'user.name', value: 'Ada', scope: 'local' });
    });
  });

  describe('Given the key absent, When configGet runs', () => {
    it('Then it returns { key, value: undefined }', async () => {
      // Arrange
      const ctx = repoCtx();

      // Act
      const sut = await configGet(ctx, { key: 'user.name' });

      // Assert
      expect(sut).toEqual({ key: 'user.name', value: undefined });
    });
  });
});

describe('configGetAll', () => {
  describe('Given three fetch lines, When configGetAll runs', () => {
    it('Then values has length 3', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        '[remote "origin"]\n\tfetch = a\n\tfetch = b\n\tfetch = c\n',
      );

      // Act
      const sut = await configGetAll(ctx, { key: 'remote.origin.fetch' });

      // Assert
      expect(sut.values.map((v) => v.value)).toEqual(['a', 'b', 'c']);
    });
  });
});

describe('configGetRegexp', () => {
  describe('Given a keyPattern matching remote.*.url, When configGetRegexp runs', () => {
    it('Then only matching entries are returned', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        '[remote "origin"]\n\turl = a\n\tfetch = z\n[user]\n\tname = bob\n',
      );

      // Act
      const sut = await configGetRegexp(ctx, { keyPattern: /^remote\..*\.url$/ });

      // Assert
      expect(sut.entries).toEqual([{ key: 'remote.origin.url', value: 'a', scope: 'local' }]);
    });
  });
});

describe('configList', () => {
  describe('Given two entries in local, When configList runs', () => {
    it('Then both entries are returned tagged with local', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        '[user]\n\tname = Ada\n\temail = a@x\n',
      );

      // Act
      const sut = await configList(ctx);

      // Assert
      expect(sut.entries).toEqual([
        { key: 'user.name', value: 'Ada', scope: 'local' },
        { key: 'user.email', value: 'a@x', scope: 'local' },
      ]);
    });
  });

  describe('Given a valueless entry in local, When configList runs', () => {
    it('Then the entry is returned with value: null', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        '[core]\n\tbare\n\trepositoryformatversion = 0\n',
      );

      // Act
      const sut = await configList(ctx);

      // Assert
      expect(sut.entries).toEqual([
        { key: 'core.bare', value: null, scope: 'local' },
        { key: 'core.repositoryformatversion', value: '0', scope: 'local' },
      ]);
    });
  });
});

describe('configGetRegexp — valueless key behaviour', () => {
  describe('Given a valueless entry matching the key pattern, When configGetRegexp runs', () => {
    it('Then the entry is returned with value: null', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbare\n');

      // Act
      const sut = await configGetRegexp(ctx, { keyPattern: /^core\.bare$/ });

      // Assert
      expect(sut.entries).toEqual([{ key: 'core.bare', value: null, scope: 'local' }]);
    });
  });

  describe('Given a valueless entry and valuePattern /^$/, When configGetRegexp runs', () => {
    it('Then the entry matches (NULL matches as the empty string)', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbare\n');

      // Act
      const sut = await configGetRegexp(ctx, { keyPattern: /^core\.bare$/, valuePattern: /^$/ });

      // Assert
      expect(sut.entries).toHaveLength(1);
      expect(sut.entries[0]).toEqual({ key: 'core.bare', value: null, scope: 'local' });
    });
  });

  describe('Given a valueless entry and valuePattern /val/, When configGetRegexp runs', () => {
    it('Then no entries are returned (NULL does not match a non-empty pattern)', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbare\n');

      // Act
      const sut = await configGetRegexp(ctx, { keyPattern: /^core\.bare$/, valuePattern: /val/ });

      // Assert
      expect(sut.entries).toHaveLength(0);
    });
  });
});

describe('configGet — valueless key multiplicity', () => {
  describe('Given one valued and one valueless occurrence of the same key, When configGet runs', () => {
    it('Then throws CONFIG_MULTIPLE_VALUES with count 2 (valueless counts)', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbare = false\n\tbare\n');
      let caught: TsgitError | undefined;

      // Act
      try {
        await configGet(ctx, { key: 'core.bare' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'CONFIG_MULTIPLE_VALUES',
        key: 'core.bare',
        count: 2,
        requested: 'read',
        scope: undefined,
      });
    });
  });
});

describe('configSet', () => {
  describe('Given a fresh repo, When configSet runs', () => {
    it('Then the result has the new value and scope local', async () => {
      // Arrange
      const ctx = repoCtx();

      // Act
      const sut = await configSet(ctx, { key: 'user.email', value: 'me@x.com' });

      // Assert
      expect(sut).toEqual({ key: 'user.email', value: 'me@x.com', scope: 'local' });
    });
  });

  describe('Given a multi-valued key, When configSet runs', () => {
    it('Then it throws CONFIG_MULTIPLE_VALUES with requested=overwrite', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname = Ada\n\tname = Bob\n');
      let caught: TsgitError | undefined;

      // Act
      try {
        await configSet(ctx, { key: 'user.name', value: 'Cara' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'CONFIG_MULTIPLE_VALUES',
        key: 'user.name',
        count: 2,
        requested: 'overwrite',
        scope: 'local',
      });
    });
  });

  describe('Given a valueless occurrence mixed with a valued occurrence, When configSet runs', () => {
    it('Then it throws CONFIG_MULTIPLE_VALUES (valueless occurrences are counted)', async () => {
      // Arrange — one valueless + one valued = count 2; multiplicity guard must fire.
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname\n\tname = Ada\n');
      let caught: TsgitError | undefined;

      // Act
      try {
        await configSet(ctx, { key: 'user.name', value: 'Bob' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'CONFIG_MULTIPLE_VALUES',
        key: 'user.name',
        count: 2,
        requested: 'overwrite',
        scope: 'local',
      });
    });
  });
});

describe('configUnset', () => {
  describe('Given the key present, When configUnset runs', () => {
    it('Then the result has removed=true and the previousValue', async () => {
      // Arrange
      const ctx = repoCtx();
      await configSet(ctx, { key: 'user.name', value: 'Ada' });

      // Act
      const sut = await configUnset(ctx, { key: 'user.name' });

      // Assert
      expect(sut).toEqual({
        key: 'user.name',
        scope: 'local',
        removed: true,
        previousValue: 'Ada',
      });
    });
  });

  describe('Given the key absent, When configUnset runs', () => {
    it('Then the result has removed=false and no previousValue', async () => {
      // Arrange
      const ctx = repoCtx();

      // Act
      const sut = await configUnset(ctx, { key: 'user.name' });

      // Assert
      expect(sut).toEqual({ key: 'user.name', scope: 'local', removed: false });
      expect(sut).not.toHaveProperty('previousValue');
    });
  });

  describe('Given a valueless entry, When configUnset runs', () => {
    it('Then it returns removed=true with previousValue null', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname\n');

      // Act
      const sut = await configUnset(ctx, { key: 'user.name' });

      // Assert
      expect(sut).toEqual({
        key: 'user.name',
        scope: 'local',
        removed: true,
        previousValue: null,
      });
    });
  });
});

describe('configUnsetAll', () => {
  describe('Given the key appearing three times, When configUnsetAll runs', () => {
    it('Then result.removed equals 3 and the file no longer contains the key', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        '[remote "origin"]\n\tfetch = a\n\tfetch = b\n\tfetch = c\n',
      );

      // Act
      const sut = await configUnsetAll(ctx, { key: 'remote.origin.fetch' });

      // Assert
      expect(sut.removed).toBe(3);
      const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
      expect(text).not.toContain('fetch =');
    });
  });
});

describe('configRenameSection', () => {
  describe('Given [remote "origin"] present, When configRenameSection runs', () => {
    it('Then the result echoes the rename and the section header is rewritten', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[remote "origin"]\n\turl = x\n');

      // Act
      const sut = await configRenameSection(ctx, {
        oldName: 'remote.origin',
        newName: 'remote.upstream',
      });

      // Assert
      expect(sut).toEqual({
        oldName: 'remote.origin',
        newName: 'remote.upstream',
        scope: 'local',
      });
    });
  });
});

describe('configRemoveSection', () => {
  describe('Given the section present, When configRemoveSection runs', () => {
    it('Then the result echoes the name and scope', async () => {
      // Arrange
      const ctx = repoCtx();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[remote "origin"]\n\turl = x\n');

      // Act
      const sut = await configRemoveSection(ctx, { name: 'remote.origin' });

      // Assert
      expect(sut).toEqual({ name: 'remote.origin', scope: 'local' });
    });
  });
});
