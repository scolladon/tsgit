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

// Build one syntactically valid reflog line whose serialized length is
// exactly `bytes`, by padding the message. ASCII-only, so byte length equals
// string length. A non-empty line frames the message with `<meta>\t…\n`, so the
// fixed framing is the empty-message length (`<meta>\n`) plus the one TAB a
// non-empty message adds.
const lineOfSize = (bytes: number): string => {
  const framing = serializeReflogLine(entry({ message: '' })).length + 1;
  return serializeReflogLine(entry({ message: 'x'.repeat(bytes - framing) }));
};

describe('reflog-store', () => {
  describe('appendReflog', () => {
    describe('Given a missing reflog', () => {
      describe('When appendReflog', () => {
        it('Then the .git/logs file is created with the line', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const sut = entry();

          // Act
          await appendReflog(ctx, HEAD, sut);

          // Assert
          const raw = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/HEAD`);
          expect(raw).toBe(serializeReflogLine(sut));
        });
      });
    });

    describe('Given an existing reflog', () => {
      describe('When appendReflog', () => {
        it('Then the new line is appended after the old', async () => {
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
    });
  });

  describe('readReflog', () => {
    describe('Given a missing reflog file', () => {
      describe('When readReflog', () => {
        it('Then returns an empty array', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given an appended entry', () => {
      describe('When readReflog', () => {
        it('Then returns it parsed', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const sut = entry();
          await appendReflog(ctx, BRANCH, sut);

          // Act
          const result = await readReflog(ctx, BRANCH);

          // Assert
          expect(result).toEqual([sut]);
        });
      });
    });

    describe('Given a reflog file larger than MAX_REFLOG_BYTES', () => {
      describe('When readReflog', () => {
        it('Then throws INVALID_REFLOG_ENTRY', async () => {
          // Arrange — a single, otherwise-valid line padded past the cap. Valid
          // content proves the size guard fires before parsing, not because the
          // bytes happen to be unparseable.
          const ctx = createMemoryContext();
          const padded = lineOfSize(MAX_REFLOG_BYTES + 1);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/HEAD`, padded);

          // Act
          try {
            await readReflog(ctx, HEAD);
            expect.fail('expected INVALID_REFLOG_ENTRY');
          } catch (err) {
            // Assert
            expect(err).toBeInstanceOf(TsgitError);
            expect((err as TsgitError).data).toEqual({
              code: 'INVALID_REFLOG_ENTRY',
              reason: `reflog file exceeds ${MAX_REFLOG_BYTES} bytes`,
            });
          }
        });
      });
    });

    describe('Given a reflog file of exactly MAX_REFLOG_BYTES', () => {
      describe('When readReflog', () => {
        it('Then it is accepted (boundary)', async () => {
          // Arrange — a file sized exactly at the cap must still parse; the guard
          // rejects only files strictly larger.
          const ctx = createMemoryContext();
          const atCap = lineOfSize(MAX_REFLOG_BYTES);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/HEAD`, atCap);

          // Act
          const result = await readReflog(ctx, HEAD);

          // Assert
          expect(result).toHaveLength(1);
        });
      });
    });
  });

  describe('reflogExists', () => {
    describe('Given no reflog file', () => {
      describe('When reflogExists', () => {
        it('Then returns false', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act & Assert
          expect(await reflogExists(ctx, HEAD)).toBe(false);
        });
      });
    });

    describe('Given an appended reflog', () => {
      describe('When reflogExists', () => {
        it('Then returns true', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await appendReflog(ctx, HEAD, entry());

          // Act & Assert
          expect(await reflogExists(ctx, HEAD)).toBe(true);
        });
      });
    });
  });

  describe('writeReflog', () => {
    describe('Given an existing reflog', () => {
      describe('When writeReflog with fewer entries', () => {
        it('Then the file is fully replaced', async () => {
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
      });
    });

    describe('Given several entries', () => {
      describe('When writeReflog', () => {
        it('Then each one round-trips back, oldest-first', async () => {
          // Arrange — a multi-entry write proves the lines are concatenated with no
          // separator between them.
          const ctx = createMemoryContext();
          const first = entry({ message: 'first' });
          const second = entry({ oldId: OID_A, newId: OID_B, message: 'second' });
          const third = entry({ oldId: OID_B, newId: OID_A, message: 'third' });

          // Act
          await writeReflog(ctx, HEAD, [first, second, third]);

          // Assert
          expect(await readReflog(ctx, HEAD)).toEqual([first, second, third]);
        });
      });
    });

    describe('Given an empty entry list', () => {
      describe('When writeReflog', () => {
        it('Then the file holds no entries', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await appendReflog(ctx, HEAD, entry());

          // Act
          await writeReflog(ctx, HEAD, []);

          // Assert
          expect(await readReflog(ctx, HEAD)).toEqual([]);
        });
      });
    });
  });

  describe('deleteReflog', () => {
    describe('Given an existing reflog', () => {
      describe('When deleteReflog', () => {
        it('Then the file is removed', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await appendReflog(ctx, HEAD, entry());

          // Act
          await deleteReflog(ctx, HEAD);

          // Assert
          expect(await reflogExists(ctx, HEAD)).toBe(false);
        });
      });
    });

    describe('Given a missing reflog', () => {
      describe('When deleteReflog', () => {
        it('Then it is a no-op (does not throw)', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act & Assert — must not throw.
          await deleteReflog(ctx, HEAD);
          // Assert
          expect(await reflogExists(ctx, HEAD)).toBe(false);
        });
      });
    });
  });

  describe('listReflogs', () => {
    describe('Given no logs directory', () => {
      describe('When listReflogs', () => {
        it('Then returns an empty array', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          const result = await listReflogs(ctx);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given reflogs at several depths', () => {
      describe('When listReflogs', () => {
        it('Then returns every ref path relative to logs/', async () => {
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
  });
});
