import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import type { ReflogResult } from '../../../../src/application/commands/reflog.js';
import { reflog } from '../../../../src/application/commands/reflog.js';
import * as readCommitMetaMod from '../../../../src/application/primitives/internal/read-commit-meta.js';
import * as readObjectMod from '../../../../src/application/primitives/read-object.js';
import { appendReflog, writeReflog } from '../../../../src/application/primitives/reflog-store.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  CommitData,
  ObjectId,
  RefName,
} from '../../../../src/domain/objects/index.js';
import { ZERO_OID } from '../../../../src/domain/objects/index.js';
import type { ReflogEntry } from '../../../../src/domain/reflog/index.js';
import { parseApproxidate, serializeReflogLine } from '../../../../src/domain/reflog/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

interface BadNumericData {
  readonly code: string;
  readonly key: string;
  readonly value: string;
  readonly reason: string;
}

const HEAD = 'HEAD' as RefName;
const BRANCH = 'refs/heads/main' as RefName;
const TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904' as ObjectId;
const OID_X = 'a'.repeat(40) as ObjectId;
const OID_Y = 'b'.repeat(40) as ObjectId;
const OID_Z = 'c'.repeat(40) as ObjectId;

const identityAt = (timestamp: number): AuthorIdentity => ({
  name: 'Ada',
  email: 'ada@example.com',
  timestamp,
  timezoneOffset: '+0000',
});

const entry = (overrides: Partial<ReflogEntry> = {}): ReflogEntry => ({
  oldId: ZERO_OID,
  newId: OID_X,
  identity: identityAt(1_700_000_000),
  message: 'commit (initial): seed',
  ...overrides,
});

const writeCommit = (
  ctx: Context,
  parents: ReadonlyArray<ObjectId>,
  timestamp: number,
): Promise<ObjectId> => {
  const data: CommitData = {
    tree: TREE_OID,
    parents: [...parents],
    author: identityAt(timestamp),
    committer: identityAt(timestamp),
    message: 'c',
    extraHeaders: [],
  };
  return writeObject(ctx, { type: 'commit', id: '' as ObjectId, data });
};

