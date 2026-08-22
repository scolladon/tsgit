import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { loadReftableStack } from '../../../../src/application/primitives/load-reftable-stack.js';
import {
  tablesListLockPath,
  tablesListPath,
} from '../../../../src/application/primitives/path-layout.js';
import { createReftableRefStore } from '../../../../src/application/primitives/reftable-ref-store.js';
import { applyReftableUpdates } from '../../../../src/application/primitives/reftable-transaction.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { iterateReftableLogs, iterateReftableRefs } from '../../../../src/domain/refs/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { FileSystem } from '../../../../src/ports/file-system.js';
import { commonReftableDir, withReftableStorage } from './reftable-fixtures.js';

const oid = (fill: number): ObjectId => ObjectId.fromRaw(new Uint8Array(20).fill(fill));
const ref = (name: string): RefName => RefName.from(name);

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
});
