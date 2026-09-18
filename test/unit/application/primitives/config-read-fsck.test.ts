/**
 * The `[fsck]` half of the configuration read: the `fsck.<msg-id>` severity
 * table. Every expectation below was measured against git 2.55.0 by offering
 * the same configuration to `git fsck`.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  readFsckSeverityTable,
  readFsckSkipListPaths,
} from '../../../../src/application/primitives/config-read.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Context } from '../../../../src/ports/context.js';

const sut = readFsckSeverityTable;

const seed = async (ctx: Context, content: string): Promise<Context> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
  return ctx;
};

describe('Given a [fsck] section re-typing one msg-id', () => {
  describe('When the severity table is read', () => {
    it('Then it holds that msg-id alone, lower-cased, at the configured severity', async () => {
      // Arrange
      const ctx = await seed(createMemoryContext(), '[fsck]\n  badTree = ignore\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect([...result]).toEqual([['badTree'.toLowerCase(), 'ignore']]);
    });
  });
});

describe('Given a [fsck] re-typing spelled warn', () => {
  describe('When the severity table is read', () => {
    it('Then it is stored under this repository own warning name', async () => {
      // Arrange
      const ctx = await seed(createMemoryContext(), '[fsck]\n  nulInCommit = warn\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect([...result]).toEqual([['nulInCommit'.toLowerCase(), 'warning']]);
    });
  });
});

describe('Given a msg-id offered in a case the catalogue does not use', () => {
  describe('When the severity table is read', () => {
    it('Then the key is folded down, so a lookup on the catalogue spelling finds it', async () => {
      // Arrange
      const ctx = await seed(createMemoryContext(), '[fsck]\n  ZEROpaddedFILEmode = error\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect([...result]).toEqual([['zeroPaddedFilemode'.toLowerCase(), 'error']]);
    });
  });
});

describe('Given the same msg-id re-typed twice in one section', () => {
  describe('When the severity table is read', () => {
    it('Then the last entry in file order wins', async () => {
      // Arrange
      const ctx = await seed(
        createMemoryContext(),
        '[fsck]\n  badTree = ignore\n  badTree = warn\n',
      );

      // Act
      const result = await sut(ctx);

      // Assert
      expect([...result]).toEqual([['badTree'.toLowerCase(), 'warning']]);
    });
  });
});

describe('Given fsck.skipList sitting beside a re-typing in the same section', () => {
  describe('When the severity table is read', () => {
    it('Then the list key is passed over rather than graded as a msg-id', async () => {
      // Arrange
      const ctx = await seed(
        createMemoryContext(),
        '[fsck]\n  skipList = /names.txt\n  badTree = ignore\n',
      );

      // Act
      const result = await sut(ctx);

      // Assert
      expect([...result]).toEqual([['badTree'.toLowerCase(), 'ignore']]);
    });
  });
});

describe('Given a msg-id-shaped key under a section that is not [fsck]', () => {
  describe('When the severity table is read', () => {
    it('Then the table stays empty', async () => {
      // Arrange
      const ctx = await seed(createMemoryContext(), '[core]\n  badTree = ignore\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect([...result]).toEqual([]);
    });
  });
});

describe('Given a [fsck] section closed by a later section carrying a msg-id-shaped key', () => {
  describe('When the severity table is read', () => {
    it('Then only the key inside [fsck] is taken', async () => {
      // Arrange
      const ctx = await seed(
        createMemoryContext(),
        '[fsck]\n  badTree = ignore\n[core]\n  nulInCommit = error\n',
      );

      // Act
      const result = await sut(ctx);

      // Assert
      expect([...result]).toEqual([['badTree'.toLowerCase(), 'ignore']]);
    });
  });
});

describe('Given a [fsck] section padded with comments and blank lines', () => {
  describe('When the severity table is read', () => {
    it('Then the padding is passed over and the re-typing still lands', async () => {
      // Arrange
      const ctx = await seed(
        createMemoryContext(),
        '[fsck]\n# a note\n\n  badTree = ignore\n; another note\n\n',
      );

      // Act
      const result = await sut(ctx);

      // Assert
      expect([...result]).toEqual([['badTree'.toLowerCase(), 'ignore']]);
    });
  });
});

describe('Given no [fsck] section at all', () => {
  describe('When the severity table is read', () => {
    it('Then the table is empty, so every msg-id keeps its catalogue default', async () => {
      // Arrange
      const ctx = await seed(createMemoryContext(), '[core]\n  bare = false\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect([...result]).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Refusals — every one of them kills the audit before an object is read
// ---------------------------------------------------------------------------

const caughtFrom = async (read: () => Promise<unknown>): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await read();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  return caught as TsgitError;
};

describe('Given a msg-id written with no value at all', () => {
  describe('When the severity table is read', () => {
    it('Then it refuses the valueless key, naming the key and the line it sits on', async () => {
      // Arrange
      const ctx = await seed(createMemoryContext(), '[core]\n[fsck]\n  badTree\n');

      // Act
      const caught = await caughtFrom(() => sut(ctx));

      // Assert
      expect(caught.data).toEqual({
        code: 'CONFIG_MISSING_VALUE',
        key: `fsck.${'badTree'.toLowerCase()}`,
        source: `${ctx.layout.gitDir}/config`,
        line: 3,
      });
    });
  });
});

describe('Given a valueless key no fsck check knows', () => {
  describe('When the severity table is read', () => {
    it('Then the missing value is named before the id is graded', async () => {
      // Arrange
      const ctx = await seed(createMemoryContext(), '[fsck]\n  noSuchThing\n');

      // Act
      const caught = await caughtFrom(() => sut(ctx));

      // Assert
      expect(caught.data).toEqual({
        code: 'CONFIG_MISSING_VALUE',
        key: `fsck.${'noSuchThing'.toLowerCase()}`,
        source: `${ctx.layout.gitDir}/config`,
        line: 2,
      });
    });
  });
});

describe('Given a valueless key naming a msg-id that may never be demoted', () => {
  describe('When the severity table is read', () => {
    it('Then the missing value is named before the demotion is graded', async () => {
      // Arrange
      const ctx = await seed(createMemoryContext(), '[fsck]\n  nulInHeader\n');

      // Act
      const caught = await caughtFrom(() => sut(ctx));

      // Assert
      expect(caught.data).toEqual({
        code: 'CONFIG_MISSING_VALUE',
        key: `fsck.${'nulInHeader'.toLowerCase()}`,
        source: `${ctx.layout.gitDir}/config`,
        line: 2,
      });
    });
  });
});

describe('Given a msg-id whose value is present but empty', () => {
  describe('When the severity table is read', () => {
    it('Then it is graded as a severity word rather than as a missing value', async () => {
      // Arrange
      const ctx = await seed(createMemoryContext(), '[fsck]\n  badTree =\n');

      // Act
      const caught = await caughtFrom(() => sut(ctx));

      // Assert
      expect(caught.data).toEqual({
        code: 'CONFIG_INVALID_ENUM_VALUE',
        key: `fsck.${'badTree'.toLowerCase()}`,
        source: `${ctx.layout.gitDir}/config`,
        value: '',
        line: 2,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// fsck.skipList — the key accumulates rather than replaces
// ---------------------------------------------------------------------------

describe('Given no fsck.skipList anywhere in the configuration', () => {
  describe('When the configured list paths are read', () => {
    it('Then no path is named', async () => {
      // Arrange
      const ctx = await seed(createMemoryContext(), '[fsck]\n  badTree = ignore\n');

      // Act
      const result = await readFsckSkipListPaths(ctx);

      // Assert
      expect(result).toEqual([]);
    });
  });
});

describe('Given one fsck.skipList entry', () => {
  describe('When the configured list paths are read', () => {
    it('Then that one path is named', async () => {
      // Arrange
      const ctx = await seed(createMemoryContext(), '[fsck]\n  skipList = /names.txt\n');

      // Act
      const result = await readFsckSkipListPaths(ctx);

      // Assert
      expect(result).toEqual(['/names.txt']);
    });
  });
});

describe('Given fsck.skipList written twice', () => {
  describe('When the configured list paths are read', () => {
    it('Then both paths are named, in file order — the later never replaces the earlier', async () => {
      // Arrange
      const ctx = await seed(
        createMemoryContext(),
        '[fsck]\n  skipList = /first.txt\n  skipList = /second.txt\n',
      );

      // Act
      const result = await readFsckSkipListPaths(ctx);

      // Assert
      expect(result).toEqual(['/first.txt', '/second.txt']);
    });
  });
});

describe('Given a valueless fsck.skipList sitting after a usable one', () => {
  describe('When the configured list paths are read', () => {
    it('Then it refuses at the valueless line rather than keeping the usable path', async () => {
      // Arrange
      const ctx = await seed(
        createMemoryContext(),
        '[fsck]\n  skipList = /first.txt\n  skipList\n',
      );

      // Act
      const caught = await caughtFrom(() => readFsckSkipListPaths(ctx));

      // Assert
      expect(caught.data).toEqual({
        code: 'CONFIG_MISSING_VALUE',
        key: `fsck.${'skipList'.toLowerCase()}`,
        source: `${ctx.layout.gitDir}/config`,
        line: 3,
      });
    });
  });
});
