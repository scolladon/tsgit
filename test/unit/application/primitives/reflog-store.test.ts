import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  appendReflog,
  deleteReflog,
  listReflogs,
  readReflog,
  readReflogLenient,
  reflogExists,
  writeReflog,
} from '../../../../src/application/primitives/reflog-store.js';
import { MAX_REFLOG_BYTES } from '../../../../src/application/primitives/types.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { ZERO_OID } from '../../../../src/domain/objects/index.js';
import type { ReflogEntry } from '../../../../src/domain/reflog/index.js';
import { serializeReflogLine } from '../../../../src/domain/reflog/index.js';
import type { Context } from '../../../../src/ports/context.js';

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
  const framing = serializeReflogLine(entry({ message: '' }), 40).length + 1;
  return serializeReflogLine(entry({ message: 'x'.repeat(bytes - framing) }), 40);
};

/** The linked worktree's own (admin) gitdir under the common dir's `worktrees/`. */
const adminDir = (ctx: Context): string => `${ctx.layout.gitDir}/worktrees/wt`;

/** Reframe a seeded main-repo Context as a linked-worktree child Context. */
const asWorktreeChild = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, gitDir: adminDir(ctx), commonDir: ctx.layout.gitDir },
});

describe('reflog-store', () => {
  describe('appendReflog', () => {
    describe('Given a missing reflog', () => {
      describe('When appendReflog', () => {
        it('Then the .git/logs file is created with the line', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const reflogEntry = entry();

          // Act
          await appendReflog(ctx, HEAD, reflogEntry);

          // Assert
          const raw = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/HEAD`);
          expect(raw).toBe(serializeReflogLine(reflogEntry, 40));
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
          const reflogEntry = entry();
          await appendReflog(ctx, BRANCH, reflogEntry);

          // Act
          const result = await readReflog(ctx, BRANCH);

          // Assert
          expect(result).toEqual([reflogEntry]);
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

          // Act + Assert
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

  describe('readReflogLenient', () => {
    describe('Given a missing reflog file', () => {
      describe('When readReflogLenient', () => {
        it('Then returns an empty array', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          const result = await readReflogLenient(ctx, HEAD);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given a reflog with a malformed line between two valid entries', () => {
      describe('When readReflogLenient', () => {
        it('Then the malformed line is skipped and both valid entries survive', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const first = entry({ message: 'first' });
          const second = entry({ oldId: OID_A, message: 'second' });
          await appendReflog(ctx, HEAD, first);
          await ctx.fs.appendUtf8(
            `${ctx.layout.gitDir}/logs/HEAD`,
            'this is not a valid reflog line at all\n',
          );
          await appendReflog(ctx, HEAD, second);

          // Act
          const result = await readReflogLenient(ctx, HEAD);

          // Assert
          expect(result).toEqual([first, second]);
        });
      });
    });

    describe('Given a reflog file larger than MAX_REFLOG_BYTES', () => {
      describe('When readReflogLenient', () => {
        it('Then it still throws INVALID_REFLOG_ENTRY — the cap is not tolerated', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const padded = lineOfSize(MAX_REFLOG_BYTES + 1);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/HEAD`, padded);

          // Act + Assert
          try {
            await readReflogLenient(ctx, HEAD);
            expect.fail('expected INVALID_REFLOG_ENTRY');
          } catch (err) {
            expect(err).toBeInstanceOf(TsgitError);
            expect((err as TsgitError).data).toEqual({
              code: 'INVALID_REFLOG_ENTRY',
              reason: `reflog file exceeds ${MAX_REFLOG_BYTES} bytes`,
            });
          }
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

          // Act + Assert
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

          // Act + Assert
          expect(await reflogExists(ctx, HEAD)).toBe(true);
        });
      });
    });
  });

  describe('writeReflog', () => {
    describe('Given an existing reflog state', () => {
      describe('When writeReflog', () => {
        it.each([
          {
            label: 'replaces existing entries with fewer entries',
            existing: [entry(), entry({ oldId: OID_A, newId: OID_B, message: 'second' })],
            written: [entry({ message: 'kept' })],
          },
          {
            // A multi-entry write proves the lines are concatenated with no
            // separator between them.
            label: 'round-trips several entries back, oldest-first',
            existing: [],
            written: [
              entry({ message: 'first' }),
              entry({ oldId: OID_A, newId: OID_B, message: 'second' }),
              entry({ oldId: OID_B, newId: OID_A, message: 'third' }),
            ],
          },
          {
            label: 'clears the file when given an empty entry list',
            existing: [entry()],
            written: [],
          },
        ])('Then $label', async ({ existing, written }) => {
          // Arrange
          const ctx = createMemoryContext();
          for (const previous of existing) {
            await appendReflog(ctx, HEAD, previous);
          }

          // Act
          await writeReflog(ctx, HEAD, written);

          // Assert
          expect(await readReflog(ctx, HEAD)).toEqual(written);
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

          // Act — must not throw.
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

    describe('Given a worktree child Context with a shared-ref reflog in the common dir and a per-worktree reflog in the admin dir', () => {
      describe('When listReflogs', () => {
        it('Then both are returned, each exactly once', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const sut = asWorktreeChild(ctx);
          await appendReflog(sut, HEAD, entry());
          await appendReflog(sut, BRANCH, entry());

          // Act
          const result = await listReflogs(sut);

          // Assert
          expect([...result].sort()).toEqual(['HEAD', 'refs/heads/main'].sort());
        });
      });
    });

    describe('Given a plain Context whose gitDir equals its commonDir', () => {
      describe('When listReflogs', () => {
        it('Then a reflog present in both walk roots is still returned exactly once', async () => {
          // Arrange — gitDir === commonDir (no `commonDir` override), so the
          // two-root walk collapses onto the same directory: the dedup proof.
          const ctx = createMemoryContext();
          await appendReflog(ctx, HEAD, entry());

          // Act
          const result = await listReflogs(ctx);

          // Assert
          expect(result.filter((r) => r === 'HEAD')).toHaveLength(1);
        });

        it('Then the logs directory is walked exactly once', async () => {
          // Arrange — gitDir === commonDir: the walk must short-circuit to a
          // single root, not walk the same directory twice and dedup after.
          const ctx = createMemoryContext();
          await appendReflog(ctx, HEAD, entry());
          const logsRoot = `${ctx.layout.gitDir}/logs`;
          const readdirCalls: string[] = [];
          const originalReaddir = ctx.fs.readdir;
          const spiedCtx: Context = {
            ...ctx,
            fs: {
              ...ctx.fs,
              readdir: async (path: string) => {
                readdirCalls.push(path);
                return originalReaddir(path);
              },
            },
          };

          // Act
          await listReflogs(spiedCtx);

          // Assert
          expect(readdirCalls.filter((p) => p === logsRoot)).toHaveLength(1);
        });
      });
    });
  });
});
