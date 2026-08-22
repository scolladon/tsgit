import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { loadReftableStack } from '../../../../src/application/primitives/load-reftable-stack.js';
import {
  reftableTableLockPath,
  tablesListLockPath,
  tablesListPath,
} from '../../../../src/application/primitives/path-layout.js';
import { createReftableRefStore } from '../../../../src/application/primitives/reftable-ref-store.js';
import { applyReftableUpdates } from '../../../../src/application/primitives/reftable-transaction.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import {
  iterateReftableLogs,
  iterateReftableRefs,
  type ReftableLogRecord,
  type ReftableRefRecord,
  serializeReftable,
} from '../../../../src/domain/refs/index.js';
import {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_RESTART_INTERVAL,
  type ReftableWriteOptions,
} from '../../../../src/domain/refs/reftable/reftable-writer.js';
import type { Context } from '../../../../src/ports/context.js';
import type { FileSystem } from '../../../../src/ports/file-system.js';
import { commonReftableDir, withReftableStorage, writeReftableFiles } from './reftable-fixtures.js';

const oid = (fill: number): ObjectId => ObjectId.fromRaw(new Uint8Array(20).fill(fill));
const ref = (name: string): RefName => RefName.from(name);

const liveRef = (name: string, id: number, updateIndex: number): ReftableRefRecord => ({
  name: ref(name),
  updateIndex: BigInt(updateIndex),
  value: { kind: 'direct', id: oid(id) },
});

const tombstoneRef = (name: string, updateIndex: number): ReftableRefRecord => ({
  name: ref(name),
  updateIndex: BigInt(updateIndex),
  value: { kind: 'deletion' },
});

const tombstoneLog = (name: string, updateIndex: number): ReftableLogRecord => ({
  name: ref(name),
  updateIndex: BigInt(updateIndex),
  entry: { kind: 'deletion' },
});

/** `count` filler live refs at `updateIndex` — zero-padded names, already
 *  name-sorted, so a fixture table can be inflated far past the size of a
 *  1-ref table without touching `serializeReftable`'s sort contract. */
const fillerRefs = (count: number, updateIndex: number): ReftableRefRecord[] =>
  Array.from({ length: count }, (_, i) =>
    liveRef(`refs/heads/filler${String(i).padStart(4, '0')}`, (i % 250) + 1, updateIndex),
  );

/** Builds one hand-placed reftable table's bytes — the same codec
 *  `applyReftableUpdates` itself writes through, so a fixture built here
 *  round-trips through the real reader/writer, never a parallel format. */
async function buildFixtureTable(
  ctx: Context,
  refs: readonly ReftableRefRecord[],
  logs: readonly ReftableLogRecord[],
  minUpdateIndex: bigint,
  maxUpdateIndex: bigint,
): Promise<Uint8Array> {
  const options: ReftableWriteOptions = {
    hashId: 'sha1',
    blockSize: DEFAULT_BLOCK_SIZE,
    restartInterval: DEFAULT_RESTART_INTERVAL,
    indexObjects: true,
    minUpdateIndex,
    maxUpdateIndex,
  };
  return serializeReftable(refs, logs, options, ctx.compressor.deflate);
}

/** Reframes a Context onto a `fs` that omits `atomicRename` — the browser
 *  adapter's own shape (Part 7) — while sharing the SAME underlying memory
 *  filesystem instance, so a degraded-path Context and its atomic sibling
 *  observe each other's writes. */
function withoutAtomicRename(ctx: Context): Context {
  const { atomicRename: _atomicRename, ...rest } = ctx.fs as FileSystem & {
    readonly atomicRename?: unknown;
  };
  return { ...ctx, fs: rest as FileSystem };
}

const adminDir = (ctx: Context): string => `${ctx.layout.gitDir}/worktrees/wt`;
const asWorktreeChild = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, gitDir: adminDir(ctx), commonDir: ctx.layout.gitDir },
});

async function expectReftableLocked(
  act: () => Promise<void>,
): Promise<{ readonly stack: string; readonly reason: string }> {
  try {
    await act();
    expect.unreachable('expected REFTABLE_LOCKED');
  } catch (err) {
    const data = (err as TsgitError).data;
    if (data.code !== 'REFTABLE_LOCKED') {
      expect.fail(`expected REFTABLE_LOCKED, got ${data.code}`);
    }
    return data;
  }
  throw new Error('unreachable');
}

