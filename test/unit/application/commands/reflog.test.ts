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
  it('Given a non-repo ctx, When reflog, Then throws NOT_A_REPOSITORY', async () => {
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

  describe('show', () => {
    it('Given a reflog with three entries, When reflog show, Then entries are newest-first with index and selector', async () => {
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

    it('Given no action, When reflog with no opts, Then it defaults to show on HEAD', async () => {
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

    it('Given an explicit branch ref, When reflog show, Then it reads that branch reflog', async () => {
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

    it('Given a ref with no reflog file, When reflog show, Then it returns an empty entry list (not an error)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});

      // Act
      const sut = await reflog(ctx, { action: 'show', ref: 'refs/heads/missing' });

      // Assert
      expect(sut.kind === 'show' && sut.entries).toEqual([]);
    });
  });

  describe('exists', () => {
    it('Given a ref with a reflog, When reflog exists, Then returns true', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      await appendReflog(ctx, BRANCH, entry());

      // Act
      const sut = await reflog(ctx, { action: 'exists', ref: 'refs/heads/main' });

      // Assert
      expect(sut).toEqual({ kind: 'exists', exists: true });
    });

    it('Given a ref with no reflog, When reflog exists, Then returns false', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});

      // Act
      const sut = await reflog(ctx, { action: 'exists', ref: 'refs/heads/main' });

      // Assert
      expect(sut).toEqual({ kind: 'exists', exists: false });
    });
  });

  describe('delete', () => {
    it('Given a three-entry reflog, When delete index 1, Then the middle entry is dropped and returned', async () => {
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
      expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([third, first]);
    });

    it('Given delete index 0 (newest), When delete, Then the newest entry is removed', async () => {
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

    it('Given rewrite=true deleting a middle entry, When delete, Then the following entry oldId is repaired', async () => {
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

    it('Given rewrite=true deleting the oldest entry, When delete, Then no following entry exists and nothing else changes', async () => {
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

    it('Given rewrite is omitted, When delete a middle entry, Then the following entry oldId is NOT repaired', async () => {
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
      expect(after.kind === 'show' && after.entries.map((e) => e.entry)).toEqual([third, first]);
    });

    it('Given a ref with no reflog file, When delete, Then throws REFLOG_NOT_FOUND with the ref', async () => {
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

    it('Given an index past the last entry, When delete, Then throws REFLOG_ENTRY_OUT_OF_RANGE with requested and available', async () => {
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

    it('Given a negative index, When delete, Then throws REFLOG_ENTRY_OUT_OF_RANGE', async () => {
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

    it('Given an empty reflog file, When delete index 0, Then throws REFLOG_ENTRY_OUT_OF_RANGE', async () => {
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

  describe('expire', () => {
    // `expire` reads `Date.now()` internally for the cutoff; entry timestamps
    // are therefore relative to the real wall clock, not a frozen instant.
    const DAY = 86_400;
    const wallNow = (): number => Math.floor(Date.now() / 1000);

    it('Given a reachable entry older than the expire cutoff, When expire, Then it is pruned', async () => {
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

    it('Given a reachable recent entry, When expire, Then it is kept', async () => {
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

    it('Given an unreachable entry between the two cutoffs, When expire, Then it is pruned on the shorter unreachable clock', async () => {
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

    it('Given an unreachable entry newer than the unreachable cutoff, When expire, Then it is kept', async () => {
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

    it('Given a reachable entry just past the 90-day cutoff, When expire, Then the reachable clock prunes it (not the unreachable clock)', async () => {
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

    it('Given explicit expire and expireUnreachable cutoffs, When expire, Then both are honoured', async () => {
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

    it('Given all=true, When expire, Then every reflog file from listReflogs is processed', async () => {
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

    it('Given expire defaults to HEAD, When expire with no ref and no all, Then only the HEAD log is touched', async () => {
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

    it('Given a reachable entry through a parent commit, When expire, Then the walk marks it reachable', async () => {
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

    it('Given an unparseable expire cutoff, When expire, Then throws REVPARSE_UNRESOLVED with the cutoff string', async () => {
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

    it('Given an unparseable expireUnreachable cutoff, When expire, Then throws REVPARSE_UNRESOLVED with that string', async () => {
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

    it('Given a missing reflog, When expire, Then nothing is removed and kept is zero', async () => {
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