describe('reflog command', () => {
  describe('Given a non-repo ctx', () => {
    describe('When reflog', () => {
      it('Then throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        let caught: unknown;
        try {
          await reflog(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  describe('show', () => {
    describe('Given a reflog with three entries', () => {
      describe('When reflog show', () => {
        it('Then entries are newest-first with index and selector', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const first = entry({ message: 'commit (initial): first' });
          const second = entry({ oldId: OID_X, newId: OID_Y, message: 'commit: second' });
          const third = entry({ oldId: OID_Y, newId: OID_Z, message: 'commit: third' });
          await writeReflog(ctx, HEAD, [first, second, third]);

          // Act
          const result = await reflog(ctx, { action: 'show' });

          // Assert
          expect(result.kind).toBe('show');
          if (result.kind !== 'show') throw new Error('unreachable');
          expect(result.ref).toBe(HEAD);
          // A files-backend read attaches `raw` (the on-disk byte slices) to
          // every entry, so each expected entry is matched as a superset.
          expect(result.entries).toEqual([
            { index: 0, selector: 'HEAD@{0}', entry: expect.objectContaining(third) },
            { index: 1, selector: 'HEAD@{1}', entry: expect.objectContaining(second) },
            { index: 2, selector: 'HEAD@{2}', entry: expect.objectContaining(first) },
          ]);
        });
      });
    });

    describe('Given no action', () => {
      describe('When reflog with no opts', () => {
        it('Then it defaults to show on HEAD', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await appendReflog(ctx, HEAD, entry());

          // Act
          const result = await reflog(ctx);

          // Assert
          expect(result.kind).toBe('show');
          if (result.kind !== 'show') throw new Error('unreachable');
          expect(result.ref).toBe(HEAD);
          expect(result.entries).toHaveLength(1);
        });
      });
    });

    describe('Given an explicit branch ref', () => {
      describe('When reflog show', () => {
        it('Then it reads that branch reflog', async () => {
          // Arrange — pins that `ref` is honoured, not hard-coded to HEAD.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await appendReflog(ctx, BRANCH, entry({ message: 'branch entry' }));

          // Act
          const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert
          expect(result.kind === 'show' && result.ref).toBe(BRANCH);
          expect(result.kind === 'show' && result.entries[0]?.selector).toBe('refs/heads/main@{0}');
        });
      });
    });

    describe('Given a reflog with a malformed line mid-file', () => {
      describe('When reflog show', () => {
        it('Then the malformed line is skipped and survivors are numbered contiguously', async () => {
          // Arrange — a raw file: valid, garbage, valid, valid — the strict
          // reader would throw on the whole file; the lenient one drops only
          // the garbage line and keeps counting the rest.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const first = entry({ message: 'commit (initial): first' });
          const second = entry({ oldId: OID_X, newId: OID_Y, message: 'commit: second' });
          const third = entry({ oldId: OID_Y, newId: OID_Z, message: 'commit: third' });
          const raw =
            serializeReflogLine(first, 40) +
            'this is not a reflog line at all\n' +
            serializeReflogLine(second, 40) +
            serializeReflogLine(third, 40);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/HEAD`, raw);

          // Act
          const result = await reflog(ctx, { action: 'show' });

          // Assert — newest-first survivors: third(@0), second(@1), first(@2).
          expect(result.kind).toBe('show');
          if (result.kind !== 'show') throw new Error('unreachable');
          // A files-backend read attaches `raw` (the on-disk byte slices) to
          // every entry, so each expected entry is matched as a superset.
          expect(result.entries).toEqual([
            { index: 0, selector: 'HEAD@{0}', entry: expect.objectContaining(third) },
            { index: 1, selector: 'HEAD@{1}', entry: expect.objectContaining(second) },
            { index: 2, selector: 'HEAD@{2}', entry: expect.objectContaining(first) },
          ]);
        });
      });
    });

    describe('Given a ref with no reflog file', () => {
      describe('When reflog show', () => {
        it('Then it returns an empty entry list (not an error)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/missing' });

          // Assert
          expect(result.kind === 'show' && result.entries).toEqual([]);
        });
      });
    });
  });

  describe('exists', () => {
    describe('Given a ref with a reflog', () => {
      describe('When reflog exists', () => {
        it('Then returns true', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await appendReflog(ctx, BRANCH, entry());

          // Act
          const result = await reflog(ctx, { action: 'exists', ref: 'refs/heads/main' });

          // Assert
          expect(result).toEqual({ kind: 'exists', exists: true });
        });
      });
    });

    describe('Given a ref with no reflog', () => {
      describe('When reflog exists', () => {
        it('Then returns false', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          const result = await reflog(ctx, { action: 'exists', ref: 'refs/heads/main' });

          // Assert
          expect(result).toEqual({ kind: 'exists', exists: false });
        });
      });
    });

    describe('Given a ref whose reflog was emptied by a prior delete (file present, no entries)', () => {
      describe('When reflog exists', () => {
        it('Then still returns true — a present-but-empty log is not "no reflog" (matches real git)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, BRANCH, [entry()]);
          await reflog(ctx, { action: 'delete', ref: 'refs/heads/main', index: 0 });

          // Act
          const result = await reflog(ctx, { action: 'exists', ref: 'refs/heads/main' });

          // Assert
          expect(result).toEqual({ kind: 'exists', exists: true });
        });
      });
    });
  });

  describe('Given a malformed core.maxTreeDepth', () => {
    describe('When reflog exists runs', () => {
      it('Then it still runs — git runs on "reflog exists" too', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');

        // Act
        const result = await reflog(ctx, { action: 'exists', ref: 'refs/heads/main' });

        // Assert
        expect(result).toEqual({ kind: 'exists', exists: false });
      });
    });

    describe('When reflog show runs', () => {
      it('Then it throws CONFIG_BAD_NUMERIC_VALUE — checked after the exists dispatch', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');

        // Act
        let caught: unknown;
        try {
          await reflog(ctx, { action: 'show' });
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert — the whole payload, each field individually (mutation-resistant)
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as BadNumericData;
        expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        expect(data.key).toBe('core.maxtreedepth');
        expect(data.value).toBe('2.5');
        expect(data.reason).toBe('invalid unit');
      });
    });

    describe('When reflog delete runs', () => {
      it('Then it throws CONFIG_BAD_NUMERIC_VALUE', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await appendReflog(ctx, BRANCH, entry());
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');

        // Act
        let caught: unknown;
        try {
          await reflog(ctx, { action: 'delete', ref: 'refs/heads/main', index: 0 });
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert — the whole payload, each field individually (mutation-resistant)
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as BadNumericData;
        expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        expect(data.key).toBe('core.maxtreedepth');
        expect(data.value).toBe('2.5');
        expect(data.reason).toBe('invalid unit');
      });
    });

    describe('When reflog expire runs', () => {
      it('Then it throws CONFIG_BAD_NUMERIC_VALUE', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');

        // Act
        let caught: unknown;
        try {
          await reflog(ctx, { action: 'expire', all: true });
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert — the whole payload, each field individually (mutation-resistant)
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as BadNumericData;
        expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        expect(data.key).toBe('core.maxtreedepth');
        expect(data.value).toBe('2.5');
        expect(data.reason).toBe('invalid unit');
      });
    });
  });

  describe('delete', () => {
    describe('Given a three-entry reflog', () => {
      describe('When delete index 1', () => {
        it('Then the middle entry is dropped and returned', async () => {
          // Arrange — index counts newest-first: index 1 is the second-newest.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const first = entry({ message: 'first' });
          const second = entry({ oldId: OID_X, newId: OID_Y, message: 'second' });
          const third = entry({ oldId: OID_Y, newId: OID_Z, message: 'third' });
          await writeReflog(ctx, HEAD, [first, second, third]);

          // Act
          const result = await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 1 });

          // Assert — `removed` is present, the optional field's other
          // direction. A files-backend read attaches `raw`, so the removed
          // entry and every surviving entry are matched as a superset.
          expect(result).toEqual({ kind: 'delete', removed: expect.objectContaining(second) });
          expect('removed' in result).toBe(true);
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([
            expect.objectContaining(third),
            expect.objectContaining(first),
          ]);
        });
      });
    });

    describe('Given delete index 0 (newest)', () => {
      describe('When delete', () => {
        it('Then the newest entry is removed', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const first = entry({ message: 'first' });
          const second = entry({ oldId: OID_X, newId: OID_Y, message: 'second' });
          await writeReflog(ctx, HEAD, [first, second]);

          // Act
          const result = await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 0 });

          // Assert — a files-backend read attaches `raw`, so the removed and
          // surviving entries are matched as a superset of the fixtures.
          expect(result.kind === 'delete' && result.removed).toEqual(
            expect.objectContaining(second),
          );
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([
            expect.objectContaining(first),
          ]);
        });
      });
    });

    describe('Given rewrite=true deleting a middle entry', () => {
      describe('When delete', () => {
        it('Then the following entry oldId is repaired', async () => {
          // Arrange — file order: first, second, third. Deleting `second` (index 1,
          // newest-first) with rewrite repairs `third.oldId` to `second.oldId`.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const first = entry({ oldId: ZERO_OID, newId: OID_X, message: 'first' });
          const second = entry({ oldId: OID_X, newId: OID_Y, message: 'second' });
          const third = entry({ oldId: OID_Y, newId: OID_Z, message: 'third' });
          await writeReflog(ctx, HEAD, [first, second, third]);

          // Act
          await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 1, rewrite: true });

          // Assert
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          const repaired = after.kind === 'show' ? after.entries.map((e) => e.entry) : [];
          // newest-first: third (repaired), first — a files-backend read
          // attaches `raw`, so each entry is matched as a superset.
          expect(repaired).toEqual([
            expect.objectContaining({ ...third, oldId: OID_X }),
            expect.objectContaining(first),
          ]);
        });
      });
    });

    describe('Given rewrite=true deleting the oldest entry', () => {
      describe('When delete', () => {
        it('Then no following entry exists and nothing else changes', async () => {
          // Arrange — deleting the file-order-last (index 0, newest) entry: there is
          // no following entry to repair, so rewrite is a no-op on the remainder.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const first = entry({ oldId: ZERO_OID, newId: OID_X, message: 'first' });
          const second = entry({ oldId: OID_X, newId: OID_Y, message: 'second' });
          await writeReflog(ctx, HEAD, [first, second]);

          // Act
          await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 0, rewrite: true });

          // Assert — a files-backend read attaches `raw`, matched as a superset.
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([
            expect.objectContaining(first),
          ]);
        });
      });
    });

    describe('Given rewrite is omitted', () => {
      describe('When delete a middle entry', () => {
        it('Then the following entry oldId is NOT repaired', async () => {
          // Arrange — without rewrite, `third.oldId` keeps the deleted entry's newId.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const first = entry({ oldId: ZERO_OID, newId: OID_X, message: 'first' });
          const second = entry({ oldId: OID_X, newId: OID_Y, message: 'second' });
          const third = entry({ oldId: OID_Y, newId: OID_Z, message: 'third' });
          await writeReflog(ctx, HEAD, [first, second, third]);

          // Act
          await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 1 });

          // Assert — a files-backend read attaches `raw`, matched as a superset.
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([
            expect.objectContaining(third),
            expect.objectContaining(first),
          ]);
        });
      });
    });

    describe('Given the oldest entry (highest valid index)', () => {
      describe('When delete', () => {
        it('Then it is removed without an out-of-range throw', async () => {
          // Arrange — two entries; index 1 (newest-first) targets file position 0,
          // the oldest entry. This is the lower boundary of the valid index range.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const first = entry({ message: 'first' });
          const second = entry({ oldId: OID_X, newId: OID_Y, message: 'second' });
          await writeReflog(ctx, HEAD, [first, second]);

          // Act
          const result = await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 1 });

          // Assert — the oldest entry is removed, not rejected as out of
          // range. A files-backend read attaches `raw`, matched as a superset.
          expect(result).toEqual({ kind: 'delete', removed: expect.objectContaining(first) });
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([
            expect.objectContaining(second),
          ]);
        });
      });
    });

    describe('Given a ref with no reflog file', () => {
      describe('When delete', () => {
        it('Then throws REFLOG_NOT_FOUND with the ref', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'delete', ref: 'refs/heads/missing', index: 0 });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFLOG_NOT_FOUND',
            ref: 'refs/heads/missing',
          });
        });
      });
    });

    describe('Given a reflog path that is a directory because a sibling ref nests under it', () => {
      describe('When delete', () => {
        it('Then throws REFLOG_NOT_FOUND rather than a raw filesystem read error', async () => {
          // Arrange — measured against git 2.55.0: `refs/heads/feature/x`
          // having a reflog makes `.git/logs/refs/heads/feature` a
          // directory (holding `x`'s own file), not `feature`'s own reflog.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await appendReflog(ctx, 'refs/heads/feature/x' as RefName, entry());

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'delete', ref: 'refs/heads/feature', index: 0 });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFLOG_NOT_FOUND',
            ref: 'refs/heads/feature',
          });
        });
      });
    });

    describe('Given an index past the last entry', () => {
      describe('When delete', () => {
        it('Then resolves with removed absent', async () => {
          // Arrange — two entries, index 2 is out of range.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, HEAD, [entry(), entry({ oldId: OID_X, newId: OID_Y })]);

          // Act
          const result = await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 2 });

          // Assert
          if (result.kind !== 'delete') expect.fail('expected a delete result');
          expect('removed' in result).toBe(false);
        });
      });
    });

    describe('Given a negative index', () => {
      describe('When delete', () => {
        it('Then resolves with removed absent', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, HEAD, [entry()]);

          // Act
          const result = await reflog(ctx, { action: 'delete', ref: 'HEAD', index: -1 });

          // Assert
          if (result.kind !== 'delete') expect.fail('expected a delete result');
          expect('removed' in result).toBe(false);
        });
      });
    });

    describe('Given an empty reflog file', () => {
      describe('When delete index 0', () => {
        it('Then resolves with removed absent', async () => {
          // Arrange — the file exists (so not REFLOG_NOT_FOUND) but holds no entries.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, HEAD, []);

          // Act
          const result = await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 0 });

          // Assert
          if (result.kind !== 'delete') expect.fail('expected a delete result');
          expect('removed' in result).toBe(false);
        });
      });
    });

    describe('Given a NaN index', () => {
      describe('When delete', () => {
        it('Then resolves with removed absent', async () => {
          // Arrange — NaN would index `stored[NaN]` as `undefined` and bypass the
          // range guard; the integer guard must reject it.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, HEAD, [entry()]);

          // Act
          const result = await reflog(ctx, { action: 'delete', ref: 'HEAD', index: Number.NaN });

          // Assert
          if (result.kind !== 'delete') expect.fail('expected a delete result');
          expect('removed' in result).toBe(false);
        });
      });
    });

    describe('Given a fractional index', () => {
      describe('When delete', () => {
        it('Then resolves with removed absent', async () => {
          // Arrange — 1.5 is in range numerically but is not a valid entry index.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, HEAD, [entry(), entry({ oldId: OID_X, newId: OID_Y })]);

          // Act
          const result = await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 1.5 });

          // Assert
          if (result.kind !== 'delete') expect.fail('expected a delete result');
          expect('removed' in result).toBe(false);
        });
      });
    });

    describe('Given a raw reflog file with a malformed line and an out-of-range index', () => {
      describe('When delete', () => {
        it('Then the malformed line is purged from disk and the valid entry survives', async () => {
          // Arrange — seeded with a raw writeUtf8 (not writeReflog, which would
          // refuse the malformed line itself), so the corruption actually lands
          // on disk.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const kept = entry({ message: 'kept' });
          const reflogPath = `${ctx.layout.gitDir}/logs/HEAD`;
          await ctx.fs.writeUtf8(reflogPath, `${serializeReflogLine(kept, 40)}garbage line\n`);

          // Act
          const result = await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 99 });

          // Assert — out of range is a no-op selection, but the write still
          // happens and purges the malformed line.
          if (result.kind !== 'delete') expect.fail('expected a delete result');
          expect('removed' in result).toBe(false);
          const after = await ctx.fs.readUtf8(reflogPath);
          expect(after).toBe(serializeReflogLine(kept, 40));
        });
      });
    });

    describe('Given a clean reflog and an out-of-range index', () => {
      describe('When delete', () => {
        it('Then the log is still rewritten and its content is unchanged', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          const first = entry({ message: 'first' });
          const second = entry({ oldId: OID_X, newId: OID_Y, message: 'second' });
          await writeReflog(ctx, HEAD, [first, second]);
          const reflogPath = `${ctx.layout.gitDir}/logs/HEAD`;
          const renameDestinations: string[] = [];
          const spiedCtx: Context = {
            ...ctx,
            fs: {
              ...ctx.fs,
              rename: (source: string, destination: string): Promise<void> => {
                renameDestinations.push(destination);
                return ctx.fs.rename(source, destination);
              },
            },
          };

          // Act
          const result = await reflog(spiedCtx, { action: 'delete', ref: 'HEAD', index: 99 });

          // Assert — the index named no entry, but the lock file was still
          // renamed onto the log, and the content that landed is unchanged.
          if (result.kind !== 'delete') expect.fail('expected a delete result');
          expect('removed' in result).toBe(false);
          expect(renameDestinations).toContain(reflogPath);
          // A files-backend read attaches `raw`, matched as a superset.
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([
            expect.objectContaining(second),
            expect.objectContaining(first),
          ]);
        });
      });
    });
  });

  describe('ref-name validation', () => {
    describe('Given an invalid ref containing ..', () => {
      describe('When reflog show', () => {
        it('Then throws INVALID_REF', async () => {
          // Arrange — a path-traversal attempt must be rejected before it indexes
          // the filesystem.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'show', ref: '../../etc/passwd' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_REF',
            reason: 'ref name must not contain ..',
          });
        });
      });
    });

    describe('Given an invalid ref', () => {
      describe('When reflog exists', () => {
        it('Then throws INVALID_REF', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'exists', ref: '../../etc/passwd' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('INVALID_REF');
        });
      });
      describe('When reflog delete', () => {
        it('Then throws INVALID_REF', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'delete', ref: '../../etc/passwd', index: 0 });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('INVALID_REF');
        });
      });
      describe('When reflog expire', () => {
        it('Then throws INVALID_REF', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'expire', ref: '../../etc/passwd' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('INVALID_REF');
        });
      });
    });

    describe('Given the HEAD literal', () => {
      describe('When reflog show', () => {
        it('Then it is accepted verbatim', async () => {
          // Arrange — `HEAD` is a pseudo-ref the validator would not produce.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await appendReflog(ctx, HEAD, entry());

          // Act
          const result = await reflog(ctx, { action: 'show', ref: 'HEAD' });

          // Assert
          expect(result.kind === 'show' && result.ref).toBe(HEAD);
        });
      });
    });

    describe('Given a normal refs/heads ref', () => {
      describe('When reflog show', () => {
        it('Then it resolves', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await appendReflog(ctx, BRANCH, entry());

          // Act
          const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert
          expect(result.kind === 'show' && result.ref).toBe(BRANCH);
        });
      });
    });
  });

  describe('expire', () => {
    // `expire` reads `Date.now()` internally for the cutoff; entry timestamps
    // are therefore relative to the real wall clock, not a frozen instant.
    const DAY = 86_400;
    const wallNow = (): number => Math.floor(Date.now() / 1000);

    describe('Given a reachable entry older than the expire cutoff', () => {
      describe('When expire', () => {
        it('Then it is pruned', async () => {
          // Arrange — a reachable commit, but its entry timestamp predates 90 days.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          const stale = now - 100 * DAY;
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(stale), message: 'old reachable' }),
          ]);

          // Act — the default 90.days.ago cutoff is far newer than the 100-day-old
          // entry, so it is removed.
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 1, kept: 0 });
        });
      });
    });

    describe('Given a reachable recent entry', () => {
      describe('When expire', () => {
        it('Then it is kept', async () => {
          // Arrange
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          const recent = now - 1 * DAY;
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(recent), message: 'recent reachable' }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
        });
      });
    });

    describe('Given an unreachable entry between the two cutoffs', () => {
      describe('When expire', () => {
        it('Then it is pruned on the shorter unreachable clock', async () => {
          // Arrange — an entry 45 days old whose newId is a real commit that
          // exists but sits off every ref's tip. Reachable cutoff is 90 days
          // (would keep it); unreachable cutoff is 30 days (prunes it). The
          // unreachable clock must win.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          const island = await writeCommit(ctx, [], now - 1);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          const middling = now - 45 * DAY;
          await writeReflog(ctx, HEAD, [
            entry({ newId: island, identity: identityAt(middling), message: 'unreachable' }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 1, kept: 0 });
        });
      });
    });

    describe('Given an unreachable entry newer than the unreachable cutoff', () => {
      describe('When expire', () => {
        it('Then it is kept', async () => {
          // Arrange — an unreachable entry 10 days old; under the 30-day unreachable
          // cutoff it survives.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          const recent = now - 10 * DAY;
          await writeReflog(ctx, HEAD, [
            entry({ newId: OID_X, identity: identityAt(recent), message: 'unreachable recent' }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
        });
      });
    });

    describe('Given a reachable entry just past the 90-day cutoff', () => {
      describe('When expire', () => {
        it('Then the reachable clock prunes it (not the unreachable clock)', async () => {
          // Arrange — a reachable entry 50 days old: kept on the 90-day reachable
          // clock, pruned on the 30-day unreachable clock. It survives, proving the
          // reachable branch of the keep predicate fires for in-set tips.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          const fifty = now - 50 * DAY;
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(fifty), message: 'reachable 50d' }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
        });
      });
    });

    describe('Given explicit expire and expireUnreachable cutoffs', () => {
      describe('When expire', () => {
        it('Then both are honoured', async () => {
          // Arrange — a reachable entry 5 days old; an explicit 3-day expire cutoff
          // prunes it even though it would survive the 90-day default.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          const fiveDaysOld = now - 5 * DAY;
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(fiveDaysOld), message: 'reachable' }),
          ]);

          // Act
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'HEAD',
            expire: '3.days.ago',
            expireUnreachable: '1.day.ago',
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 1, kept: 0 });
        });
      });
    });

    describe('Given all=true', () => {
      describe('When expire', () => {
        it('Then every reflog file from listReflogs is processed', async () => {
          // Arrange — two stale logs, one HEAD one branch.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          const stale = now - 100 * DAY;
          await writeReflog(ctx, HEAD, [
            entry({ newId: OID_X, identity: identityAt(stale), message: 'head stale' }),
          ]);
          await writeReflog(ctx, BRANCH, [
            entry({ newId: OID_Y, identity: identityAt(stale), message: 'branch stale' }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', all: true });

          // Assert — both stale entries pruned.
          expect(result).toEqual({ kind: 'expire', removed: 2, kept: 0 });
        });
      });
    });

    describe('Given expire defaults to HEAD', () => {
      describe('When expire with no ref and no all', () => {
        it('Then only the HEAD log is touched', async () => {
          // Arrange — a stale HEAD entry and a stale branch entry; without `ref` or
          // `all`, only HEAD is expired.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          const stale = now - 100 * DAY;
          await writeReflog(ctx, HEAD, [
            entry({ newId: OID_X, identity: identityAt(stale), message: 'head stale' }),
          ]);
          await writeReflog(ctx, BRANCH, [
            entry({ newId: OID_Y, identity: identityAt(stale), message: 'branch stale' }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire' });

          // Assert — only HEAD's single entry pruned; the branch log untouched.
          expect(result).toEqual({ kind: 'expire', removed: 1, kept: 0 });
          const branchAfter = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });
          expect(branchAfter.kind === 'show' && branchAfter.entries).toHaveLength(1);
        });
      });
    });

    describe('Given a reachable entry through a parent commit', () => {
      describe('When expire', () => {
        it('Then the walk marks it reachable', async () => {
          // Arrange — the tip has a parent; an entry pointing at the parent is
          // reachable via the walk, so it survives the 90-day cutoff at 50 days old.
          const now = wallNow();
          const ctx = createMemoryContext();
          const parent = await writeCommit(ctx, [], now - DAY);
          const tip = await writeCommit(ctx, [parent], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          const fifty = now - 50 * DAY;
          await writeReflog(ctx, HEAD, [
            entry({ newId: parent, identity: identityAt(fifty), message: 'points at parent' }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert — kept proves the parent was walked into the reachable set; an
          // unreachable 50-day entry would be pruned on the 30-day clock.
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
        });
      });
    });

    describe('Given an unparseable expire cutoff', () => {
      describe('When expire', () => {
        it('Then throws REVPARSE_UNRESOLVED with the cutoff string', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, HEAD, [entry()]);

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'expire', ref: 'HEAD', expire: 'not-a-date' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REVPARSE_UNRESOLVED',
            expression: 'not-a-date',
          });
        });
      });
    });

    describe('Given an unparseable expireUnreachable cutoff', () => {
      describe('When expire', () => {
        it('Then throws REVPARSE_UNRESOLVED with that string', async () => {
          // Arrange — isolates the second cutoff guard from the first.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, HEAD, [entry()]);

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'expire', ref: 'HEAD', expireUnreachable: 'garbage' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REVPARSE_UNRESOLVED',
            expression: 'garbage',
          });
        });
      });
    });

    describe('Given a missing reflog', () => {
      describe('When expire', () => {
        it('Then throws REFLOG_NOT_FOUND and creates no log file', async () => {
          // Arrange — git refuses (exit 255) and creates nothing; the
          // unconditional rewrite must not manufacture an empty log file.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act & Assert
          try {
            await reflog(ctx, { action: 'expire', ref: 'refs/heads/missing' });
            expect.unreachable('expire on a missing reflog must refuse');
          } catch (err) {
            expect((err as TsgitError).data).toEqual({
              code: 'REFLOG_NOT_FOUND',
              ref: 'refs/heads/missing',
            });
          }
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/refs/heads/missing`)).toBe(false);
        });
      });
    });

    describe('Given a stale and a recent entry', () => {
      describe('When expire prunes the stale one', () => {
        it('Then the reflog file no longer holds it', async () => {
          // Arrange — two entries; only the 100-day-old one is pruned. The write
          // back must persist the survivors-only list to disk, not just report it.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          const stale = now - 100 * DAY;
          const recent = now - 1 * DAY;
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(stale), message: 'stale reachable' }),
            entry({ newId: tip, identity: identityAt(recent), message: 'recent reachable' }),
          ]);

          // Act
          await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert — the file must show exactly the surviving recent entry.
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry.message)).toEqual([
            'recent reachable',
          ]);
        });
      });
    });

    describe('Given an entry far older than the default cutoff', () => {
      describe('When expire runs with the never grammar', () => {
        it.each([
          { raw: 'never', label: 'never' },
          { raw: ' NEVER ', label: 'NEVER with surrounding spaces' },
          { raw: 'false', label: 'false (git synonym)' },
        ])('Then the entry survives $label', async ({ raw }) => {
          // Arrange — a 400-day-old entry that the 90-day default WOULD prune,
          // so surviving proves the grammar, not the timestamps.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(now - 400 * DAY), message: 'ancient' }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD', expire: raw });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
        });
      });

      describe('When expire runs with the all grammar on a FUTURE-dated entry', () => {
        it.each([{ raw: 'all' }, { raw: 'now' }])(
          'Then even an entry stamped ahead of the clock is pruned by $raw',
          async ({ raw }) => {
            // Arrange — git maps all/now to the maximum time, not the current
            // one: an entry a year in the future is still deleted.
            const now = wallNow();
            const ctx = createMemoryContext();
            const tip = await writeCommit(ctx, [], now);
            await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
            await writeReflog(ctx, HEAD, [
              entry({ newId: tip, identity: identityAt(now + 365 * DAY), message: 'future' }),
            ]);

            // Act
            const result = await reflog(ctx, { action: 'expire', ref: 'HEAD', expire: raw });

            // Assert
            expect(result).toEqual({ kind: 'expire', removed: 1, kept: 0 });
          },
        );
      });

      describe('When expire runs with uppercase NOW on a FUTURE-dated entry', () => {
        it('Then the entry is KEPT — NOW is a date (the clock), not the exact-match now keyword', async () => {
          // Arrange — the one input separating exact-match `now` (maximum
          // time) from the date parser's tolerant casing (current clock):
          // git keeps a future-dated entry under --expire=NOW and deletes it
          // under --expire=now.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(now + 365 * DAY), message: 'future' }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD', expire: 'NOW' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
        });
      });

      describe('When expire runs with an uppercase keyword', () => {
        it.each([{ raw: 'ALL' }, { raw: 'FALSE' }])(
          'Then $raw refuses — false/all are exact-match keywords, as in git',
          async ({ raw }) => {
            // Arrange
            const now = wallNow();
            const ctx = createMemoryContext();
            const tip = await writeCommit(ctx, [], now);
            await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
            await writeReflog(ctx, HEAD, [
              entry({ newId: tip, identity: identityAt(now - 1 * DAY), message: 'recent' }),
            ]);

            // Act & Assert
            try {
              await reflog(ctx, { action: 'expire', ref: 'HEAD', expire: raw });
              expect.unreachable('an uppercase keyword must refuse');
            } catch (err) {
              expect((err as TsgitError).data).toEqual({
                code: 'REVPARSE_UNRESOLVED',
                expression: raw,
              });
            }
          },
        );
      });

      describe('When expire runs with --all on a repository with no reflogs at all', () => {
        it('Then it reports zero removed and kept and creates no files', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          const result = await reflog(ctx, { action: 'expire', all: true });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 0 });
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/HEAD`)).toBe(false);
        });
      });

      describe('When expire runs with the all grammar', () => {
        it('Then every entry is pruned (git synonym for now)', async () => {
          // Arrange
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(now - 1 * DAY), message: 'recent' }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD', expire: 'all' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 1, kept: 0 });
        });
      });
    });

    describe('Given no entry is stale enough to prune', () => {
      describe('When expire', () => {
        it('Then the reflog file is rewritten anyway and the entries are unchanged', async () => {
          // Arrange — two recent reachable entries; nothing crosses the cutoff.
          // The rewrite runs on every call regardless — a lock-then-rename pair
          // onto the reflog path is the proof it happened; `writeUtf8` no longer
          // sees the write once the replace goes through `atomicWriteFile`.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(now - 2 * DAY), message: 'first recent' }),
            entry({ newId: tip, identity: identityAt(now - 1 * DAY), message: 'second recent' }),
          ]);
          const reflogPath = `${ctx.layout.gitDir}/logs/HEAD`;
          const renameDestinations: string[] = [];
          const spiedCtx: Context = {
            ...ctx,
            fs: {
              ...ctx.fs,
              rename: (source: string, destination: string): Promise<void> => {
                renameDestinations.push(destination);
                return ctx.fs.rename(source, destination);
              },
            },
          };

          // Act
          const result = await reflog(spiedCtx, { action: 'expire', ref: 'HEAD' });

          // Assert — nothing pruned, but the lock file was renamed onto the log.
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 2 });
          expect(renameDestinations).toContain(reflogPath);
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry.message)).toEqual([
            'second recent',
            'first recent',
          ]);
        });
      });
    });

    describe('Given a raw reflog file with a malformed line and no entry stale enough to prune', () => {
      describe('When expire runs with expire: never', () => {
        it('Then the malformed line is purged from disk and the valid entry survives', async () => {
          // Arrange — seeded with a raw writeUtf8 (not writeReflog, which would
          // refuse the malformed line itself), so the corruption actually lands
          // on disk. The old guard compared PARSED counts (1 stored === 1 kept,
          // since the garbage line was never counted as an entry), which used
          // to skip the write and leave the malformed line behind.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          const kept = entry({ newId: tip, identity: identityAt(now - 1 * DAY), message: 'kept' });
          const reflogPath = `${ctx.layout.gitDir}/logs/HEAD`;
          await ctx.fs.writeUtf8(reflogPath, `${serializeReflogLine(kept, 40)}garbage line\n`);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD', expire: 'never' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
          const after = await ctx.fs.readUtf8(reflogPath);
          expect(after).toBe(serializeReflogLine(kept, 40));
        });
      });
    });

    describe('Given an entry whose timestamp exactly equals the expire cutoff', () => {
      describe('When expire', () => {
        it('Then it is kept', async () => {
          // Arrange — a reachable entry timestamped at the exact cutoff instant.
          // The keep predicate uses `>=`, so an entry AT the cutoff survives; `>`
          // would prune it. The cutoff for an ISO date is clock-independent.
          const cutoff = parseApproxidate('2024-06-01', wallNow()) as number;
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], cutoff);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(cutoff), message: 'at the cutoff' }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD', expire: '2024-06-01' });

          // Assert — the boundary entry is kept, not pruned.
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
        });
      });
    });

    describe('Given resolving a ref tip throws a non-TsgitError', () => {
      describe('When expire', () => {
        it('Then that error propagates instead of being swallowed', async () => {
          // Arrange — `refs/heads/main` exists, but reading its file raises a plain
          // Error (not a TsgitError). tryResolve only swallows TsgitErrors; an
          // unexpected error must surface, not be silently treated as unresolved.
          const ctx = createMemoryContext();
          await seedRepo(ctx, { refs: { 'refs/heads/main': OID_X } });
          await writeReflog(ctx, HEAD, [entry()]);
          const refPath = `${ctx.layout.gitDir}/refs/heads/main`;
          const boom = new Error('disk fault');
          const faultyCtx: Context = {
            ...ctx,
            fs: {
              ...ctx.fs,
              readUtf8: (path: string): Promise<string> =>
                path === refPath ? Promise.reject(boom) : ctx.fs.readUtf8(path),
            },
          };

          // Act
          let caught: unknown;
          try {
            await reflog(faultyCtx, { action: 'expire', ref: 'HEAD' });
          } catch (err) {
            caught = err;
          }

          // Assert — the exact non-TsgitError instance propagates unchanged.
          expect(caught).toBe(boom);
          expect(caught).not.toBeInstanceOf(TsgitError);
        });
      });
    });

    describe('Given a ref tip pointing at a missing commit', () => {
      describe('When expire', () => {
        it('Then the reachable walk ignores it and does not throw', async () => {
          // Arrange — `refs/heads/main` resolves to an oid with no object file. The
          // reachable-set walk must tolerate the missing seed (ignoreMissing) rather
          // than aborting the whole expire.
          const ctx = createMemoryContext();
          const missingTip = 'd'.repeat(40) as ObjectId;
          await seedRepo(ctx, { refs: { 'refs/heads/main': missingTip } });
          const now = wallNow();
          await writeReflog(ctx, HEAD, [
            entry({ newId: OID_X, identity: identityAt(now - 100 * DAY), message: 'stale' }),
          ]);

          // Act — the walk seeds from the missing tip; expire must still complete.
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert — the unreachable stale entry is pruned; no throw on the missing tip.
          expect(result).toEqual({ kind: 'expire', removed: 1, kept: 0 });
        });
      });
    });

    describe('Given several refs pointing at the same commit', () => {
      describe('When expire computes the reachable set for HEAD', () => {
        it('Then the shared tip is expanded exactly once', async () => {
          // Arrange — three branches share one tip; `resolveTips`'s dedup (a
          // `Set` over the resolved ids) collapses them to a single walk
          // seed, so the shared tip's metadata is read exactly once rather
          // than once per ref that happens to point at it.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, {
            refs: {
              'refs/heads/main': tip,
              'refs/heads/alt-a': tip,
              'refs/heads/alt-b': tip,
            },
          });
          await writeReflog(ctx, HEAD, [
            // 45 days old: between the default 90/30-day cutoffs, so the
            // verdict actually depends on the reachability walk running.
            entry({ newId: tip, identity: identityAt(now - 45 * DAY), message: 'in range' }),
          ]);
          const spy = vi.spyOn(readCommitMetaMod, 'readCommitMeta');

          // Act
          let tipCalls: number;
          try {
            await reflog(ctx, { action: 'expire', all: true });
            // Read the call history before `mockRestore` clears it.
            tipCalls = spy.mock.calls.filter(([, id]) => id === tip).length;
          } finally {
            spy.mockRestore();
          }

          // Assert
          expect(tipCalls).toBe(1);
        });
      });
    });

    describe('Given more refs than the ioBound limit, each with its own commit', () => {
      describe('When expire computes the reachable set', () => {
        it('Then ref-tip resolution runs more than one at a time', async () => {
          // Arrange — `HEAD`'s own reflog is the one target whose expire
          // kind is `UE_HEAD` (every current tip), so it is what drives the
          // whole-repo tip resolution under `--all`; the oracle is therefore
          // "more than one in flight" rather than the exact bound (a
          // `boundedMapFor` → `for…await` mutant caps this at 1).
          const ioBound = 3;
          const width = ioBound + 4;
          const base = createMemoryContext();
          const now = wallNow();
          const refs: Record<string, string> = {};
          for (let i = 0; i < width; i++) {
            const tip = await writeCommit(base, [], now - i);
            refs[`refs/heads/b${String(i).padStart(3, '0')}`] = tip;
          }
          await seedRepo(base, { refs });
          await writeReflog(base, HEAD, [
            entry({ newId: refs['refs/heads/b000'] as ObjectId, identity: identityAt(now) }),
          ]);
          const ctx: Context = { ...base, concurrency: { cpuBound: 1, ioBound } };
          const headsDir = `${ctx.layout.gitDir}/refs/heads/`;
          let inFlight = 0;
          let maxInFlight = 0;
          const originalReadUtf8 = ctx.fs.readUtf8.bind(ctx.fs);
          const instrumented: Context = {
            ...ctx,
            fs: {
              ...ctx.fs,
              readUtf8: async (path: string) => {
                if (!path.startsWith(headsDir)) return originalReadUtf8(path);
                inFlight += 1;
                if (inFlight > maxInFlight) maxInFlight = inFlight;
                await Promise.resolve();
                inFlight -= 1;
                return originalReadUtf8(path);
              },
            },
          };

          // Act
          await reflog(instrumented, { action: 'expire', all: true });

          // Assert
          expect(maxInFlight).toBeGreaterThan(1);
        });
      });
    });

    describe('the pinned reachability matrix', () => {
      const EPOCH = 1_700_000_000;

      /**
       * `main` committed A then B; `side` branched off B and added C; `main`
       * was then reset back to A. So `main`'s own tip is A (B is reachable
       * only through `side`), and `main`'s log records `0→A`, `A→B`, `B→A`.
       * `HEAD` mirrors that plus the checkout to `side` and back, so its log
       * never names an object outside {A, B, C}.
       */
      const buildMainAndSideFixture = async (): Promise<{
        readonly ctx: Context;
      }> => {
        const ctx = createMemoryContext();
        const a = await writeCommit(ctx, [], EPOCH);
        const b = await writeCommit(ctx, [a], EPOCH + 100);
        const c = await writeCommit(ctx, [b], EPOCH + 200);
        await seedRepo(ctx, { refs: { 'refs/heads/main': a, 'refs/heads/side': c } });
        await writeReflog(ctx, BRANCH, [
          entry({ oldId: ZERO_OID, newId: a, identity: identityAt(EPOCH), message: 'initial' }),
          entry({ oldId: a, newId: b, identity: identityAt(EPOCH + 100), message: 'advance' }),
          entry({ oldId: b, newId: a, identity: identityAt(EPOCH + 200), message: 'reset' }),
        ]);
        await writeReflog(ctx, HEAD, [
          entry({ oldId: ZERO_OID, newId: a, identity: identityAt(EPOCH), message: 'initial' }),
          entry({ oldId: a, newId: b, identity: identityAt(EPOCH + 100), message: 'advance' }),
          entry({
            oldId: b,
            newId: b,
            identity: identityAt(EPOCH + 125),
            message: 'checkout side',
          }),
          entry({ oldId: b, newId: c, identity: identityAt(EPOCH + 150), message: 'commit c' }),
          entry({
            oldId: c,
            newId: b,
            identity: identityAt(EPOCH + 175),
            message: 'checkout main',
          }),
          entry({ oldId: b, newId: a, identity: identityAt(EPOCH + 200), message: 'reset' }),
        ]);
        return { ctx };
      };

      describe('Given main reset back behind a side branch that kept a newer commit', () => {
        describe('When expire runs with --expire=now --expire-unreachable=never on refs/heads/main', () => {
          it('Then every entry expires unconditionally, without a walk', async () => {
            // Arrange
            const { ctx } = await buildMainAndSideFixture();

            // Act
            const result = await reflog(ctx, {
              action: 'expire',
              ref: 'refs/heads/main',
              expire: 'now',
              expireUnreachable: 'never',
            });

            // Assert
            expect(result).toEqual({ kind: 'expire', removed: 3, kept: 0 });
          });
        });

        describe('When expire runs with --expire=never --expire-unreachable=now on refs/heads/main', () => {
          it('Then only the entry landing on the tip itself survives', async () => {
            // Arrange — reachability is measured from `main`'s own tip (A),
            // not from every ref: `A→B` and `B→A` both name B, which is
            // reachable only through `side`, so both expire.
            const { ctx } = await buildMainAndSideFixture();

            // Act
            const result = await reflog(ctx, {
              action: 'expire',
              ref: 'refs/heads/main',
              expire: 'never',
              expireUnreachable: 'now',
            });

            // Assert
            expect(result).toEqual({ kind: 'expire', removed: 2, kept: 1 });
          });
        });

        describe('When expire runs with --expire=never --expire-unreachable=now on HEAD', () => {
          it('Then every entry survives because HEAD marks from every current tip', async () => {
            // Arrange — the same cutoffs as the previous case, but against
            // HEAD: marking from every tip (main=A, side=C) reaches A, B and
            // C, so nothing in this log is unreachable.
            const { ctx } = await buildMainAndSideFixture();

            // Act
            const result = await reflog(ctx, {
              action: 'expire',
              ref: 'HEAD',
              expire: 'never',
              expireUnreachable: 'now',
            });

            // Assert
            expect(result).toEqual({ kind: 'expire', removed: 0, kept: 6 });
          });
        });

        describe('When expire runs with --expire=never --expire-unreachable=never on refs/heads/main', () => {
          it('Then every entry survives and reachability is never consulted', async () => {
            // Arrange
            const { ctx } = await buildMainAndSideFixture();

            // Act
            const result = await reflog(ctx, {
              action: 'expire',
              ref: 'refs/heads/main',
              expire: 'never',
              expireUnreachable: 'never',
            });

            // Assert
            expect(result).toEqual({ kind: 'expire', removed: 0, kept: 3 });
          });
        });

        describe('When expire runs with explicit numeric cutoffs on refs/heads/main', () => {
          it('Then each entry is judged on its own timestamp and reachability', async () => {
            // Arrange — `0→A` (ts EPOCH) is below the total cutoff and
            // expires unconditionally; `A→B` (ts EPOCH+100) is between the
            // two cutoffs and expires because B is unreachable from A;
            // `B→A` (ts EPOCH+200) is at or above the unreachable cutoff and
            // is kept without a reachability check.
            const { ctx } = await buildMainAndSideFixture();

            // Act
            const result = await reflog(ctx, {
              action: 'expire',
              ref: 'refs/heads/main',
              expire: `@${EPOCH + 50}`,
              expireUnreachable: `@${EPOCH + 150}`,
            });

            // Assert
            expect(result).toEqual({ kind: 'expire', removed: 2, kept: 1 });
          });
        });
      });

      describe('Given a later commit created on main then reset away', () => {
        /**
         * `main`'s tip ends at B; a fourth commit D was made from B and then
         * reset away, so D is a child of B but unreachable from any current
         * tip — the log records `0→A`, `A→B`, `B→D`, `D→B`.
         */
        const buildMainWithDFixture = async (): Promise<{ readonly ctx: Context }> => {
          const ctx = createMemoryContext();
          const a = await writeCommit(ctx, [], EPOCH);
          const b = await writeCommit(ctx, [a], EPOCH + 100);
          const d = await writeCommit(ctx, [b], EPOCH + 300);
          await seedRepo(ctx, { refs: { 'refs/heads/main': b } });
          await writeReflog(ctx, BRANCH, [
            entry({ oldId: ZERO_OID, newId: a, identity: identityAt(EPOCH), message: 'initial' }),
            entry({ oldId: a, newId: b, identity: identityAt(EPOCH + 100), message: 'advance' }),
            entry({
              oldId: b,
              newId: d,
              identity: identityAt(EPOCH + 200),
              message: 'advance again',
            }),
            entry({ oldId: d, newId: b, identity: identityAt(EPOCH + 200), message: 'reset away' }),
          ]);
          return { ctx };
        };

        describe('When expire runs with --expire=now --expire-unreachable=never', () => {
          it('Then every entry expires unconditionally', async () => {
            // Arrange
            const { ctx } = await buildMainWithDFixture();

            // Act
            const result = await reflog(ctx, {
              action: 'expire',
              ref: 'refs/heads/main',
              expire: 'now',
              expireUnreachable: 'never',
            });

            // Assert
            expect(result).toEqual({ kind: 'expire', removed: 4, kept: 0 });
          });
        });

        describe('When expire runs with --expire=never --expire-unreachable=now', () => {
          it('Then the entries naming the unreachable commit expire on either side', async () => {
            // Arrange — D is unreachable from B (main's tip): `B→D` expires
            // because its NEW id is unreachable, `D→B` expires because its
            // OLD id is unreachable — proving both sides are checked.
            const { ctx } = await buildMainWithDFixture();

            // Act
            const result = await reflog(ctx, {
              action: 'expire',
              ref: 'refs/heads/main',
              expire: 'never',
              expireUnreachable: 'now',
            });

            // Assert
            expect(result).toEqual({ kind: 'expire', removed: 2, kept: 2 });
          });
        });

        describe('When expire runs with an unreachable cutoff not later than the total cutoff', () => {
          it('Then only the clock decides and reachability is never consulted', async () => {
            // Arrange — the unreachable cutoff (EPOCH+50) is earlier than
            // the total cutoff (EPOCH+150), so every entry's fate is decided
            // by its own timestamp alone.
            const { ctx } = await buildMainWithDFixture();

            // Act
            const result = await reflog(ctx, {
              action: 'expire',
              ref: 'refs/heads/main',
              expire: `@${EPOCH + 150}`,
              expireUnreachable: `@${EPOCH + 50}`,
            });

            // Assert
            expect(result).toEqual({ kind: 'expire', removed: 2, kept: 2 });
          });
        });
      });
    });

    describe('Given an entry whose old object id alone is unreachable', () => {
      describe('When expire evaluates it', () => {
        it('Then it expires even though the new object id is reachable', async () => {
          // Arrange — todays keep rule consulted `newId` only; here the OLD
          // id is the unreachable one, proving both sides are checked.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          const island = await writeCommit(ctx, [], now - 1);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({
              oldId: island,
              newId: tip,
              identity: identityAt(now - 45 * DAY),
              message: 'old unreachable',
            }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 1, kept: 0 });
        });
      });
    });

    describe('Given an entry whose old object id is the null object id', () => {
      describe('When expire evaluates it', () => {
        it('Then the null id never counts as unreachable', async () => {
          // Arrange — without the null-id guard, peeling `0000…` would throw
          // rather than keep the entry.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ oldId: ZERO_OID, newId: tip, identity: identityAt(now - 45 * DAY) }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
        });
      });
    });

    describe('Given an entry whose new object id is not a commit', () => {
      describe('When expire evaluates it', () => {
        it('Then the non-commit id never counts as unreachable', async () => {
          // Arrange
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          const blobId = await writeObject(ctx, {
            type: 'blob',
            id: '' as ObjectId,
            content: new TextEncoder().encode('x'),
          });
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ oldId: tip, newId: blobId, identity: identityAt(now - 45 * DAY) }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
        });
      });
    });

    describe('Given an entry whose new object id names an object that was never written', () => {
      describe('When expire evaluates it', () => {
        it('Then the missing object is a gentle-lookup miss, not a thrown error, and the entry is kept', async () => {
          // Arrange — git's `lookup_commit_reference_gently` returns NULL on
          // any resolution failure, a pruned-but-still-named object included;
          // the caller keeps the entry rather than aborting the whole expire.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ oldId: tip, newId: OID_X, identity: identityAt(now - 45 * DAY) }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
        });
      });
    });

    describe('Given peeling an object id raises an error unrelated to a missing object', () => {
      describe('When expire evaluates reachability', () => {
        it('Then the error propagates rather than being treated as a gentle-lookup miss', async () => {
          // Arrange — narrows the gentle-lookup catch to the one code git's
          // NULL-on-any-failure keep rule actually covers; anything else
          // (a corrupt object, an aborted read) must not be swallowed.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ oldId: tip, newId: OID_X, identity: identityAt(now - 45 * DAY) }),
          ]);
          const original = readObjectMod.readObject;
          const boom = new TsgitError({ code: 'OPERATION_ABORTED' });
          const spy = vi
            .spyOn(readObjectMod, 'readObject')
            .mockImplementation(async (readCtx, id, options) =>
              id === OID_X ? Promise.reject(boom) : original(readCtx, id, options),
            );

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'expire', ref: 'HEAD' });
            expect.unreachable();
          } catch (err) {
            caught = err;
          } finally {
            spy.mockRestore();
          }

          // Assert
          expect(caught).toBe(boom);
        });
      });
    });

    describe('Given a detached HEAD pointing to a commit no ref under refs/ names', () => {
      describe('When expire runs against HEAD', () => {
        it('Then HEAD itself is not a tip — the entry naming the detached commit expires', async () => {
          // Arrange — git seeds `UE_HEAD`'s mark list via `refs_for_each_ref`,
          // refs under `refs/` only; `HEAD` is never pushed as a tip in its
          // own right, detached or not. `main` (the only ref) sits at A; B is
          // reachable only by way of the detached HEAD.
          const now = wallNow();
          const ctx = createMemoryContext();
          const a = await writeCommit(ctx, [], now - 40 * DAY);
          const b = await writeCommit(ctx, [a], now - 20 * DAY);
          await seedRepo(ctx, { refs: { 'refs/heads/main': a }, head: b });
          await writeReflog(ctx, HEAD, [
            entry({ oldId: a, newId: b, identity: identityAt(now - 35 * DAY) }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert — without the fix, resolving `HEAD` itself as a tip marks
          // B reachable and keeps this entry instead.
          expect(result).toEqual({ kind: 'expire', removed: 1, kept: 0 });
        });
      });
    });

    describe('Given a missing ancestor reached mid-walk through a sibling parent link', () => {
      describe('When expire runs', () => {
        it('Then the missing ancestor is skipped rather than aborting the walk, and the reachable sibling is still found', async () => {
          // Arrange — Mid is a merge of `missing` (never written) and `g`
          // (real); `missing` sorts first in the parent list, so the walk
          // hits and skips it before it ever reaches `g`. Without the fix,
          // `readCommitMeta(missing)` throws and the whole expire aborts.
          const now = wallNow();
          const ctx = createMemoryContext();
          const g = await writeCommit(ctx, [], now - 60 * DAY);
          const missing = 'e'.repeat(40) as ObjectId;
          const mid = await writeCommit(ctx, [missing, g], now - 40 * DAY);
          const tip = await writeCommit(ctx, [mid], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ oldId: ZERO_OID, newId: g, identity: identityAt(now - 45 * DAY) }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
        });
      });
    });

    describe('Given reading an ancestor raises an error unrelated to a missing object', () => {
      describe('When expire expands the frontier', () => {
        it('Then the error propagates rather than being treated as a skippable parse failure', async () => {
          // Arrange — narrows git's gentle `repo_parse_commit` skip to the
          // one failure mode it actually covers; anything else must abort
          // the walk, not silently leave the ancestor unmarked.
          const now = wallNow();
          const ctx = createMemoryContext();
          const parent = await writeCommit(ctx, [], now - 10 * DAY);
          const tip = await writeCommit(ctx, [parent], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ oldId: ZERO_OID, newId: parent, identity: identityAt(now - 45 * DAY) }),
          ]);
          const original = readCommitMetaMod.readCommitMeta;
          const boom = new TsgitError({ code: 'OPERATION_ABORTED' });
          const spy = vi
            .spyOn(readCommitMetaMod, 'readCommitMeta')
            .mockImplementation(async (metaCtx, id) =>
              id === parent ? Promise.reject(boom) : original(metaCtx, id),
            );

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'expire', ref: 'HEAD' });
            expect.unreachable();
          } catch (err) {
            caught = err;
          } finally {
            spy.mockRestore();
          }

          // Assert
          expect(caught).toBe(boom);
        });
      });
    });

    describe('Given a named ref whose tip is not a commit', () => {
      describe('When expire runs on it with a middle-band timestamp', () => {
        it('Then the entry expires without a reachability check', async () => {
          // Arrange — a ref resolving straight to a blob peels to nothing,
          // so it expires by clock alone. Both ids are null (always
          // "reachable"), so only the clock-alone path explains the expiry.
          const now = wallNow();
          const ctx = createMemoryContext();
          const blobId = await writeObject(ctx, {
            type: 'blob',
            id: '' as ObjectId,
            content: new TextEncoder().encode('x'),
          });
          await seedRepo(ctx, { refs: { 'refs/heads/weird': blobId } });
          await writeReflog(ctx, 'refs/heads/weird' as RefName, [
            entry({ oldId: ZERO_OID, newId: ZERO_OID, identity: identityAt(now - 45 * DAY) }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'refs/heads/weird' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 1, kept: 0 });
        });
      });
    });

    describe('Given a named ref that no longer resolves but whose reflog file remains', () => {
      describe('When expire runs against it directly with a middle-band timestamp', () => {
        it('Then the entry expires without a reachability check', async () => {
          // Arrange — the ref file itself is never created, only its log;
          // `resolveDirect` answers `missing`, so the log expires by clock
          // alone, same as a ref resolving to a non-commit.
          const now = wallNow();
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, BRANCH, [
            entry({ oldId: ZERO_OID, newId: ZERO_OID, identity: identityAt(now - 45 * DAY) }),
          ]);

          // Act
          const result = await reflog(ctx, { action: 'expire', ref: 'refs/heads/main' });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 1, kept: 0 });
        });
      });
    });

    describe('Given a cutoff pair where the unreachable clock is not later than the total clock', () => {
      describe('When expire runs', () => {
        it('Then it never reads a single object', async () => {
          // Arrange — `--expire=now --expire-unreachable=never`: reachability
          // could never change the verdict, so the walk is skipped outright
          // rather than merely producing an unused result.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(now - 45 * DAY) }),
          ]);
          const spy = vi.spyOn(readObjectMod, 'readObject');

          // Act
          let calls: number;
          try {
            await reflog(ctx, {
              action: 'expire',
              ref: 'HEAD',
              expire: 'now',
              expireUnreachable: 'never',
            });
            calls = spy.mock.calls.length;
          } finally {
            spy.mockRestore();
          }

          // Assert
          expect(calls).toBe(0);
        });
      });
    });

    describe('Given a cutoff pair where the unreachable clock is later than the total clock', () => {
      describe('When expire runs', () => {
        it('Then it does read objects — the positive control proving the spy above actually intercepts', async () => {
          // Arrange — same fixture as the sibling "never reads a single
          // object" test, but with the cutoffs reversed so the walk is NOT
          // skipped. Without this control, a spy that silently fails to
          // intercept `readObject` would make the sibling's `toBe(0)` pass
          // for the wrong reason.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(now - 45 * DAY) }),
          ]);
          const spy = vi.spyOn(readObjectMod, 'readObject');

          // Act
          let calls: number;
          try {
            await reflog(ctx, {
              action: 'expire',
              ref: 'HEAD',
              expire: 'never',
              expireUnreachable: 'now',
            });
            calls = spy.mock.calls.length;
          } finally {
            spy.mockRestore();
          }

          // Assert
          expect(calls).toBeGreaterThan(0);
        });
      });
    });

    describe('Given a commit chain crossing the total cutoff, reachable only through the aged commit', () => {
      describe('When expire checks reachability of a commit beyond the aged boundary', () => {
        it('Then the bound is dropped on a miss and the entry is kept, not expired', async () => {
          // Arrange — tip T is young enough to expand into its parent P; P is
          // already below the total cutoff, so the bounded pass marks P but
          // does not expand it, leaving grandparent G unreached. git's date
          // bound is laziness only: the first miss on G drops the bound and
          // re-expands P, so G is found and the entry naming it survives.
          const epoch = 1_700_000_000;
          const ctx = createMemoryContext();
          const g = await writeCommit(ctx, [], epoch);
          const p = await writeCommit(ctx, [g], epoch + 50);
          const t = await writeCommit(ctx, [p], epoch + 150);
          await seedRepo(ctx, { refs: { 'refs/heads/main': t } });
          await writeReflog(ctx, BRANCH, [
            entry({ oldId: ZERO_OID, newId: g, identity: identityAt(epoch + 200) }),
          ]);
          const spy = vi.spyOn(readCommitMetaMod, 'readCommitMeta');

          // Act
          let result: ReflogResult;
          let visited: ReadonlyArray<ObjectId>;
          try {
            result = await reflog(ctx, {
              action: 'expire',
              ref: 'refs/heads/main',
              expire: `@${epoch + 100}`,
              expireUnreachable: `@${epoch + 300}`,
            });
            visited = spy.mock.calls.map(([, id]) => id);
          } finally {
            spy.mockRestore();
          }

          // Assert — the entry is kept (not removed), and P is visited twice:
          // once during the bounded pass (marked, not expanded — the "first
          // miss" on G has not happened yet), and again only after that miss
          // drops the bound, this time expanding into G.
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 1 });
          expect(visited).toContain(t);
          const pVisitIndexes = visited.reduce<number[]>(
            (acc, id, index) => (id === p ? [...acc, index] : acc),
            [],
          );
          expect(pVisitIndexes).toHaveLength(2);
          expect(visited.indexOf(g)).toBeGreaterThan(pVisitIndexes[1] as number);
        });
      });
    });
  });
});