describe('reftable-transaction', () => {
  describe('Given a stack and a two-ref update list', () => {
    describe('When the transaction commits', () => {
      it('Then both refs appear at one update index', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const idA = oid(0x01);
        const idB = oid(0x02);

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/a'), id: idA },
          { kind: 'set', name: ref('refs/heads/b'), id: idB },
        ]);

        // Assert
        const store = createReftableRefStore(ctx);
        expect(await store.resolveDirect(ref('refs/heads/a'))).toEqual({ kind: 'direct', id: idA });
        expect(await store.resolveDirect(ref('refs/heads/b'))).toEqual({ kind: 'direct', id: idB });
        const stack = await loadReftableStack(ctx, dir);
        const records = [...iterateReftableRefs(stack.tables[0]!)];
        expect(records.every((r) => r.updateIndex === 1n)).toBe(true);
      });
    });

    describe('When the transaction commits, and tables.list is inspected', () => {
      it('Then tables.list gains exactly one entry, LF-terminated including the last', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/a'), id: oid(0x01) },
        ]);

        // Assert
        const body = await ctx.fs.readUtf8(tablesListPath(ctx.layout.gitDir));
        expect(body.endsWith('\n')).toBe(true);
        const lines = body.slice(0, -1).split('\n');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^0x[0-9a-f]{12}-0x[0-9a-f]{12}-[0-9a-f]{8}\.ref$/);
      });
    });

    describe('When the transaction commits, and the lock path is observed', () => {
      it('Then the lock is created empty and removed on commit', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const lockPath = tablesListLockPath(ctx.layout.gitDir);
        const writeExclusiveSpy = vi.spyOn(ctx.fs, 'writeExclusive');

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/a'), id: oid(0x01) },
        ]);

        // Assert
        const lockCall = writeExclusiveSpy.mock.calls.find(([path]) => path === lockPath);
        expect(lockCall?.[1]).toEqual(new Uint8Array(0));
        expect(await ctx.fs.exists(lockPath)).toBe(false);
      });
    });
  });

  describe('Given an existing ref and an update carrying a mismatched expected', () => {
    describe('When the transaction is applied', () => {
      it('Then an expected mismatch refuses before any table is written', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/a'), id: oid(0x01) },
        ]);
        const before = await ctx.fs.readUtf8(tablesListPath(ctx.layout.gitDir));
        const entriesBefore = (await ctx.fs.readdir(dir)).map((e) => e.name).sort();

        // Act
        try {
          await applyReftableUpdates(ctx, [
            { kind: 'set', name: ref('refs/heads/a'), id: oid(0x02), expected: oid(0x99) },
          ]);
          expect.unreachable('expected REF_UPDATE_CONFLICT');
        } catch (err) {
          const data = (err as TsgitError).data;
          if (data.code !== 'REF_UPDATE_CONFLICT')
            expect.fail(`expected REF_UPDATE_CONFLICT, got ${data.code}`);
          expect(data.expected).toBe(oid(0x99));
          expect(data.actual).toBe(oid(0x01));
        }

        // Assert
        const after = await ctx.fs.readUtf8(tablesListPath(ctx.layout.gitDir));
        const entriesAfter = (await ctx.fs.readdir(dir)).map((e) => e.name).sort();
        expect(after).toBe(before);
        expect(entriesAfter).toEqual(entriesBefore);
        expect(entriesAfter.some((name) => name.includes('.temp.'))).toBe(false);
      });
    });
  });

  describe('Given a held tables.list.lock on the atomic path', () => {
    describe('When a transaction is attempted', () => {
      it('Then a held lock refuses with REFTABLE_LOCKED naming the lock path', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const lockPath = tablesListLockPath(ctx.layout.gitDir);
        await ctx.fs.writeExclusive(lockPath, new Uint8Array(0));

        // Act
        const data = await expectReftableLocked(() =>
          applyReftableUpdates(ctx, [{ kind: 'set', name: ref('refs/heads/a'), id: oid(0x01) }]),
        );

        // Assert
        expect(data.stack).toBe(dir);
        expect(data.reason).toContain(lockPath);
      });

      it('Then a stale lock is never broken on the atomic path', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const lockPath = tablesListLockPath(ctx.layout.gitDir);
        await ctx.fs.writeExclusive(lockPath, new Uint8Array(0));

        // Act
        await expectReftableLocked(() =>
          applyReftableUpdates(ctx, [{ kind: 'set', name: ref('refs/heads/a'), id: oid(0x01) }]),
        );

        // Assert
        expect(await ctx.fs.exists(lockPath)).toBe(true);
      });
    });
  });

  describe('Given the degraded path (no atomicRename) with a stranded lock', () => {
    describe('When the lock body equals the on-disk tables.list', () => {
      it('Then the lock is broken and the write proceeds', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/a'), id: oid(0x01) },
        ]);
        const listBody = await ctx.fs.read(tablesListPath(ctx.layout.gitDir));
        const lockPath = tablesListLockPath(ctx.layout.gitDir);
        await ctx.fs.writeExclusive(lockPath, listBody);
        const degraded = withoutAtomicRename(ctx);

        // Act
        await applyReftableUpdates(degraded, [
          { kind: 'set', name: ref('refs/heads/b'), id: oid(0x02) },
        ]);

        // Assert
        const store = createReftableRefStore(ctx);
        expect(await store.resolveDirect(ref('refs/heads/b'))).toEqual({
          kind: 'direct',
          id: oid(0x02),
        });
        expect(await ctx.fs.exists(lockPath)).toBe(false);
      });
    });

    describe('When the lock body differs from the on-disk tables.list', () => {
      it('Then it refuses REFTABLE_LOCKED', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/a'), id: oid(0x01) },
        ]);
        const lockPath = tablesListLockPath(ctx.layout.gitDir);
        await ctx.fs.writeExclusive(lockPath, new Uint8Array(0));
        const degraded = withoutAtomicRename(ctx);

        // Act + Assert
        await expectReftableLocked(() =>
          applyReftableUpdates(degraded, [
            { kind: 'set', name: ref('refs/heads/b'), id: oid(0x02) },
          ]),
        );
      });
    });
  });

  describe('Given a ref updated three times, each carrying a reflog entry', () => {
    describe('When the ref is deleted', () => {
      it('Then one ref tombstone lands at the new index and three log tombstones at indexes 1, 2 and 3', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const name = ref('refs/heads/zzz');
        for (let step = 0; step < 3; step += 1) {
          await applyReftableUpdates(ctx, [
            {
              kind: 'set',
              name,
              id: oid(step + 1),
              reflog: {
                oldId: oid(step),
                newId: oid(step + 1),
                message: `step ${step}`,
                unconditional: true,
              },
            },
          ]);
        }

        // Act
        await applyReftableUpdates(ctx, [{ kind: 'delete', name }]);

        // Assert
        const stack = await loadReftableStack(ctx, dir);
        const newest = stack.tables[stack.tables.length - 1]!;
        const refRecords = [...iterateReftableRefs(newest)].filter((r) => r.name === name);
        const logRecords = [...iterateReftableLogs(newest)].filter((r) => r.name === name);
        expect(refRecords).toHaveLength(1);
        expect(refRecords[0]?.updateIndex).toBe(4n);
        expect(refRecords[0]?.value).toEqual({ kind: 'deletion' });
        expect(logRecords.map((r) => r.updateIndex).sort()).toEqual([1n, 2n, 3n]);
        expect(logRecords.every((r) => r.entry.kind === 'deletion')).toBe(true);
      });
    });
  });

  describe('Given an update list spanning a shared ref and a per-worktree ref', () => {
    describe('When the transaction commits', () => {
      it('Then the common lock is acquired before the worktree lock, and both stacks commit', async () => {
        // Arrange
        const mainCtx = withReftableStorage(createMemoryContext());
        const worktreeCtx = asWorktreeChild(mainCtx);
        const writeExclusiveSpy = vi.spyOn(mainCtx.fs, 'writeExclusive');

        // Act
        await applyReftableUpdates(worktreeCtx, [
          { kind: 'set', name: ref('refs/heads/shared'), id: oid(0x01) },
          { kind: 'set', name: ref('refs/bisect/bad'), id: oid(0x02) },
        ]);

        // Assert
        const lockCalls = writeExclusiveSpy.mock.calls
          .map(([path]) => path as string)
          .filter((path) => path.endsWith('tables.list.lock'));
        expect(lockCalls).toEqual([
          tablesListLockPath(mainCtx.layout.gitDir),
          tablesListLockPath(worktreeCtx.layout.gitDir),
        ]);
        const commonStore = createReftableRefStore(mainCtx);
        const worktreeStore = createReftableRefStore(worktreeCtx);
        expect(await commonStore.resolveDirect(ref('refs/heads/shared'))).toEqual({
          kind: 'direct',
          id: oid(0x01),
        });
        expect(await worktreeStore.resolveDirect(ref('refs/bisect/bad'))).toEqual({
          kind: 'direct',
          id: oid(0x02),
        });
      });
    });
  });

  describe('Given a Context whose stack memo was primed before a commit', () => {
    describe('When the transaction commits and a same-key mtime collision is forced', () => {
      it('Then the per-Context stack memo is invalidated at commit', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/a'), id: oid(0x01) },
        ]);
        const listPath = tablesListPath(ctx.layout.gitDir);
        const fixedStat = await ctx.fs.stat(listPath);
        const originalStat = ctx.fs.stat.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'stat').mockImplementation(async (path: string) =>
          path === listPath ? fixedStat : originalStat(path),
        );
        const primed = await loadReftableStack(ctx, dir);
        expect(primed.maxUpdateIndex).toBe(1n);

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/b'), id: oid(0x02) },
        ]);
        const reloaded = await loadReftableStack(ctx, dir);

        // Assert — despite the identical (stubbed) mtime key, the reload
        // reflects the post-commit stack: the memo was dropped at commit,
        // not merely luck-of-the-clock.
        expect(reloaded.maxUpdateIndex).toBe(2n);
      });
    });
  });

  describe('Given a stack whose newest tables qualify for a merge', () => {
    describe('When a transaction commits', () => {
      it('Then the qualifying segment is merged into one table', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const oldBytes = await buildFixtureTable(
          ctx,
          [liveRef('refs/heads/old', 1, 1)],
          [],
          1n,
          1n,
        );
        await writeReftableFiles(ctx, dir, [{ name: 'old.ref', bytes: oldBytes }]);

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/newRef'), id: oid(2) },
        ]);

        // Assert
        const stack = await loadReftableStack(ctx, dir);
        expect(stack.tables).toHaveLength(1);
        const names = [...iterateReftableRefs(stack.tables[0]!)].map((r) => r.name).sort();
        expect(names).toEqual(['refs/heads/newRef', 'refs/heads/old']);
      });

      it('Then the merged table carries the oldest min and the newest max update index', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const oldBytes = await buildFixtureTable(
          ctx,
          [liveRef('refs/heads/old', 1, 1)],
          [],
          1n,
          1n,
        );
        await writeReftableFiles(ctx, dir, [{ name: 'old.ref', bytes: oldBytes }]);

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/newRef'), id: oid(2) },
        ]);

        // Assert
        const stack = await loadReftableStack(ctx, dir);
        expect(stack.tables).toHaveLength(1);
        expect(stack.tables[0]!.header.minUpdateIndex).toBe(1n);
        expect(stack.tables[0]!.header.maxUpdateIndex).toBe(2n);
      });
    });
  });

  describe('Given a merge segment that starts at the oldest table in the stack', () => {
    describe('When a transaction commits', () => {
      it('Then a tombstone is elided entirely — no ref record and no log record', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const goneBytes = await buildFixtureTable(
          ctx,
          [liveRef('refs/heads/keep', 1, 1), tombstoneRef('refs/heads/gone', 1)],
          [tombstoneLog('refs/heads/gone', 1)],
          1n,
          1n,
        );
        await writeReftableFiles(ctx, dir, [{ name: 'gone.ref', bytes: goneBytes }]);

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/newRef'), id: oid(2) },
        ]);

        // Assert — the whole (2-table) stack merged into one table starting
        // at index 0, so the tombstone for `gone` is dropped outright.
        const stack = await loadReftableStack(ctx, dir);
        expect(stack.tables).toHaveLength(1);
        const merged = stack.tables[0]!;
        expect(
          [...iterateReftableRefs(merged)].some((r) => r.name === ref('refs/heads/gone')),
        ).toBe(false);
        expect(
          [...iterateReftableLogs(merged)].some((l) => l.name === ref('refs/heads/gone')),
        ).toBe(false);
        expect(
          [...iterateReftableRefs(merged)].some((r) => r.name === ref('refs/heads/keep')),
        ).toBe(true);
      });
    });
  });

  describe('Given a merge segment that starts mid-stack, behind an untouched older table', () => {
    describe('When a transaction commits', () => {
      it('Then the tombstone survives in the merged table and the older table is untouched', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const bigBytes = await buildFixtureTable(ctx, fillerRefs(50, 1), [], 1n, 1n);
        const goneBytes = await buildFixtureTable(
          ctx,
          [tombstoneRef('refs/heads/gone2', 2)],
          [],
          2n,
          2n,
        );
        await writeReftableFiles(ctx, dir, [
          { name: 'big.ref', bytes: bigBytes },
          { name: 'gone2.ref', bytes: goneBytes },
        ]);

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/newRef'), id: oid(3) },
        ]);

        // Assert — the oldest (big) table stays byte-identical and named
        // `big.ref`; the other two merge into a new table that still
        // carries `gone2`'s tombstone, because the segment did not start
        // at table 0.
        const namesAfter = (await ctx.fs.readUtf8(tablesListPath(ctx.layout.gitDir)))
          .trim()
          .split('\n');
        expect(namesAfter).toContain('big.ref');
        expect(await ctx.fs.read(`${dir}/big.ref`)).toEqual(bigBytes);
        const stack = await loadReftableStack(ctx, dir);
        expect(stack.tables).toHaveLength(2);
        const merged = stack.tables.find((t) => t !== stack.tables[0]) ?? stack.tables[1]!;
        const goneRecord = [...iterateReftableRefs(merged)].find(
          (r) => r.name === ref('refs/heads/gone2'),
        );
        expect(goneRecord?.value).toEqual({ kind: 'deletion' });
        expect(stack.lookup(ref('refs/heads/gone2'))).toBeUndefined();
      });
    });
  });

  describe('Given an all-tombstone segment starting at table 0', () => {
    describe('When a transaction commits', () => {
      it('Then an empty merge result is omitted from tables.list', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const onlyBytes = await buildFixtureTable(
          ctx,
          [liveRef('refs/heads/only', 1, 1)],
          [],
          1n,
          1n,
        );
        await writeReftableFiles(ctx, dir, [{ name: 'only.ref', bytes: onlyBytes }]);

        // Act — deleting the sole live ref produces a tombstone-only new
        // table; merging it against the tombstone-only original leaves
        // nothing, since the segment starts at 0.
        await applyReftableUpdates(ctx, [
          { kind: 'delete', name: ref('refs/heads/only'), expected: oid(1) },
        ]);

        // Assert
        const namesAfter = (await ctx.fs.readUtf8(tablesListPath(ctx.layout.gitDir))).trim();
        expect(namesAfter).toBe('');
        const entries = (await ctx.fs.readdir(dir)).map((e) => e.name);
        expect(entries.filter((name) => name.endsWith('.ref'))).toEqual([]);
        const stack = await loadReftableStack(ctx, dir);
        expect(stack.tables).toEqual([]);
      });
    });
  });

  describe('Given a table lock already held on the oldest table of a 3-table segment', () => {
    describe('When a transaction commits', () => {
      it('Then a held table lock shrinks the range, leaving the locked table untouched', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const bigBytes = await buildFixtureTable(ctx, fillerRefs(50, 1), [], 1n, 1n);
        const midABytes = await buildFixtureTable(
          ctx,
          [liveRef('refs/heads/midA', 2, 2)],
          [],
          2n,
          2n,
        );
        const midBBytes = await buildFixtureTable(
          ctx,
          [liveRef('refs/heads/midB', 3, 3)],
          [],
          3n,
          3n,
        );
        await writeReftableFiles(ctx, dir, [
          { name: 'big.ref', bytes: bigBytes },
          { name: 'midA.ref', bytes: midABytes },
          { name: 'midB.ref', bytes: midBBytes },
        ]);
        await ctx.fs.writeExclusive(
          reftableTableLockPath(ctx.layout.gitDir, 'midA.ref'),
          new Uint8Array(0),
        );

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/newRef'), id: oid(4) },
        ]);

        // Assert — big.ref and midA.ref (locked) both survive untouched;
        // midB.ref and the new table merge into a fresh table instead.
        const namesAfter = (await ctx.fs.readUtf8(tablesListPath(ctx.layout.gitDir)))
          .trim()
          .split('\n');
        expect(namesAfter).toContain('big.ref');
        expect(namesAfter).toContain('midA.ref');
        expect(await ctx.fs.read(`${dir}/midA.ref`)).toEqual(midABytes);
        expect(namesAfter).not.toContain('midB.ref');
        const store = createReftableRefStore(ctx);
        expect(await store.resolveDirect(ref('refs/heads/midB'))).toEqual({
          kind: 'direct',
          id: oid(3),
        });
        expect(await store.resolveDirect(ref('refs/heads/newRef'))).toEqual({
          kind: 'direct',
          id: oid(4),
        });
      });
    });
  });

  describe('Given a table lock already held on the sole other table in a 2-table segment', () => {
    describe('When a transaction commits', () => {
      it('Then fewer than two lockable tables gives up silently, leaving the stack unmerged', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const oldBytes = await buildFixtureTable(
          ctx,
          [liveRef('refs/heads/old', 1, 1)],
          [],
          1n,
          1n,
        );
        await writeReftableFiles(ctx, dir, [{ name: 'old.ref', bytes: oldBytes }]);
        await ctx.fs.writeExclusive(
          reftableTableLockPath(ctx.layout.gitDir, 'old.ref'),
          new Uint8Array(0),
        );

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/newRef'), id: oid(2) },
        ]);

        // Assert — both tables remain, unmerged; the write itself still
        // succeeded.
        const stack = await loadReftableStack(ctx, dir);
        expect(stack.tables).toHaveLength(2);
        const store = createReftableRefStore(ctx);
        expect(await store.resolveDirect(ref('refs/heads/newRef'))).toEqual({
          kind: 'direct',
          id: oid(2),
        });
      });
    });
  });

  describe('Given tables.list.lock is contended for every re-acquisition attempt compaction makes', () => {
    describe('When a transaction commits', () => {
      it('Then a lock conflict during compaction leaves the ref update committed', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const oldBytes = await buildFixtureTable(
          ctx,
          [liveRef('refs/heads/old', 1, 1)],
          [],
          1n,
          1n,
        );
        await writeReftableFiles(ctx, dir, [{ name: 'old.ref', bytes: oldBytes }]);
        const listLockPath = tablesListLockPath(ctx.layout.gitDir);
        const original = ctx.fs.writeExclusive.bind(ctx.fs);
        let listLockAttempts = 0;
        vi.spyOn(ctx.fs, 'writeExclusive').mockImplementation(async (path: string, data) => {
          if (path === listLockPath) {
            listLockAttempts += 1;
            if (listLockAttempts > 1) throw new TsgitError({ code: 'FILE_EXISTS', path });
          }
          return original(path, data);
        });

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/newRef'), id: oid(2) },
        ]);

        // Assert — the ref committed; the stack merely grew by one, because
        // compaction's own list-lock re-acquisition kept failing.
        const stack = await loadReftableStack(ctx, dir);
        expect(stack.tables).toHaveLength(2);
        const store = createReftableRefStore(ctx);
        expect(await store.resolveDirect(ref('refs/heads/newRef'))).toEqual({
          kind: 'direct',
          id: oid(2),
        });
      }, 2000);
    });
  });

  describe('Given a table read fails with a non-lock error during the merge step', () => {
    describe('When a transaction commits', () => {
      it('Then a non-lock error during compaction propagates', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const oldBytes = await buildFixtureTable(
          ctx,
          [liveRef('refs/heads/old', 1, 1)],
          [],
          1n,
          1n,
        );
        await writeReftableFiles(ctx, dir, [{ name: 'old.ref', bytes: oldBytes }]);
        const original = ctx.fs.read.bind(ctx.fs);
        let refReads = 0;
        const fault = new Error('synthetic merge fault');
        vi.spyOn(ctx.fs, 'read').mockImplementation(async (path: string) => {
          if (path.endsWith('.ref')) {
            refReads += 1;
            if (refReads > 3) throw fault;
          }
          return original(path);
        });

        // Act + Assert
        await expect(
          applyReftableUpdates(ctx, [{ kind: 'set', name: ref('refs/heads/newRef'), id: oid(2) }]),
        ).rejects.toBe(fault);
      });
    });
  });

  describe('Given a compacting transaction that reaches the unlink step', () => {
    describe('When one of the merged tables fails to unlink', () => {
      it('Then merged tables are unlinked and an unlink failure is ignored', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const oldBytes = await buildFixtureTable(
          ctx,
          [liveRef('refs/heads/old', 1, 1)],
          [],
          1n,
          1n,
        );
        await writeReftableFiles(ctx, dir, [{ name: 'old.ref', bytes: oldBytes }]);
        const original = ctx.fs.rm.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'rm').mockImplementation(async (path: string) => {
          if (path.endsWith('old.ref')) {
            throw new TsgitError({ code: 'FILE_NOT_FOUND', path });
          }
          return original(path);
        });

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/newRef'), id: oid(2) },
        ]);

        // Assert — the merge still completed: one merged table, both
        // originals gone from tables.list despite the injected unlink fault.
        const namesAfter = (await ctx.fs.readUtf8(tablesListPath(ctx.layout.gitDir)))
          .trim()
          .split('\n');
        expect(namesAfter).toHaveLength(1);
        expect(namesAfter).not.toContain('old.ref');
        const stack = await loadReftableStack(ctx, dir);
        expect(stack.tables).toHaveLength(1);
        const names = [...iterateReftableRefs(stack.tables[0]!)].map((r) => r.name).sort();
        expect(names).toEqual(['refs/heads/newRef', 'refs/heads/old']);
      });
    });
  });

  describe('Given tables.list changes between compaction planning its merge and re-verifying it', () => {
    describe('When a transaction commits', () => {
      it('Then the stack is outdated between the two lock acquisitions and the compaction aborts', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const dir = commonReftableDir(ctx);
        const oldBytes = await buildFixtureTable(
          ctx,
          [liveRef('refs/heads/old', 1, 1)],
          [],
          1n,
          1n,
        );
        await writeReftableFiles(ctx, dir, [{ name: 'old.ref', bytes: oldBytes }]);
        const listPath = tablesListPath(ctx.layout.gitDir);
        const original = ctx.fs.writeExclusive.bind(ctx.fs);
        let tempWrites = 0;
        vi.spyOn(ctx.fs, 'writeExclusive').mockImplementation(async (path: string, data) => {
          const result = await original(path, data);
          if (path.endsWith('.temp')) {
            tempWrites += 1;
            // The second `.temp` write is compaction's own merge output
            // (the first is the main transaction's new table) — simulate a
            // concurrent writer reordering tables.list right after it, so
            // step 5's re-verification finds the segment no longer intact.
            if (tempWrites === 2) {
              const names = (await ctx.fs.readUtf8(listPath)).trim().split('\n');
              await ctx.fs.writeUtf8(
                listPath,
                [...names]
                  .reverse()
                  .map((n) => `${n}\n`)
                  .join(''),
              );
            }
          }
          return result;
        });

        // Act
        await applyReftableUpdates(ctx, [
          { kind: 'set', name: ref('refs/heads/newRef'), id: oid(2) },
        ]);

        // Assert — compaction aborted silently: both tables are still
        // individually present (never merged), and no temp file is left
        // behind.
        const namesAfter = (await ctx.fs.readUtf8(listPath)).trim().split('\n');
        expect(namesAfter).toHaveLength(2);
        expect(namesAfter).toContain('old.ref');
        const entries = (await ctx.fs.readdir(dir)).map((e) => e.name);
        expect(entries.some((name) => name.includes('.temp'))).toBe(false);
        const store = createReftableRefStore(ctx);
        expect(await store.resolveDirect(ref('refs/heads/newRef'))).toEqual({
          kind: 'direct',
          id: oid(2),
        });
      });
    });
  });
});
