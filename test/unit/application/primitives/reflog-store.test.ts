import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  appendReflog,
  deleteReflog,
  listReflogs,
  readReflog,
  reflogExists,
  writeReflog,
} from '../../../../src/application/primitives/reflog-store.js';
import { MAX_REFLOG_BYTES } from '../../../../src/application/primitives/types.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { ZERO_OID } from '../../../../src/domain/objects/index.js';
import type { ReflogEntry } from '../../../../src/domain/reflog/index.js';
import { serializeReflogLine } from '../../../../src/domain/reflog/index.js';

const OID_A = 'a'.repeat(40) as ObjectId;
const OID_B = 'b'.repeat(40) as ObjectId;
const HEAD = 'HEAD' as RefName;
const BRANCH = 'refs/heads/main' as RefName;

const IDENTITY: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1716240000,
  timezoneOffset: '+0000',
};

const entry = (overrides: Partial<ReflogEntry> = {}): ReflogEntry => ({
  oldId: ZERO_OID,
  newId: OID_A,
  identity: IDENTITY,
  message: 'commit (initial): seed',
  ...overrides,
});

describe('reflog-store', () => {
  describe('appendReflog', () => {
    it('Given a missing reflog, When appendReflog, Then the .git/logs file is created with the line', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = entry();

      // Act
      await appendReflog(ctx, HEAD, sut);

      // Assert
      const raw = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/HEAD`);
      expect(raw).toBe(serializeReflogLine(sut));
    });

    it('Given an existing reflog, When appendReflog, Then the new line is appended after the old', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const first = entry();
      const second = entry({ oldId: OID_A, newId: OID_B, message: 'commit: second' });

      // Act
      await appendReflog(ctx, HEAD, first);
      await appendReflog(ctx, HEAD, second);

      // Assert
      const entries = await readReflog(ctx, HEAD);
      expect(entries).toEqual([first, second]);
    });
  });

  describe('readReflog', () => {
    it('Given a missing reflog file, When readReflog, Then returns an empty array', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      const result = await readReflog(ctx, HEAD);

      // Assert
      expect(result).toEqual([]);
    });

    it('Given an appended entry, When readReflog, Then returns it parsed', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = entry();
      await appendReflog(ctx, BRANCH, sut);

      // Act
      const result = await readReflog(ctx, BRANCH);

      // Assert
      expect(result).toEqual([sut]);
    });

    it('Given a reflog file larger than MAX_REFLOG_BYTES, When readReflog, Then throws INVALID_REFLOG_ENTRY', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const oversized = 'x'.repeat(MAX_REFLOG_BYTES + 1);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/HEAD`, oversized);

      // Act
      try {
        await readReflog(ctx, HEAD);
        expect.fail('expected INVALID_REFLOG_ENTRY');
      } catch (err) {
        // Assert
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data.code).toBe('INVALID_REFLOG_ENTRY');
      }
    });
  });

  describe('reflogExists', () => {
    it('Given no reflog file, When reflogExists, Then returns false', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act & Assert
      expect(await reflogExists(ctx, HEAD)).toBe(false);
    });

    it('Given an appended reflog, When reflogExists, Then returns true', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await appendReflog(ctx, HEAD, entry());

      // Act & Assert
      expect(await reflogExists(ctx, HEAD)).toBe(true);
    });
  });

  describe('writeReflog', () => {
    it('Given an existing reflog, When writeReflog with fewer entries, Then the file is fully replaced', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await appendReflog(ctx, HEAD, entry());
      await appendReflog(ctx, HEAD, entry({ oldId: OID_A, newId: OID_B, message: 'second' }));
      const survivor = entry({ message: 'kept' });

      // Act
      await writeReflog(ctx, HEAD, [survivor]);

      // Assert
      expect(await readReflog(ctx, HEAD)).toEqual([survivor]);
    });

    it('Given an empty entry list, When writeReflog, Then the file holds no entries', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await appendReflog(ctx, HEAD, entry());

      // Act
      await writeReflog(ctx, HEAD, []);

      // Assert
      expect(await readReflog(ctx, HEAD)).toEqual([]);
    });
  });

  describe('deleteReflog', () => {
    it('Given an existing reflog, When deleteReflog, Then the file is removed', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await appendReflog(ctx, HEAD, entry());

      // Act
      await deleteReflog(ctx, HEAD);

      // Assert
      expect(await reflogExists(ctx, HEAD)).toBe(false);
    });

    it('Given a missing reflog, When deleteReflog, Then it is a no-op (does not throw)', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act & Assert — must not throw.
      await deleteReflog(ctx, HEAD);
      expect(await reflogExists(ctx, HEAD)).toBe(false);
    });
  });

  describe('listReflogs', () => {
    it('Given no logs directory, When listReflogs, Then returns an empty array', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      const result = await listReflogs(ctx);

      // Assert
      expect(result).toEqual([]);
    });

    it('Given reflogs at several depths, When listReflogs, Then returns every ref path relative to logs/', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await appendReflog(ctx, HEAD, entry());
      await appendReflog(ctx, BRANCH, entry());
      await appendReflog(ctx, 'refs/remotes/origin/main' as RefName, entry());

      // Act
      const result = await listReflogs(ctx);

      // Assert
      expect([...result].sort()).toEqual(
        ['HEAD', 'refs/heads/main', 'refs/remotes/origin/main'].sort(),
      );
    });
  });
});
