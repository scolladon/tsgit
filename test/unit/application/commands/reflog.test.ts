import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { reflog } from '../../../../src/application/commands/reflog.js';
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
import { parseApproxidate } from '../../../../src/domain/reflog/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

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
          const sut = await reflog(ctx, { action: 'show' });

          // Assert
          expect(sut.kind).toBe('show');
          if (sut.kind !== 'show') throw new Error('unreachable');
          expect(sut.ref).toBe(HEAD);
          expect(sut.entries).toEqual([
            { index: 0, selector: 'HEAD@{0}', entry: third },
            { index: 1, selector: 'HEAD@{1}', entry: second },
            { index: 2, selector: 'HEAD@{2}', entry: first },
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
          const sut = await reflog(ctx);

          // Assert
          expect(sut.kind).toBe('show');
          if (sut.kind !== 'show') throw new Error('unreachable');
          expect(sut.ref).toBe(HEAD);
          expect(sut.entries).toHaveLength(1);
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
          const sut = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert
          expect(sut.kind === 'show' && sut.ref).toBe(BRANCH);
          expect(sut.kind === 'show' && sut.entries[0]?.selector).toBe('refs/heads/main@{0}');
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
          const sut = await reflog(ctx, { action: 'show', ref: 'refs/heads/missing' });

          // Assert
          expect(sut.kind === 'show' && sut.entries).toEqual([]);
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
          const sut = await reflog(ctx, { action: 'exists', ref: 'refs/heads/main' });

          // Assert
          expect(sut).toEqual({ kind: 'exists', exists: true });
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
          const sut = await reflog(ctx, { action: 'exists', ref: 'refs/heads/main' });

          // Assert
          expect(sut).toEqual({ kind: 'exists', exists: false });
        });
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
          const sut = await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 1 });

          // Assert
          expect(sut).toEqual({ kind: 'delete', removed: second });
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([
            third,
            first,
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
          const sut = await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 0 });

          // Assert
          expect(sut.kind === 'delete' && sut.removed).toEqual(second);
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([first]);
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
          // newest-first: third (repaired), first
          expect(repaired).toEqual([{ ...third, oldId: OID_X }, first]);
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

          // Assert
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([first]);
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

          // Assert
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([
            third,
            first,
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
          const sut = await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 1 });

          // Assert — the oldest entry is removed, not rejected as out of range.
          expect(sut).toEqual({ kind: 'delete', removed: first });
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([second]);
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

    describe('Given an index past the last entry', () => {
      describe('When delete', () => {
        it('Then throws REFLOG_ENTRY_OUT_OF_RANGE with requested and available', async () => {
          // Arrange — two entries, index 2 is out of range.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, HEAD, [entry(), entry({ oldId: OID_X, newId: OID_Y })]);

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 2 });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFLOG_ENTRY_OUT_OF_RANGE',
            ref: 'HEAD',
            requested: 2,
            available: 2,
          });
        });
      });
    });

    describe('Given a negative index', () => {
      describe('When delete', () => {
        it('Then throws REFLOG_ENTRY_OUT_OF_RANGE', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, HEAD, [entry()]);

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'delete', ref: 'HEAD', index: -1 });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REFLOG_ENTRY_OUT_OF_RANGE',
            ref: 'HEAD',
            requested: -1,
            available: 1,
          });
        });
      });
    });

    describe('Given an empty reflog file', () => {
      describe('When delete index 0', () => {
        it('Then throws REFLOG_ENTRY_OUT_OF_RANGE', async () => {
          // Arrange — the file exists (so not REFLOG_NOT_FOUND) but holds no entries.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, HEAD, []);

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 0 });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REFLOG_ENTRY_OUT_OF_RANGE',
            ref: 'HEAD',
            requested: 0,
            available: 0,
          });
        });
      });
    });

    describe('Given a NaN index', () => {
      describe('When delete', () => {
        it('Then throws REFLOG_ENTRY_OUT_OF_RANGE with the NaN requested', async () => {
          // Arrange — NaN would index `stored[NaN]` as `undefined` and bypass the
          // range guard; the integer guard must reject it.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, HEAD, [entry()]);

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'delete', ref: 'HEAD', index: Number.NaN });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFLOG_ENTRY_OUT_OF_RANGE',
            ref: 'HEAD',
            requested: Number.NaN,
            available: 1,
          });
        });
      });
    });

    describe('Given a fractional index', () => {
      describe('When delete', () => {
        it('Then throws REFLOG_ENTRY_OUT_OF_RANGE', async () => {
          // Arrange — 1.5 is in range numerically but is not a valid entry index.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});
          await writeReflog(ctx, HEAD, [entry(), entry({ oldId: OID_X, newId: OID_Y })]);

          // Act
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'delete', ref: 'HEAD', index: 1.5 });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFLOG_ENTRY_OUT_OF_RANGE',
            ref: 'HEAD',
            requested: 1.5,
            available: 2,
          });
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
          const sut = await reflog(ctx, { action: 'show', ref: 'HEAD' });

          // Assert
          expect(sut.kind === 'show' && sut.ref).toBe(HEAD);
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
          const sut = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert
          expect(sut.kind === 'show' && sut.ref).toBe(BRANCH);
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
          const sut = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(sut).toEqual({ kind: 'expire', removed: 1, kept: 0 });
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
          const sut = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(sut).toEqual({ kind: 'expire', removed: 0, kept: 1 });
        });
      });
    });

    describe('Given an unreachable entry between the two cutoffs', () => {
      describe('When expire', () => {
        it('Then it is pruned on the shorter unreachable clock', async () => {
          // Arrange — an entry 45 days old whose newId is NOT a reachable commit.
          // Reachable cutoff is 90 days (would keep it); unreachable cutoff is 30
          // days (prunes it). The unreachable clock must win.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          const middling = now - 45 * DAY;
          await writeReflog(ctx, HEAD, [
            entry({ newId: OID_X, identity: identityAt(middling), message: 'unreachable' }),
          ]);

          // Act
          const sut = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(sut).toEqual({ kind: 'expire', removed: 1, kept: 0 });
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
          const sut = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(sut).toEqual({ kind: 'expire', removed: 0, kept: 1 });
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
          const sut = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert
          expect(sut).toEqual({ kind: 'expire', removed: 0, kept: 1 });
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
          const sut = await reflog(ctx, {
            action: 'expire',
            ref: 'HEAD',
            expire: '3.days.ago',
            expireUnreachable: '1.day.ago',
          });

          // Assert
          expect(sut).toEqual({ kind: 'expire', removed: 1, kept: 0 });
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
          const sut = await reflog(ctx, { action: 'expire', all: true });

          // Assert — both stale entries pruned.
          expect(sut).toEqual({ kind: 'expire', removed: 2, kept: 0 });
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
          const sut = await reflog(ctx, { action: 'expire' });

          // Assert — only HEAD's single entry pruned; the branch log untouched.
          expect(sut).toEqual({ kind: 'expire', removed: 1, kept: 0 });
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
          const sut = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert — kept proves the parent was walked into the reachable set; an
          // unreachable 50-day entry would be pruned on the 30-day clock.
          expect(sut).toEqual({ kind: 'expire', removed: 0, kept: 1 });
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
        it('Then nothing is removed and kept is zero', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          const sut = await reflog(ctx, { action: 'expire', ref: 'refs/heads/missing' });

          // Assert
          expect(sut).toEqual({ kind: 'expire', removed: 0, kept: 0 });
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

    describe('Given no entry is stale enough to prune', () => {
      describe('When expire', () => {
        it('Then the reflog file is not rewritten', async () => {
          // Arrange — two recent reachable entries; nothing crosses the cutoff. The
          // write-back must be skipped entirely (the count equality short-circuits
          // it), so the reflog path receives no `writeUtf8` call.
          const now = wallNow();
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, [], now);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, HEAD, [
            entry({ newId: tip, identity: identityAt(now - 2 * DAY), message: 'first recent' }),
            entry({ newId: tip, identity: identityAt(now - 1 * DAY), message: 'second recent' }),
          ]);
          const reflogPath = `${ctx.layout.gitDir}/logs/HEAD`;
          const writes: string[] = [];
          const spiedCtx: Context = {
            ...ctx,
            fs: {
              ...ctx.fs,
              writeUtf8: (path: string, content: string): Promise<void> => {
                writes.push(path);
                return ctx.fs.writeUtf8(path, content);
              },
            },
          };

          // Act
          const sut = await reflog(spiedCtx, { action: 'expire', ref: 'HEAD' });

          // Assert — nothing pruned, and the reflog file was never rewritten.
          expect(sut).toEqual({ kind: 'expire', removed: 0, kept: 2 });
          expect(writes).not.toContain(reflogPath);
          const after = await reflog(ctx, { action: 'show', ref: 'HEAD' });
          expect(after.kind === 'show' && after.entries.map((e) => e.entry.message)).toEqual([
            'second recent',
            'first recent',
          ]);
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
          const sut = await reflog(ctx, { action: 'expire', ref: 'HEAD', expire: '2024-06-01' });

          // Assert — the boundary entry is kept, not pruned.
          expect(sut).toEqual({ kind: 'expire', removed: 0, kept: 1 });
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
          const sut = await reflog(ctx, { action: 'expire', ref: 'HEAD' });

          // Assert — the unreachable stale entry is pruned; no throw on the missing tip.
          expect(sut).toEqual({ kind: 'expire', removed: 1, kept: 0 });
        });
      });
    });
  });
});
