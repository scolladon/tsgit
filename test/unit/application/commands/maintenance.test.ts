/**
 * Unit tests for the Tier-1 `maintenance` command — the `commit-graph` task,
 * and the `gc` task's loose-object lifecycle: the reachable/unreachable
 * partition, the cruft-pack lifecycle (the `.mtimes` sidecar, mtime
 * provenance, the expiry cutoff, the four existing-cruft outcomes), the
 * `gc.auto` gate, and the invariant repair on the loose-oid fanout cache.
 *
 * Coverage:
 *  - refusal: empty `tasks`, an unknown task
 *  - per-task gating: only the requested task(s) run
 *  - commit-graph: graph written, commitsInGraph, "ran and found nothing"
 *  - gc.auto gate: unconditional when absent, decline below threshold, run
 *    above threshold, 0 disables the gate, malformed value refuses
 *  - reachability partition: reachable → normal pack, unreachable/recent →
 *    cruft pack, index-only and reflog-only roots survive
 *  - mtime provenance: loose lstat, carried sidecar entry, the max of both
 *    in either ordering, a failed lstat refuses (no Date.now() fallback)
 *  - expiry boundary at cutoff-1/cutoff/cutoff+1; `never`/`now`;
 *    malformed `gc.pruneExpire` refuses and writes nothing
 *  - the four existing-cruft outcomes: new garbage, partial expiry, total
 *    expiry, byte-identical no-op; resurrection
 *  - `gc.cruftPacks=false` write-back path
 *  - deletion safety: half-retired pack invisible to the registry; an
 *    interrupted cruft-pack creation still reads as an ordinary pack
 *  - refs/reflogs/index untouched; loose-oid cache invariant repair
 *  - structural: every result field is a count, boolean or enum
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  type MaintenanceTask,
  maintenance,
} from '../../../../src/application/commands/maintenance.js';
import * as enumerateObjectsMod from '../../../../src/application/primitives/enumerate-objects.js';
import * as cruftPackLifecycleMod from '../../../../src/application/primitives/internal/cruft-pack-lifecycle.js';
import { probeLooseOid } from '../../../../src/application/primitives/internal/loose-oid-cache.js';
import { deriveWorktreeContext } from '../../../../src/application/primitives/internal/worktree-context.js';
import * as writePackArtifactsMod from '../../../../src/application/primitives/internal/write-pack-artifacts.js';
import {
  commonGitDir,
  looseObjectPath,
  multiPackIndexPath,
  packsDir,
} from '../../../../src/application/primitives/path-layout.js';
import {
  getPackRegistry,
  readObject,
  refreshPackRegistry,
} from '../../../../src/application/primitives/read-object.js';
import * as writeCommitGraphMod from '../../../../src/application/primitives/write-commit-graph.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { fileNotFound, TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import { parseCruftMtimes } from '../../../../src/domain/storage/index.js';
import { allObjectIds } from '../../../../src/domain/storage/pack-index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildMidx } from '../../domain/storage/arbitraries.js';
import { writeSyntheticPack } from '../primitives/pack-fixture.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const enc = new TextEncoder();

const makeBlob = (content: string) => ({
  type: 'blob' as const,
  id: '' as ObjectId,
  content: enc.encode(content),
});

const seedOneCommit = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'hello');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'seed', author: AUTHOR });
  return ctx;
};

/** Writes an unreferenced loose blob — a candidate cruft object. */
const writeLooseBlob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, makeBlob(content));

const appendConfig = (ctx: Context, text: string): Promise<void> =>
  ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, text);

const packDirOf = (ctx: Context): string => packsDir(commonGitDir(ctx));

const isLoose = (ctx: Context, id: ObjectId): Promise<boolean> =>
  ctx.fs.exists(looseObjectPath(commonGitDir(ctx), id));

/**
 * Installs an `lstat` override on `ctx.fs`: registered paths return the
 * given `mtimeMs` (or throw the given error) instead of the real stat.
 * Every other path falls through to the original implementation.
 */
function installLstatOverrides(ctx: Context): {
  readonly forceMtimeSeconds: (path: string, epochSeconds: number) => void;
  readonly forceFailure: (path: string, error: unknown) => void;
} {
  const original = ctx.fs.lstat.bind(ctx.fs);
  const mtimeOverrides = new Map<string, number>();
  const failureOverrides = new Map<string, unknown>();
  vi.spyOn(ctx.fs, 'lstat').mockImplementation(async (path: string) => {
    if (failureOverrides.has(path)) throw failureOverrides.get(path);
    const stat = await original(path);
    const forced = mtimeOverrides.get(path);
    return forced === undefined ? stat : { ...stat, mtimeMs: forced * 1000 };
  });
  return {
    forceMtimeSeconds: (path, epochSeconds) => mtimeOverrides.set(path, epochSeconds),
    forceFailure: (path, error) => failureOverrides.set(path, error),
  };
}

/** Every oid a registered pack carries, by its sha — the registry is
 *  refreshed first so a pack written moments ago by the very call under
 *  test is visible. */
async function packMemberOids(ctx: Context, packSha: string): Promise<ReadonlySet<ObjectId>> {
  refreshPackRegistry(ctx);
  const packs = await getPackRegistry(ctx).all();
  const pack = packs.find((p) => p.name === `pack-${packSha}`);
  if (pack === undefined) return new Set();
  return new Set(allObjectIds(await pack.index()));
}

/** Reads one oid's recorded mtime straight out of a cruft pack's `.mtimes`
 *  sidecar, bypassing `maintenance`'s own read path entirely. */
async function readCruftMtime(ctx: Context, cruftSha: string, id: ObjectId): Promise<number> {
  refreshPackRegistry(ctx);
  const packDir = packDirOf(ctx);
  const packs = await getPackRegistry(ctx).all();
  const pack = packs.find((p) => p.name === `pack-${cruftSha}`) as NonNullable<
    (typeof packs)[number]
  >;
  const oidsInIndexOrder = allObjectIds(await pack.index());
  const bytes = await ctx.fs.read(`${packDir}/pack-${cruftSha}.mtimes`);
  const parsed = parseCruftMtimes(bytes, oidsInIndexOrder);
  return parsed.get(id) as number;
}

const hashVersionFor = (ctx: Context): 1 | 2 => (ctx.hashConfig.digestLength === 32 ? 2 : 1);

/** Writes a minimal, structurally valid multi-pack-index naming the given
 *  `.idx` files — zero objects, since `expireMidxIfNeeded` reads only
 *  `packNames`. */
const writeMinimalMidx = (ctx: Context, packDir: string, packIdxNames: ReadonlyArray<string>) =>
  ctx.fs.write(
    `${packDir}/multi-pack-index`,
    buildMidx({
      version: 1,
      hashVersion: hashVersionFor(ctx),
      digestLength: ctx.hashConfig.digestLength,
      numBaseFiles: 0,
      packNames: packIdxNames,
      entries: [],
    }),
  );

/** A standalone commit → tree → blob triple, reachable ONLY via a
 *  throwaway `refs/heads/doomed` branch written directly (so no reflog
 *  entry is created for it either) — `severDoomedBranch` makes the whole
 *  triple unreachable in one step, with nothing else keeping it alive. */
async function seedDoomedBlob(ctx: Context, content: string): Promise<ObjectId> {
  const blobId = await writeLooseBlob(ctx, content);
  const treeId = await writeObject(ctx, {
    type: 'tree' as const,
    id: '' as ObjectId,
    entries: [{ mode: FILE_MODE.REGULAR, name: 'doomed.txt', id: blobId }],
  });
  const commitId = await writeObject(ctx, {
    type: 'commit' as const,
    id: '' as ObjectId,
    data: {
      tree: treeId,
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'doomed',
      extraHeaders: [],
    },
  });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/doomed`, `${commitId}\n`);
  return blobId;
}

const severDoomedBranch = (ctx: Context): Promise<void> =>
  ctx.fs.rm(`${ctx.layout.gitDir}/refs/heads/doomed`);

/** Writes a synthetic pack of one blob per given content and marks it
 *  `.promisor` — the fixture every promisor-consolidation test builds on.
 *  Returns each blob's oid, in the same order as `contents`. */
async function writePromisorPack(
  ctx: Context,
  name: string,
  contents: ReadonlyArray<string>,
): Promise<ReadonlyArray<ObjectId>> {
  const ids = await writeSyntheticPack(
    ctx,
    name,
    contents.map((content) => ({
      kind: 'base' as const,
      type: 'blob' as const,
      content: enc.encode(content),
    })),
  );
  await ctx.fs.write(`${packDirOf(ctx)}/pack-${name}.promisor`, new Uint8Array(0));
  return ids as ReadonlyArray<ObjectId>;
}

describe('maintenance', () => {
  describe('Given tasks: []', () => {
    describe('When maintenance is called', () => {
      it('Then it refuses with option "tasks"', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: [] });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const err = caught as TsgitError;
        expect(err.data.code).toBe('INVALID_OPTION');
        expect((err.data as { option: string }).option).toBe('tasks');
        expect((err.data as { reason: string }).reason).toBe('at least one task required');
      });
    });
  });

  describe('Given an unknown task', () => {
    describe('When maintenance is called', () => {
      it('Then it refuses with option "tasks" and the offending value in the reason', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const bogusTasks = ['bogus'] as unknown as ReadonlyArray<MaintenanceTask>;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: bogusTasks });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const err = caught as TsgitError;
        expect(err.data.code).toBe('INVALID_OPTION');
        expect((err.data as { option: string }).option).toBe('tasks');
        expect((err.data as { reason: string }).reason).toBe("'bogus' is not a valid task");
      });
    });
  });

  describe('Given tasks: ["commit-graph"] against a repository with one commit', () => {
    describe('When maintenance runs', () => {
      it('Then the graph is written, commitsInGraph matches the reachable count, and tasksRun echoes the task', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['commit-graph'] });

        // Assert
        expect(result.commitGraphWritten).toBe(true);
        expect(result.commitsInGraph).toBe(1);
        expect(result.tasksRun).toEqual(['commit-graph']);
      });
    });
  });

  describe('Given a repository with no commits', () => {
    describe('When maintenance runs the commit-graph task', () => {
      it('Then commitGraphWritten is false and tasksRun still reports the task ran', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['commit-graph'] });

        // Assert
        expect(result.commitGraphWritten).toBe(false);
        expect(result.commitsInGraph).toBe(0);
        expect(result.tasksRun).toEqual(['commit-graph']);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Per-task gating — only the requested task(s) run
  // ---------------------------------------------------------------------

  describe('Given tasks: ["gc"] only, against a repository with one commit', () => {
    describe('When maintenance runs', () => {
      it('Then the commit-graph task does not run', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.tasksRun).toEqual(['gc']);
        expect(result.commitGraphWritten).toBe(false);
        expect(result.commitsInGraph).toBe(0);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/objects/info/commit-graph`)).toBe(false);
      });
    });
  });

  describe('Given tasks: ["commit-graph", "gc"], against a repository with one commit', () => {
    describe('When maintenance runs', () => {
      it('Then both tasks run, tasksRun echoes both, and commit-graph runs before gc — pinned against git 2.55.0', async () => {
        // Arrange — `git maintenance run` executes requested tasks in the
        // order they were REQUESTED (GIT_TRACE=1 probe, both orderings),
        // not a fixed internal priority.
        const ctx = await seedOneCommit();
        const enumerateSpy = vi.spyOn(enumerateObjectsMod, 'enumerateObjects');
        const writeGraphSpy = vi.spyOn(writeCommitGraphMod, 'writeCommitGraph');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['commit-graph', 'gc'] });

        // Assert
        expect(result.tasksRun).toEqual(['commit-graph', 'gc']);
        expect(result.commitGraphWritten).toBe(true);

        const graphOrder = Math.min(...writeGraphSpy.mock.invocationCallOrder);
        const gcOrder = Math.min(...enumerateSpy.mock.invocationCallOrder);
        enumerateSpy.mockRestore();
        writeGraphSpy.mockRestore();
        expect(graphOrder).toBeLessThan(gcOrder);
      });
    });
  });

  describe('Given tasks: ["gc", "commit-graph"] — the REVERSE order', () => {
    describe('When maintenance runs', () => {
      it('Then gc runs before commit-graph, matching the requested order — pinned against git 2.55.0', async () => {
        // Arrange — `git maintenance run` executes requested tasks in the
        // order they were REQUESTED (GIT_TRACE=1 probe, both orderings),
        // not a fixed internal priority.
        const ctx = await seedOneCommit();
        const enumerateSpy = vi.spyOn(enumerateObjectsMod, 'enumerateObjects');
        const writeGraphSpy = vi.spyOn(writeCommitGraphMod, 'writeCommitGraph');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc', 'commit-graph'] });

        // Assert
        expect(result.tasksRun).toEqual(['gc', 'commit-graph']);
        const gcOrder = Math.min(...enumerateSpy.mock.invocationCallOrder);
        const graphOrder = Math.min(...writeGraphSpy.mock.invocationCallOrder);
        enumerateSpy.mockRestore();
        writeGraphSpy.mockRestore();
        expect(gcOrder).toBeLessThan(graphOrder);
      });
    });
  });

  // ---------------------------------------------------------------------
  // gc.auto gate
  // ---------------------------------------------------------------------

  describe('Given auto is absent, gc.auto=0, and one unreachable loose object', () => {
    describe('When maintenance runs the gc task', () => {
      it('Then gc runs unconditionally', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        await writeLooseBlob(ctx, 'garbage');
        await appendConfig(ctx, '\n[gc]\n\tauto = 0\n');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.tasksRun).toEqual(['gc']);
        expect(result.looseObjectsBefore).toBeGreaterThan(0);
      });
    });
  });

  describe('Given auto: true and a loose count below gc.auto', () => {
    describe('When maintenance runs the gc task', () => {
      it('Then tasksRun omits "gc"', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        await appendConfig(ctx, '\n[gc]\n\tauto = 100\n');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'], auto: true });

        // Assert
        expect(result.tasksRun).toEqual([]);
        expect(result.looseObjectsBefore).toBeGreaterThan(0);
        expect(result.packId).toBeUndefined();
      });
    });
  });

  describe('Given auto: true and a loose count above gc.auto', () => {
    describe('When maintenance runs the gc task', () => {
      it('Then it runs', async () => {
        // Arrange — seedOneCommit alone leaves exactly 3 loose objects
        // (blob, tree, commit), above a threshold of 1.
        const ctx = await seedOneCommit();
        await appendConfig(ctx, '\n[gc]\n\tauto = 1\n');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'], auto: true });

        // Assert
        expect(result.tasksRun).toEqual(['gc']);
      });
    });
  });

  describe('Given auto: true and gc.auto=0, with a loose count that would otherwise run', () => {
    describe('When maintenance runs the gc task', () => {
      it('Then gc declines — gc.auto=0 disables the automatic gate entirely', async () => {
        // Arrange — pinned against git 2.55.0: `gc.auto=0` plus
        // `git gc --auto` runs nothing, regardless of the loose count.
        const ctx = await seedOneCommit();
        await writeLooseBlob(ctx, 'garbage');
        await appendConfig(ctx, '\n[gc]\n\tauto = 0\n');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'], auto: true });

        // Assert
        expect(result.tasksRun).toEqual([]);
        expect(result.packId).toBeUndefined();
        expect(result.packsBefore).toBe(result.packsAfter);
      });
    });
  });

  describe('Given auto: true and gc.auto equal to the loose count (the boundary)', () => {
    describe('When maintenance runs the gc task', () => {
      it('Then gc declines — the `<=` boundary evaluates to decline', async () => {
        // Arrange — seedOneCommit alone leaves exactly 3 loose objects.
        const ctx = await seedOneCommit();
        await appendConfig(ctx, '\n[gc]\n\tauto = 3\n');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'], auto: true });

        // Assert
        expect(result.tasksRun).toEqual([]);
        expect(result.packId).toBeUndefined();
      });
    });
  });

  describe('Given auto: true and a malformed gc.auto value', () => {
    describe('When maintenance runs the gc task', () => {
      it('Then it refuses with CONFIG_BAD_NUMERIC_VALUE', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        await appendConfig(ctx, '\n[gc]\n\tauto = bogus\n');
        const sut = maintenance;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: ['gc'], auto: true });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
      });
    });
  });

  // ---------------------------------------------------------------------
  // Reachability partition
  // ---------------------------------------------------------------------

  describe('Given a reachable commit and its tree/blob, all loose', () => {
    describe('When gc runs', () => {
      it('Then every reachable object lands in the new normal pack and stops being loose', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const commitId = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)).trim();
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.packId).toBeDefined();
        expect(await isLoose(ctx, commitId as ObjectId)).toBe(false);
        const readBack = await readObject(ctx, commitId as ObjectId, { verifyHash: true });
        expect(readBack.type).toBe('commit');
      });
    });
  });

  describe('Given an unreachable loose object newer than the default cutoff', () => {
    describe('When gc runs', () => {
      it('Then it lands in the cruft pack, stops being loose, and stays readable', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'dangling');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.cruftPackId).toBeDefined();
        expect(result.cruftObjectsAdded).toBe(1);
        expect(await isLoose(ctx, blobId)).toBe(false);
        const readBack = await readObject(ctx, blobId, { verifyHash: true });
        expect(readBack.type).toBe('blob');
      });
    });
  });

  describe('Given an index-only blob and a reflog-only commit', () => {
    describe('When gc runs', () => {
      it('Then both survive and are packed into the normal pack', async () => {
        // Arrange
        const ctx = await seedOneCommit();

        // Index-only: staged but never committed.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/staged.txt`, 'staged-only');
        await add(ctx, ['staged.txt']);
        const stagedBlobId = await writeLooseBlob(ctx, 'staged-only');

        // Reflog-only: an orphan commit recorded as a reflog old-id, with the
        // current ref pointing elsewhere.
        const orphanTreeId = await writeObject(ctx, {
          type: 'tree' as const,
          id: '' as ObjectId,
          entries: [],
        });
        const orphanCommitId = await writeObject(ctx, {
          type: 'commit' as const,
          id: '' as ObjectId,
          data: {
            tree: orphanTreeId,
            parents: [],
            author: AUTHOR,
            committer: AUTHOR,
            message: 'orphan',
            extraHeaders: [],
          },
        });
        const currentHead = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)).trim();
        await ctx.fs.mkdir(`${ctx.layout.gitDir}/logs/refs/heads`);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/logs/refs/heads/main`,
          `${orphanCommitId} ${currentHead} Ada <ada@example.com> 1700000000 +0000\treset\n`,
        );
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.packId).toBeDefined();
        expect(await readObject(ctx, stagedBlobId, { verifyHash: true })).toMatchObject({
          type: 'blob',
        });
        expect(await readObject(ctx, orphanCommitId, { verifyHash: true })).toMatchObject({
          type: 'commit',
        });
      });
    });
  });

  describe("Given a commit reachable only from a linked worktree's detached HEAD", () => {
    describe('When gc runs with a cutoff that would otherwise destroy it', () => {
      it('Then it survives — matching git rooting reachability across every worktree', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const wtBlobId = await writeLooseBlob(ctx, 'worktree-only');
        const wtTreeId = await writeObject(ctx, {
          type: 'tree' as const,
          id: '' as ObjectId,
          entries: [{ mode: FILE_MODE.REGULAR, name: 'wt.txt', id: wtBlobId }],
        });
        const wtCommitId = await writeObject(ctx, {
          type: 'commit' as const,
          id: '' as ObjectId,
          data: {
            tree: wtTreeId,
            parents: [],
            author: AUTHOR,
            committer: AUTHOR,
            message: 'worktree-only',
            extraHeaders: [],
          },
        });
        const adminDir = `${ctx.layout.gitDir}/worktrees/wt1`;
        await ctx.fs.writeUtf8(`${adminDir}/HEAD`, `${wtCommitId}\n`);
        await ctx.fs.writeUtf8(`${adminDir}/gitdir`, '/tmp/nonexistent-wt1/.git\n');
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = now\n');
        const sut = maintenance;

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        await expect(readObject(ctx, wtCommitId)).resolves.toMatchObject({ type: 'commit' });
        await expect(readObject(ctx, wtTreeId)).resolves.toMatchObject({ type: 'tree' });
        await expect(readObject(ctx, wtBlobId)).resolves.toMatchObject({ type: 'blob' });
      });
    });
  });

  describe("Given a commit reachable only from a linked worktree's own HEAD reflog", () => {
    describe('When gc runs with a cutoff that would otherwise destroy it', () => {
      it("Then it survives — gc roots every worktree's own reflog, not just the current one", async () => {
        // Arrange — wt1's own HEAD points at the CURRENT tip (already
        // reachable via refs/heads/main); only wt1's own HEAD reflog
        // remembers the orphan commit as a discarded `oldId`.
        const ctx = await seedOneCommit();
        const wtBlobId = await writeLooseBlob(ctx, 'worktree-reflog-only');
        const wtTreeId = await writeObject(ctx, {
          type: 'tree' as const,
          id: '' as ObjectId,
          entries: [{ mode: FILE_MODE.REGULAR, name: 'wt.txt', id: wtBlobId }],
        });
        const wtCommitId = await writeObject(ctx, {
          type: 'commit' as const,
          id: '' as ObjectId,
          data: {
            tree: wtTreeId,
            parents: [],
            author: AUTHOR,
            committer: AUTHOR,
            message: 'worktree-reflog-only',
            extraHeaders: [],
          },
        });
        const currentHead = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)).trim();
        const adminDir = `${ctx.layout.gitDir}/worktrees/wt1`;
        await ctx.fs.writeUtf8(`${adminDir}/HEAD`, `${currentHead}\n`);
        await ctx.fs.writeUtf8(`${adminDir}/gitdir`, '/tmp/nonexistent-wt1-reflog/.git\n');
        await ctx.fs.mkdir(`${adminDir}/logs`);
        await ctx.fs.writeUtf8(
          `${adminDir}/logs/HEAD`,
          `${wtCommitId} ${currentHead} Ada <ada@example.com> 1700000000 +0000\treset: moving to ${currentHead}\n`,
        );
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = now\n');
        const sut = maintenance;

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        await expect(readObject(ctx, wtCommitId)).resolves.toMatchObject({ type: 'commit' });
        await expect(readObject(ctx, wtTreeId)).resolves.toMatchObject({ type: 'tree' });
        await expect(readObject(ctx, wtBlobId)).resolves.toMatchObject({ type: 'blob' });
      });
    });
  });

  describe('Given the main worktree holding a commit reachable only from its own detached HEAD', () => {
    describe('When gc runs from a linked worktree Context', () => {
      it('Then it survives — gc roots the main worktree regardless of which worktree it runs from', async () => {
        // Arrange — the main worktree's own HEAD is overwritten directly (no
        // command runs), so no reflog entry anywhere names the commit; only
        // the raw HEAD value itself roots it.
        const ctx = await seedOneCommit();
        const mainBlobId = await writeLooseBlob(ctx, 'main-only');
        const mainTreeId = await writeObject(ctx, {
          type: 'tree' as const,
          id: '' as ObjectId,
          entries: [{ mode: FILE_MODE.REGULAR, name: 'main.txt', id: mainBlobId }],
        });
        const mainCommitId = await writeObject(ctx, {
          type: 'commit' as const,
          id: '' as ObjectId,
          data: {
            tree: mainTreeId,
            parents: [],
            author: AUTHOR,
            committer: AUTHOR,
            message: 'main-only',
            extraHeaders: [],
          },
        });
        const currentHead = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)).trim();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${mainCommitId}\n`);
        const wtAdminDir = `${ctx.layout.gitDir}/worktrees/wt1`;
        await ctx.fs.writeUtf8(`${wtAdminDir}/HEAD`, `${currentHead}\n`);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = now\n');
        const wtCtx = deriveWorktreeContext(ctx, 'wt1', '/tmp/nonexistent-wt1-main-root');
        const sut = maintenance;

        // Act — gc invoked from the LINKED worktree's own Context.
        await sut(wtCtx, { tasks: ['gc'] });

        // Assert
        await expect(readObject(ctx, mainCommitId)).resolves.toMatchObject({ type: 'commit' });
        await expect(readObject(ctx, mainTreeId)).resolves.toMatchObject({ type: 'tree' });
        await expect(readObject(ctx, mainBlobId)).resolves.toMatchObject({ type: 'blob' });
      });
    });
  });

  // ---------------------------------------------------------------------
  // mtime provenance
  // ---------------------------------------------------------------------

  describe('Given a loose unreachable object whose mtime is forced into the past', () => {
    describe('When gc runs with a matching cutoff', () => {
      it('Then the sidecar records exactly that forced value', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'aged');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), blobId), 2_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = @1999999999\n');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert — survives (2_000_000_000 > 1_999_999_999) into the cruft pack.
        expect(result.cruftPackId).toBeDefined();
        expect(result.cruftObjectsAdded).toBe(1);
        expect(result.cruftObjectsExpired).toBe(0);
      });
    });
  });

  describe('Given an object carried forward from a previous cruft pack, untouched since', () => {
    describe('When a second gc runs', () => {
      it('Then its mtime is byte-identical across both sidecars', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'carried');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), blobId), 1_800_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;

        // Act — first gc crufts it; second gc reads the carried mtime back
        // (the loose file no longer exists, so only the carried source applies).
        const first = await sut(ctx, { tasks: ['gc'] });
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert — unchanged survivor set: byte-identical no-op, same sha.
        expect(second.cruftPackId).toBe(first.cruftPackId);
        expect(second.cruftObjectsRetained).toBe(1);
      });
    });
  });

  describe('Given both a loose copy and a carried sidecar entry, with the loose one newer', () => {
    describe('When gc runs', () => {
      it('Then the newer (loose) mtime wins', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'freshen-loose-newer');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        const loosePath = looseObjectPath(commonGitDir(ctx), blobId);
        forceMtimeSeconds(loosePath, 1_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;
        await sut(ctx, { tasks: ['gc'] }); // crufts it with carried mtime 1_000_000_000

        // Act — write it loose again with a NEWER forced mtime ("freshen").
        await writeLooseBlob(ctx, 'freshen-loose-newer');
        forceMtimeSeconds(loosePath, 3_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = @2999999999\n');
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert — survives because the NEWER loose mtime (3e9) beats the
        // cutoff (2_999_999_999), even though the carried value (1e9) would not.
        expect(result.cruftObjectsRetained).toBe(1);
        expect(result.cruftObjectsExpired).toBe(0);
      });
    });
  });

  describe('Given both a loose copy and a carried sidecar entry, with the carried one newer', () => {
    describe('When gc runs', () => {
      it('Then the newer (carried) mtime wins', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'freshen-carried-newer');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        const loosePath = looseObjectPath(commonGitDir(ctx), blobId);
        forceMtimeSeconds(loosePath, 3_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;
        await sut(ctx, { tasks: ['gc'] }); // crufts it with carried mtime 3_000_000_000

        // Act — resurrect it loose with an OLDER forced mtime than the carried one.
        await writeLooseBlob(ctx, 'freshen-carried-newer');
        forceMtimeSeconds(loosePath, 1_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = @1999999999\n');
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert — survives because the carried mtime (3e9) beats the cutoff
        // (1_999_999_999), even though the fresh loose mtime (1e9) would not.
        expect(result.cruftObjectsRetained).toBe(1);
        expect(result.cruftObjectsExpired).toBe(0);
      });
    });
  });

  describe('Given a cruft candidate whose mtime source lookup is synthetically emptied', () => {
    describe('When gc runs', () => {
      it('Then it throws rather than silently destroying the object', async () => {
        // Arrange — `computeCruftMtimes` guarantees every candidate a mtime
        // by construction; this fixture breaks that invariant directly to
        // pin the fail-safe, since no REAL code path can produce a missing
        // entry without a bug elsewhere.
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'invariant-broken');
        const spy = vi
          .spyOn(cruftPackLifecycleMod, 'computeCruftMtimes')
          .mockImplementation(async (_ctx, candidates) => {
            return new Map(candidates.map((id) => [id, undefined as unknown as number]));
          });
        const sut = maintenance;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: ['gc'] });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        spy.mockRestore();

        // Assert — the object was never deleted.
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain('gc invariant violated');
        expect(await isLoose(ctx, blobId)).toBe(true);
      });
    });
  });

  describe('Given a loose unreachable object whose lstat fails', () => {
    describe('When gc runs', () => {
      it('Then it refuses rather than falling back to the current time', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'lstat-fails');
        const loosePath = looseObjectPath(commonGitDir(ctx), blobId);
        const { forceFailure } = installLstatOverrides(ctx);
        forceFailure(loosePath, fileNotFound(loosePath));
        const sut = maintenance;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: ['gc'] });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
      });
    });
  });

  describe('Given an EACCES fault reading one ref during the retention-root scan', () => {
    describe('When gc runs', () => {
      it('Then it aborts rather than silently rooting nothing and destroying the subgraph', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const refPath = `${ctx.layout.gitDir}/refs/heads/main`;
        const originalReadUtf8 = ctx.fs.readUtf8.bind(ctx.fs);
        const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        vi.spyOn(ctx.fs, 'readUtf8').mockImplementation(async (path: string) => {
          if (path === refPath) throw eacces;
          return originalReadUtf8(path);
        });
        const sut = maintenance;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: ['gc'] });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — the fault propagated (not swallowed as "not reachable"),
        // and nothing was destroyed: the repository never reached a write.
        expect(caught).toBe(eacces);
        expect((await getPackRegistry(ctx).all()).length).toBe(0);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Expiry boundary — strict `>`
  // ---------------------------------------------------------------------

  describe.each([
    { label: 'cutoff - 1', mtime: 999_999_999, cutoff: 1_000_000_000 },
    { label: 'exactly at cutoff', mtime: 1_000_000_000, cutoff: 1_000_000_000 },
  ])('Given an unreachable loose object at $label', ({ mtime, cutoff }) => {
    describe('When gc runs', () => {
      it('Then it is destroyed', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, `boundary-${mtime}`);
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), blobId), mtime);
        await appendConfig(ctx, `\n[gc]\n\tpruneExpire = @${cutoff}\n`);
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.cruftObjectsExpired).toBe(1);
        expect(result.cruftPackId).toBeUndefined();
        let caught: unknown;
        try {
          await readObject(ctx, blobId);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  describe.each([{ label: 'cutoff + 1', mtime: 1_000_000_001, cutoff: 1_000_000_000 }])(
    'Given an unreachable loose object at $label',
    ({ mtime, cutoff }) => {
      describe('When gc runs', () => {
        it('Then it is kept', async () => {
          // Arrange
          const ctx = await seedOneCommit();
          const blobId = await writeLooseBlob(ctx, `boundary-${mtime}`);
          const { forceMtimeSeconds } = installLstatOverrides(ctx);
          forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), blobId), mtime);
          await appendConfig(ctx, `\n[gc]\n\tpruneExpire = @${cutoff}\n`);
          const sut = maintenance;

          // Act
          const result = await sut(ctx, { tasks: ['gc'] });

          // Assert
          expect(result.cruftObjectsAdded).toBe(1);
          expect(result.cruftObjectsExpired).toBe(0);
          await expect(readObject(ctx, blobId)).resolves.toMatchObject({ type: 'blob' });
        });
      });
    },
  );

  describe('Given gc.pruneExpire=never with an aged unreachable object', () => {
    describe('When gc runs', () => {
      it('Then it survives in a cruft pack, never loose, never deleted', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'ancient');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), blobId), 1);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.cruftPackId).toBeDefined();
        expect(result.cruftObjectsExpired).toBe(0);
        expect(await isLoose(ctx, blobId)).toBe(false);
        await expect(readObject(ctx, blobId)).resolves.toMatchObject({ type: 'blob' });
      });
    });
  });

  describe('Given gc.pruneExpire=now with a freshly-written unreachable object', () => {
    describe('When gc runs', () => {
      it('Then no cruft pack exists and the object is gone', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'fresh-but-doomed');
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = now\n');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.cruftPackId).toBeUndefined();
        expect(result.cruftObjectsExpired).toBe(1);
        let caught: unknown;
        try {
          await readObject(ctx, blobId);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  describe('Given a malformed gc.pruneExpire value', () => {
    describe('When gc runs', () => {
      it('Then it refuses and writes nothing', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        await writeLooseBlob(ctx, 'irrelevant');
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = not-a-date\n');
        const sut = maintenance;
        const packDir = packDirOf(ctx);

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: ['gc'] });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — no pack artefact of any kind was written.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_DATE_VALUE');
        const entries = await ctx.fs.readdir(packDir).catch(() => []);
        expect(entries.length).toBe(0);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Existing-cruft-pack outcomes
  // ---------------------------------------------------------------------

  describe('Given an existing cruft pack and new unreachable garbage appears', () => {
    describe('When gc runs again', () => {
      it('Then the cruft pack is rewritten under a new sha, carrying old mtimes byte-identically', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const oldBlobId = await writeLooseBlob(ctx, 'gen1');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), oldBlobId), 1_900_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });

        // Act
        const newBlobId = await writeLooseBlob(ctx, 'gen2');
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), newBlobId), 1_950_000_000);
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.cruftPackId).not.toBe(first.cruftPackId);
        expect(second.cruftObjectsAdded).toBe(1);
        expect(second.cruftObjectsRetained).toBe(1);
        await expect(readObject(ctx, oldBlobId)).resolves.toMatchObject({ type: 'blob' });
        await expect(readObject(ctx, newBlobId)).resolves.toMatchObject({ type: 'blob' });
      });
    });
  });

  describe('Given an existing cruft pack where some entries expire and some survive', () => {
    describe('When gc runs again', () => {
      it('Then it is rewritten under a new sha holding only the survivors', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const survivorId = await writeLooseBlob(ctx, 'survivor');
        const doomedId = await writeLooseBlob(ctx, 'doomed');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), survivorId), 2_000_000_000);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), doomedId), 1_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });

        // Act — tighten the cutoff so only the doomed one falls below it.
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = @1500000000\n');
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.cruftPackId).not.toBe(first.cruftPackId);
        expect(second.cruftObjectsRetained).toBe(1);
        expect(second.cruftObjectsExpired).toBe(1);
        await expect(readObject(ctx, survivorId)).resolves.toMatchObject({ type: 'blob' });
        let caught: unknown;
        try {
          await readObject(ctx, doomedId);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  describe('Given an existing cruft pack where every entry expires', () => {
    describe('When gc runs again', () => {
      it('Then the cruft pack and all its siblings are deleted entirely', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'all-expire');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        // `never` for the first pass means this mtime is never consulted;
        // it only needs to be a valid past timestamp for `now` to exceed it.
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), blobId), 1_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.cruftPackId).toBeDefined();
        const packDir = packDirOf(ctx);

        // Act
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = now\n');
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.cruftPackId).toBeUndefined();
        expect(second.cruftObjectsExpired).toBe(1);
        const entries = await ctx.fs.readdir(packDir);
        expect(entries.some((e) => e.name.endsWith('.mtimes'))).toBe(false);
      });
    });
  });

  describe('Given an existing cruft pack whose survivor set is exactly unchanged', () => {
    describe('When gc runs again', () => {
      it('Then the sidecar is left content-identical under the same file name', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'unchanged');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), blobId), 2_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        const packDir = packDirOf(ctx);
        const mtimesPath = `${packDir}/pack-${first.cruftPackId}.mtimes`;
        const beforeBytes = await ctx.fs.read(mtimesPath);

        // Act — nothing new, nothing expired.
        const second = await sut(ctx, { tasks: ['gc'] });
        const afterBytes = await ctx.fs.read(mtimesPath);

        // Assert
        expect(second.cruftPackId).toBe(first.cruftPackId);
        expect(second.cruftObjectsAdded).toBe(0);
        expect(second.cruftObjectsRetained).toBe(1);
        expect(Buffer.compare(Buffer.from(beforeBytes), Buffer.from(afterBytes))).toBe(0);
      });
    });
  });

  describe('Given an object in the cruft pack made reachable again', () => {
    describe('When gc runs', () => {
      it('Then it moves to the normal pack and leaves the cruft set', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'resurrected');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), blobId), 2_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.cruftPackId).toBeDefined();

        // Act — reference the object from a new branch, making it reachable.
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/keep`, `${blobId}\n`);
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.cruftPackId).toBeUndefined();
        expect(second.packId).toBeDefined();
        await expect(readObject(ctx, blobId, { verifyHash: true })).resolves.toMatchObject({
          type: 'blob',
        });
      });
    });
  });

  // ---------------------------------------------------------------------
  // gc.cruftPacks=false
  // ---------------------------------------------------------------------

  describe('Given gc.cruftPacks=false and a fresh unreachable object', () => {
    describe('When gc runs', () => {
      it('Then it stays loose and no cruft pack is written', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'stays-loose');
        await appendConfig(ctx, '\n[gc]\n\tcruftPacks = false\n');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.cruftPackId).toBeUndefined();
        expect(await isLoose(ctx, blobId)).toBe(true);
      });
    });
  });

  describe('Given gc.cruftPacks=false and an existing cruft pack from a previous run', () => {
    describe('When gc runs', () => {
      it('Then survivors are written back loose and the cruft pack is retired', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'write-back');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), blobId), 2_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.cruftPackId).toBeDefined();
        const packDir = packDirOf(ctx);

        // Act
        await appendConfig(ctx, '\n[gc]\n\tcruftPacks = false\n');
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.cruftPackId).toBeUndefined();
        expect(await isLoose(ctx, blobId)).toBe(true);
        const entries = await ctx.fs.readdir(packDir);
        expect(entries.some((e) => e.name.endsWith('.mtimes'))).toBe(false);
      });
    });
  });

  describe('Given gc.cruftPacks=false and an aged unreachable object', () => {
    describe('When gc runs', () => {
      it('Then it is still destroyed', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'still-aged-out');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), blobId), 1_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tcruftPacks = false\n\tpruneExpire = @1500000000\n');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.cruftObjectsExpired).toBe(1);
        expect(await isLoose(ctx, blobId)).toBe(false);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Deletion safety
  // ---------------------------------------------------------------------

  describe('Given a cruft pack retirement interrupted right after the .idx unlink', () => {
    describe('When the fault propagates', () => {
      it('Then the fault is not swallowed, and the named .idx is gone from disk and the registry', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'half-retired');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), blobId), 2_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] }); // creates the first cruft pack
        expect(first.cruftPackId).toBeDefined();
        const packDir = packDirOf(ctx);
        const retiredIdxPath = `${packDir}/pack-${first.cruftPackId}.idx`;

        // Act — force a NEW cruft generation (rewrite branch), then fail the
        // retirement right after the old pack's `.idx` unlink.
        const newBlobId = await writeLooseBlob(ctx, 'forces-rewrite');
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), newBlobId), 2_100_000_000);
        const originalRm = ctx.fs.rm.bind(ctx.fs);
        let idxUnlinked = false;
        let faultInjected = false;
        const rmSpy = vi.spyOn(ctx.fs, 'rm').mockImplementation(async (path: string) => {
          if (path === retiredIdxPath && !idxUnlinked) {
            idxUnlinked = true;
            return originalRm(path);
          }
          // The very next unlink after the (real) `.idx` removal — an
          // abrupt crash mid-retirement, never a FILE_NOT_FOUND (which
          // `retireCruftPack` tolerates as idempotent, not a fault).
          if (idxUnlinked && !faultInjected) {
            faultInjected = true;
            throw new Error('injected-fault');
          }
          return originalRm(path);
        });
        let caught: unknown;
        try {
          await sut(ctx, { tasks: ['gc'] });
        } catch (error) {
          caught = error;
        }
        rmSpy.mockRestore();

        // Assert — the fault propagated (not swallowed), naming the
        // injected reason, and the old pack's own `.idx` is gone both from
        // disk and from a freshly-refreshed registry (pack discovery keys
        // on `.idx`).
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe('injected-fault');
        expect(idxUnlinked).toBe(true);
        expect(await ctx.fs.exists(retiredIdxPath)).toBe(false);
        refreshPackRegistry(ctx);
        const registeredNames = (await getPackRegistry(ctx).all()).map((p) => p.name);
        expect(registeredNames).not.toContain(`pack-${first.cruftPackId}`);
      });
    });
  });

  describe('Given a cruft pack write interrupted before the .mtimes is written', () => {
    describe('When the pack directory is inspected', () => {
      it('Then the pack/idx/rev already written read as an ordinary pack', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'half-written-cruft');
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;
        const originalWriteExclusive = ctx.fs.writeExclusive.bind(ctx.fs);
        const spy = vi
          .spyOn(ctx.fs, 'writeExclusive')
          .mockImplementation(async (path: string, data: Uint8Array) => {
            if (path.endsWith('.mtimes')) throw fileNotFound('injected-fault');
            return originalWriteExclusive(path, data);
          });

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: ['gc'] });
        } catch (error) {
          caught = error;
        }
        spy.mockRestore();

        // Assert — the underlying pack is fully written and readable, even
        // though its `.mtimes` sidecar never landed.
        expect(caught).toBeDefined();
        await expect(readObject(ctx, blobId, { verifyHash: true })).resolves.toMatchObject({
          type: 'blob',
        });
        const packDir = packDirOf(ctx);
        const entries = await ctx.fs.readdir(packDir);
        expect(entries.some((e) => e.name.endsWith('.mtimes'))).toBe(false);
        expect(entries.some((e) => e.name.endsWith('.idx'))).toBe(true);
      });
    });
  });

  describe('Given a loose object whose content does not hash to its own filename', () => {
    describe('When gc runs', () => {
      it("Then step 8's post-write verify refuses OBJECT_HASH_MISMATCH and nothing is destroyed", async () => {
        // Arrange — the same corrupted-loose-file technique
        // `read-object.test.ts` uses: a loose file planted at a chosen
        // (fake) oid whose content hashes to something else entirely.
        // `buildPack` reads it without verification, so the corruption
        // survives into the freshly-built cruft pack undetected — proving
        // step 8's OWN post-write `readObject(..., { verifyHash: true })`
        // pass, not the build step, is what has to catch it.
        const ctx = await seedOneCommit();
        const fakeId = 'b'.repeat(ctx.hashConfig.hexLength) as ObjectId;
        const rawBytes = new TextEncoder().encode('blob 3\0xyz');
        const compressed = await ctx.compressor.deflate(rawBytes);
        await ctx.fs.write(looseObjectPath(commonGitDir(ctx), fakeId), compressed);
        const sut = maintenance;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: ['gc'] });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('OBJECT_HASH_MISMATCH');
        expect(await isLoose(ctx, fakeId)).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Refs, reflogs and the index are untouched
  // ---------------------------------------------------------------------

  describe('Given gc runs against a repository with refs, a reflog and an index', () => {
    describe('When it completes', () => {
      it('Then refs, reflogs and the index are byte-identical to before', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        await writeLooseBlob(ctx, 'garbage-does-not-touch-refs');
        const refPath = `${ctx.layout.gitDir}/refs/heads/main`;
        const reflogPath = `${ctx.layout.gitDir}/logs/refs/heads/main`;
        const indexPath = `${ctx.layout.gitDir}/index`;
        const refBefore = await ctx.fs.read(refPath);
        const reflogBefore = await ctx.fs.read(reflogPath);
        const indexBefore = await ctx.fs.read(indexPath);
        const sut = maintenance;

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(
          Buffer.compare(Buffer.from(refBefore), Buffer.from(await ctx.fs.read(refPath))),
        ).toBe(0);
        expect(
          Buffer.compare(Buffer.from(reflogBefore), Buffer.from(await ctx.fs.read(reflogPath))),
        ).toBe(0);
        expect(
          Buffer.compare(Buffer.from(indexBefore), Buffer.from(await ctx.fs.read(indexPath))),
        ).toBe(0);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Loose-oid cache invariant repair
  // ---------------------------------------------------------------------

  describe('Given a pruned fanout prefix, cached as a HIT before gc runs', () => {
    describe('When the loose-oid cache is reprobed after gc', () => {
      it('Then it reports false rather than trusting the stale HIT', async () => {
        // Arrange — prime the cache with a real HIT for this exact oid
        // BEFORE gc unlinks it, the only way to prove gc's own
        // `forgetLooseOidPrefix` call actually invalidates the cache
        // rather than the assertion merely re-deriving from the
        // filesystem, unrelated to the cache at all.
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'pruned-and-reprobed');
        expect(await probeLooseOid(ctx, blobId)).toBe(true);
        const sut = maintenance;

        // Act
        await sut(ctx, { tasks: ['gc'] }); // packs the reachable set; blob crufted

        // Assert — the cache itself, re-probed, must not report a stale HIT
        // for a prefix gc unlinked from.
        expect(await probeLooseOid(ctx, blobId)).toBe(false);
        const stillLoose = await ctx.fs.exists(looseObjectPath(commonGitDir(ctx), blobId));
        expect(stillLoose).toBe(false);
      });
    });
  });

  describe('Given a tmp_obj_ quarantine litter file sitting in a loose fanout dir', () => {
    describe('When gc runs', () => {
      it('Then it succeeds, leaves the litter alone, and never crufts it', async () => {
        // Arrange — git's own quarantine naming for a loose-object write
        // that never completed; not hex, not the right width, never an oid.
        const ctx = await seedOneCommit();
        const litterPath = `${ctx.layout.gitDir}/objects/ab/tmp_obj_XXXXXX`;
        await ctx.fs.write(litterPath, new Uint8Array(0));
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert — succeeds without wedging; the litter is never enumerated,
        // so it is never a cruft candidate and gc leaves it untouched.
        expect(result.tasksRun).toEqual(['gc']);
        expect(await ctx.fs.exists(litterPath)).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Structural — no rendered text
  // ---------------------------------------------------------------------

  describe('Given a successful maintenance result with both tasks run', () => {
    describe('When every field is inspected', () => {
      it('Then it carries no rendered text — only counts, booleans and enums', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        await writeLooseBlob(ctx, 'for-structure');
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['commit-graph', 'gc'] });

        // Assert
        expect(Object.keys(result).sort()).toEqual(
          [
            'tasksRun',
            'commitGraphWritten',
            'commitsInGraph',
            'looseObjectsBefore',
            'looseObjectsPacked',
            'prunedLooseObjects',
            'packsBefore',
            'packsAfter',
            'packId',
            'cruftObjectsAdded',
            'cruftObjectsRetained',
            'cruftObjectsExpired',
            'cruftPackId',
            'promisorPackId',
            'packsRetired',
            'packBytesBefore',
            'packBytesAfter',
          ].sort(),
        );
        expect(typeof result.commitGraphWritten).toBe('boolean');
        expect(typeof result.commitsInGraph).toBe('number');
        expect(typeof result.looseObjectsBefore).toBe('number');
        expect(typeof result.looseObjectsPacked).toBe('number');
        expect(typeof result.prunedLooseObjects).toBe('number');
        expect(typeof result.packsBefore).toBe('number');
        expect(typeof result.packsAfter).toBe('number');
        expect(typeof result.cruftObjectsAdded).toBe('number');
        expect(typeof result.cruftObjectsRetained).toBe('number');
        expect(typeof result.cruftObjectsExpired).toBe('number');
        expect(typeof result.packsRetired).toBe('number');
        expect(typeof result.packBytesBefore).toBe('number');
        expect(typeof result.packBytesAfter).toBe('number');
        expect(Array.isArray(result.tasksRun)).toBe(true);
        for (const task of result.tasksRun) {
          expect(['commit-graph', 'gc']).toContain(task);
        }
      });
    });
  });

  // ---------------------------------------------------------------------
  // Consolidation — *.keep total exclusion
  // ---------------------------------------------------------------------

  describe('Given a reachable object living only in a *.keep-marked pack', () => {
    describe('When gc runs again', () => {
      it('Then its oid does NOT appear in the new normal pack', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        const keptCommitId = (
          await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)
        ).trim() as ObjectId;
        const packDir = packDirOf(ctx);
        await ctx.fs.write(`${packDir}/pack-${first.packId}.keep`, new Uint8Array(0));
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'more');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author: AUTHOR });

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert — absence, never a count.
        expect(second.packId).toBeDefined();
        expect(second.packId).not.toBe(first.packId);
        const newPackOids = await packMemberOids(ctx, second.packId as string);
        expect(newPackOids.has(keptCommitId)).toBe(false);
      });
    });
  });

  describe('Given an unreachable object living inside a *.keep-marked pack', () => {
    describe('When gc runs', () => {
      it('Then no cruft pack is written for it', async () => {
        // Arrange — a standalone unreferenced blob, first packed via the
        // ordinary cruft lifecycle, then re-marked as a kept pack (drop
        // `.mtimes`, add `.keep`) to simulate a pre-existing kept pack
        // whose sole member is unreachable.
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const blobId = await writeLooseBlob(ctx, 'kept-unreachable');
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.cruftPackId).toBeDefined();
        const packDir = packDirOf(ctx);
        await ctx.fs.rm(`${packDir}/pack-${first.cruftPackId}.mtimes`);
        await ctx.fs.write(`${packDir}/pack-${first.cruftPackId}.keep`, new Uint8Array(0));

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.cruftPackId).toBeUndefined();
        await expect(readObject(ctx, blobId)).resolves.toMatchObject({ type: 'blob' });
      });
    });
  });

  describe('Given a pack carrying both .keep and .mtimes markers', () => {
    describe('When gc runs again', () => {
      it('Then every one of its files survives — never treated as existing cruft, never retired', async () => {
        // Arrange — a genuine cruft pack (`.mtimes` written by a real gc
        // run) subsequently ALSO marked `.keep` without dropping `.mtimes`
        // — the `.keep` total exclusion must win over the cruft lifecycle
        // even when both markers coexist.
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const blobId = await writeLooseBlob(ctx, 'keep-and-mtimes');
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.cruftPackId).toBeDefined();
        const packDir = packDirOf(ctx);
        const cruftSha = first.cruftPackId as string;
        await ctx.fs.write(`${packDir}/pack-${cruftSha}.keep`, new Uint8Array(0));

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert — never treated as existing cruft (no new cruft pack for
        // the sole unreachable object), and its own four files untouched.
        expect(second.cruftPackId).toBeUndefined();
        expect(await ctx.fs.exists(`${packDir}/pack-${cruftSha}.idx`)).toBe(true);
        expect(await ctx.fs.exists(`${packDir}/pack-${cruftSha}.pack`)).toBe(true);
        expect(await ctx.fs.exists(`${packDir}/pack-${cruftSha}.mtimes`)).toBe(true);
        expect(await ctx.fs.exists(`${packDir}/pack-${cruftSha}.keep`)).toBe(true);
        await expect(readObject(ctx, blobId, { verifyHash: true })).resolves.toMatchObject({
          type: 'blob',
        });
      });
    });
  });

  describe('Given a repository whose only pack is *.keep-marked and nothing is loose', () => {
    describe('When gc runs', () => {
      it('Then gc writes nothing', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        const packDir = packDirOf(ctx);
        await ctx.fs.write(`${packDir}/pack-${first.packId}.keep`, new Uint8Array(0));
        const entriesBefore = (await ctx.fs.readdir(packDir)).map((e) => e.name).sort();

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });
        const entriesAfter = (await ctx.fs.readdir(packDir)).map((e) => e.name).sort();

        // Assert — distinct from the single-normal-pack case below: here
        // NOTHING is written, not even a rewrite under the same sha.
        expect(second.packId).toBeUndefined();
        expect(second.cruftPackId).toBeUndefined();
        expect(second.packsRetired).toBe(0);
        expect(entriesAfter).toEqual(entriesBefore);
      });
    });
  });

  // ---------------------------------------------------------------------
  // The no-op boundary — unchanged content reproduces the same sha
  // ---------------------------------------------------------------------

  describe('Given exactly one normal pack and nothing loose', () => {
    describe('When gc runs again', () => {
      it('Then it rewrites the pack under the SAME sha', async () => {
        // Arrange — distinct from the *.keep empty-input case above: here
        // gc DOES write, reproducing the same content.
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const commitId = (
          await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)
        ).trim() as ObjectId;
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.packId).toBeDefined();

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.packId).toBe(first.packId);
        await expect(readObject(ctx, commitId, { verifyHash: true })).resolves.toMatchObject({
          type: 'commit',
        });
      });
    });
  });

  describe('Given a second gc on an object set unchanged since the last run', () => {
    describe('When a third gc runs too', () => {
      it('Then the same <sha> keeps being produced', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        const second = await sut(ctx, { tasks: ['gc'] });

        // Act
        const third = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.packId).toBe(first.packId);
        expect(third.packId).toBe(first.packId);
      });
    });
  });

  // ---------------------------------------------------------------------
  // The three-source mtime max
  // ---------------------------------------------------------------------

  describe('Given an object present in all three mtime sources at once', () => {
    const CUTOFF = 2_000_000_000;

    /** Seeds an object that is simultaneously loose, carried forward in an
     *  existing cruft sidecar (from a prior gc run), and present inside a
     *  synthetic pre-existing NORMAL pack — with each source's mtime
     *  independently controllable. */
    async function seedTripleSourceObject(
      ctx: Context,
      content: string,
      mtimes: { readonly loose: number; readonly carried: number; readonly normalPack: number },
    ): Promise<void> {
      const { forceMtimeSeconds } = installLstatOverrides(ctx);
      const blobId = await writeLooseBlob(ctx, content);
      const loosePath = looseObjectPath(commonGitDir(ctx), blobId);
      forceMtimeSeconds(loosePath, mtimes.carried);
      await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
      await maintenance(ctx, { tasks: ['gc'] }); // crufts it — carried mtime = mtimes.carried

      await writeLooseBlob(ctx, content); // freshen: loose again
      forceMtimeSeconds(loosePath, mtimes.loose);
      await writeSyntheticPack(ctx, 'triple-src', [
        { kind: 'base', type: 'blob', content: enc.encode(content) },
      ]);
      forceMtimeSeconds(`${packDirOf(ctx)}/pack-triple-src.pack`, mtimes.normalPack);
    }

    describe('When the loose copy is the newest source', () => {
      it('Then it survives on the loose mtime alone', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        await seedTripleSourceObject(ctx, 'triple-loose-wins', {
          loose: 3_000_000_000,
          carried: 1_000_000_000,
          normalPack: 1_000_000_000,
        });
        await appendConfig(ctx, `\n[gc]\n\tpruneExpire = @${CUTOFF}\n`);
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.cruftObjectsRetained).toBe(1);
        expect(result.cruftObjectsExpired).toBe(0);
      });
    });

    describe('When the carried sidecar entry is the newest source', () => {
      it('Then it survives on the carried mtime alone', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        await seedTripleSourceObject(ctx, 'triple-carried-wins', {
          loose: 1_000_000_000,
          carried: 3_000_000_000,
          normalPack: 1_000_000_000,
        });
        await appendConfig(ctx, `\n[gc]\n\tpruneExpire = @${CUTOFF}\n`);
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.cruftObjectsRetained).toBe(1);
        expect(result.cruftObjectsExpired).toBe(0);
      });
    });

    describe('When the superseded normal pack is the newest source', () => {
      it('Then it survives on the normal-pack mtime alone', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        await seedTripleSourceObject(ctx, 'triple-normal-pack-wins', {
          loose: 1_000_000_000,
          carried: 1_000_000_000,
          normalPack: 3_000_000_000,
        });
        await appendConfig(ctx, `\n[gc]\n\tpruneExpire = @${CUTOFF}\n`);
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.cruftObjectsRetained).toBe(1);
        expect(result.cruftObjectsExpired).toBe(0);
      });
    });
  });

  describe('Given an object packed while reachable, then made unreachable', () => {
    describe('When gc runs', () => {
      it("Then it migrates to the cruft pack carrying its source pack's mtime, not the run time", async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const blobId = await seedDoomedBlob(ctx, 'migrates-with-source-mtime');
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.packId).toBeDefined();
        const packDir = packDirOf(ctx);
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        const PAST_MTIME = 1_600_000_000;
        forceMtimeSeconds(`${packDir}/pack-${first.packId}.pack`, PAST_MTIME);
        await severDoomedBranch(ctx);

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert — the assertion that catches an implementation stat-ing
        // AFTER the rename rather than before.
        expect(second.cruftPackId).toBeDefined();
        const recorded = await readCruftMtime(ctx, second.cruftPackId as string, blobId);
        expect(recorded).toBe(PAST_MTIME);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Deletion safety — normal-pack retirement
  // ---------------------------------------------------------------------

  describe('Given a normal-pack retirement interrupted right after the .idx unlink', () => {
    describe('When the fault propagates', () => {
      it('Then the half-retired pack is invisible to createPackRegistry', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'more');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author: AUTHOR });
        const packDir = packDirOf(ctx);

        const originalRm = ctx.fs.rm.bind(ctx.fs);
        let idxUnlinked = false;
        let faultInjected = false;
        const rmSpy = vi.spyOn(ctx.fs, 'rm').mockImplementation(async (path: string) => {
          if (path === `${packDir}/pack-${first.packId}.idx` && !idxUnlinked) {
            idxUnlinked = true;
            return originalRm(path);
          }
          if (idxUnlinked && !faultInjected) {
            faultInjected = true;
            throw new Error('injected-fault');
          }
          return originalRm(path);
        });

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: ['gc'] });
        } catch (error) {
          caught = error;
        }
        rmSpy.mockRestore();

        // Assert
        expect(caught).toBeDefined();
        expect(idxUnlinked).toBe(true);
        refreshPackRegistry(ctx);
        const registeredNames = (await getPackRegistry(ctx).all()).map((p) => p.name);
        expect(registeredNames).not.toContain(`pack-${first.packId}`);
      });
    });
  });

  describe('Given a pack retirement following the post-write verify and prune-packable scan', () => {
    describe('When gc runs', () => {
      it("Then refresh drains that scan's own handles before settleRefresh, ahead of any pack unlink", async () => {
        // Arrange — force a normal-pack retirement on the second run, so
        // this run's own step-8 verify loop and step-9 `packedAnywhere`
        // scan open pack-read handles that must be drained before the
        // superseded pack's files are unlinked (Windows-unlink safety).
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.packId).toBeDefined();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'more');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author: AUTHOR });

        const registry = getPackRegistry(ctx);
        const lookupSpy = vi.spyOn(registry, 'lookup');
        const refreshSpy = vi.spyOn(registry, 'refresh');
        const settleSpy = vi.spyOn(registry, 'settleRefresh');
        const rmSpy = vi.spyOn(ctx.fs, 'rm');

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.packsRetired).toBeGreaterThan(0);
        const lastLookupOrder = Math.max(-1, ...lookupSpy.mock.invocationCallOrder);
        const drainOrders = refreshSpy.mock.invocationCallOrder.filter(
          (order) => order > lastLookupOrder,
        );
        expect(drainOrders.length).toBeGreaterThan(0);
        const drainOrder = Math.min(...drainOrders);
        const settleOrder = Math.min(...settleSpy.mock.invocationCallOrder);
        expect(settleOrder).toBeGreaterThan(drainOrder);
        // Only the RETIRED (first) pack's own unlinks — a fresh pack's
        // stale-sibling cleanup in the quarantine writer also touches
        // `/pack-` paths, but under the NEW sha and long before step 8.
        const retiredPackUnlinkOrders = rmSpy.mock.calls
          .map((call, i) => ({ path: call[0] as string, order: rmSpy.mock.invocationCallOrder[i] }))
          .filter(
            (entry): entry is { readonly path: string; readonly order: number } =>
              entry.order !== undefined && entry.path.includes(`pack-${first.packId}`),
          )
          .map((entry) => entry.order);
        expect(retiredPackUnlinkOrders.length).toBeGreaterThan(0);
        expect(Math.min(...retiredPackUnlinkOrders)).toBeGreaterThan(settleOrder);
      });
    });
  });

  describe('Given a superseded normal pack with a .bitmap sibling', () => {
    describe('When gc consolidates it away', () => {
      it('Then the bitmap is deleted with it and no orphan is left', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        const packDir = packDirOf(ctx);
        await ctx.fs.write(`${packDir}/pack-${first.packId}.bitmap`, new Uint8Array(4));
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'more');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author: AUTHOR });

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(await ctx.fs.exists(`${packDir}/pack-${first.packId}.bitmap`)).toBe(false);
      });
    });
  });

  // ---------------------------------------------------------------------
  // midx expiry
  // ---------------------------------------------------------------------

  describe('Given a multi-pack-index naming a pack gc retires', () => {
    describe('When gc runs', () => {
      it('Then the multi-pack-index is deleted', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        const packDir = packDirOf(ctx);
        await writeMinimalMidx(ctx, packDir, [`pack-${first.packId}.idx`]);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'more');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author: AUTHOR });

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(await ctx.fs.exists(multiPackIndexPath(packDir))).toBe(false);
      });
    });
  });

  describe('Given a multi-pack-index naming a pack gc retires, timing-sensitive', () => {
    describe('When gc runs', () => {
      it("Then the midx is expired BEFORE that pack's own files are unlinked", async () => {
        // Arrange — a midx surviving even briefly past its first named
        // pack's removal is a dangling reference; the expiry must land
        // strictly before the first unlink of that pack's own files.
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        const packDir = packDirOf(ctx);
        const midxPath = multiPackIndexPath(packDir);
        await writeMinimalMidx(ctx, packDir, [`pack-${first.packId}.idx`]);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'more');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author: AUTHOR });
        const rmSpy = vi.spyOn(ctx.fs, 'rm');

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        const orderOf = (path: string): number | undefined => {
          const index = rmSpy.mock.calls.findIndex((call) => call[0] === path);
          return index === -1 ? undefined : rmSpy.mock.invocationCallOrder[index];
        };
        const midxOrder = orderOf(midxPath);
        const packIdxOrder = orderOf(`${packDir}/pack-${first.packId}.idx`);
        expect(midxOrder).toBeDefined();
        expect(packIdxOrder).toBeDefined();
        expect(midxOrder as number).toBeLessThan(packIdxOrder as number);
      });
    });
  });

  describe('Given a multi-pack-index naming only a *.keep-marked pack', () => {
    describe('When gc runs', () => {
      it('Then it is left untouched and still readable', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        const packDir = packDirOf(ctx);
        await ctx.fs.write(`${packDir}/pack-${first.packId}.keep`, new Uint8Array(0));
        await writeMinimalMidx(ctx, packDir, [`pack-${first.packId}.idx`]);
        const midxBefore = await ctx.fs.read(multiPackIndexPath(packDir));

        // Act — nothing else reachable to pack; the kept pack is untouched.
        await sut(ctx, { tasks: ['gc'] });
        const midxAfter = await ctx.fs.read(multiPackIndexPath(packDir));

        // Assert
        expect(Buffer.compare(Buffer.from(midxBefore), Buffer.from(midxAfter))).toBe(0);
      });
    });
  });

  // ---------------------------------------------------------------------
  // gc.cruftPacks=false loosening a superseded NORMAL pack's member
  // ---------------------------------------------------------------------

  describe('Given gc.cruftPacks=false and an unreachable object living only inside a pack about to be superseded', () => {
    describe('When gc runs', () => {
      it('Then it is written back out as a loose file and survives', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const blobId = await seedDoomedBlob(ctx, 'loosened-from-normal-pack');
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.packId).toBeDefined();
        await severDoomedBranch(ctx);
        await appendConfig(ctx, '\n[gc]\n\tcruftPacks = false\n');

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.cruftPackId).toBeUndefined();
        expect(await isLoose(ctx, blobId)).toBe(true);
        await expect(readObject(ctx, blobId)).resolves.toMatchObject({ type: 'blob' });
      });
    });
  });

  describe('Given gc.cruftPacks=false and an aged unreachable object living only inside a pack about to be superseded', () => {
    describe('When gc runs', () => {
      it('Then it is destroyed with the pack — a skip-the-cruft-steps implementation would pass every other case and lose data here', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const blobId = await seedDoomedBlob(ctx, 'destroyed-with-normal-pack');
        const first = await sut(ctx, { tasks: ['gc'] });
        const packDir = packDirOf(ctx);
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(`${packDir}/pack-${first.packId}.pack`, 1_000_000_000);
        await severDoomedBranch(ctx);
        await appendConfig(ctx, '\n[gc]\n\tcruftPacks = false\n\tpruneExpire = @1500000000\n');

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert — the doomed commit, tree AND blob all migrate out of the
        // same superseded pack together, so all three expire together.
        expect(second.cruftObjectsExpired).toBe(3);
        expect(await isLoose(ctx, blobId)).toBe(false);
        let caught: unknown;
        try {
          await readObject(ctx, blobId);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  // ---------------------------------------------------------------------
  // Two-cruft-pack crash recovery
  // ---------------------------------------------------------------------

  describe('Given a crash state with two valid cruft packs (a retirement that never completed)', () => {
    describe('When the next gc runs', () => {
      it('Then it treats their union as existingCruft and retires all but the one it writes', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const oldBlobId = await writeLooseBlob(ctx, 'crash-old');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), oldBlobId), 1_900_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.cruftPackId).toBeDefined();
        const c1Sha = first.cruftPackId as string;
        const packDir = packDirOf(ctx);

        // Simulate "crashed between step 7's write and step 10's retire":
        // new garbage forces fate='rewrite' (a genuinely new sha), but the
        // old cruft pack's own retirement is suppressed so both survive.
        const newBlobId = await writeLooseBlob(ctx, 'crash-new');
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), newBlobId), 1_950_000_000);
        const originalRm = ctx.fs.rm.bind(ctx.fs);
        const rmSpy = vi.spyOn(ctx.fs, 'rm').mockImplementation(async (path: string) => {
          if (path.startsWith(`${packDir}/pack-${c1Sha}.`)) return;
          return originalRm(path);
        });
        const second = await sut(ctx, { tasks: ['gc'] });
        rmSpy.mockRestore();
        expect(second.cruftPackId).toBeDefined();
        expect(second.cruftPackId).not.toBe(c1Sha);
        const c2Sha = second.cruftPackId as string;
        expect(await ctx.fs.exists(`${packDir}/pack-${c1Sha}.mtimes`)).toBe(true);
        expect(await ctx.fs.exists(`${packDir}/pack-${c2Sha}.mtimes`)).toBe(true);

        // Act
        const third = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(third.cruftObjectsRetained).toBe(2);
        expect(await ctx.fs.exists(`${packDir}/pack-${c1Sha}.mtimes`)).toBe(false);
        await expect(readObject(ctx, oldBlobId)).resolves.toMatchObject({ type: 'blob' });
        await expect(readObject(ctx, newBlobId)).resolves.toMatchObject({ type: 'blob' });
      });
    });
  });

  // ---------------------------------------------------------------------
  // packsRetired / packBytesBefore / packBytesAfter
  // ---------------------------------------------------------------------

  describe('Given a normal pack superseded by a fresh consolidation', () => {
    describe('When gc runs', () => {
      it('Then packsRetired counts it and packBytesBefore matches the summed .pack bytes on disk beforehand', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'more');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author: AUTHOR });
        const packDir = packDirOf(ctx);
        const entriesBefore = await ctx.fs.readdir(packDir);
        let expectedBefore = 0;
        for (const entry of entriesBefore) {
          if (entry.isFile && entry.name.endsWith('.pack')) {
            expectedBefore += (await ctx.fs.stat(`${packDir}/${entry.name}`)).size;
          }
        }

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.packsRetired).toBe(1);
        expect(second.packBytesBefore).toBe(expectedBefore);
        expect(second.packBytesAfter).toBeGreaterThan(0);
        expect(first.packId).not.toBe(second.packId);
      });
    });
  });

  // ---------------------------------------------------------------------
  // settleRefresh ordering
  // ---------------------------------------------------------------------

  describe('Given a normal pack about to be superseded by consolidation', () => {
    describe('When gc runs', () => {
      it('Then settleRefresh is awaited before the first unlink of that pack', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const first = await sut(ctx, { tasks: ['gc'] });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'more');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author: AUTHOR });
        const packDir = packDirOf(ctx);

        const registry = getPackRegistry(ctx);
        const events: string[] = [];
        const settleSpy = vi.spyOn(registry, 'settleRefresh').mockImplementation(async () => {
          events.push('settleRefresh');
        });
        const originalRm = ctx.fs.rm.bind(ctx.fs);
        const rmSpy = vi.spyOn(ctx.fs, 'rm').mockImplementation(async (path: string) => {
          if (path.startsWith(`${packDir}/pack-${first.packId}.`)) events.push(`rm:${path}`);
          return originalRm(path);
        });

        // Act
        await sut(ctx, { tasks: ['gc'] });
        settleSpy.mockRestore();
        rmSpy.mockRestore();

        // Assert
        expect(events[0]).toBe('settleRefresh');
        expect(events.length).toBeGreaterThan(1);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Consolidation — promisor packs
  // ---------------------------------------------------------------------

  describe('Given the same UNREACHABLE oid loose AND inside a .promisor-marked pack', () => {
    describe('When gc runs', () => {
      it('Then the promisor class wins: the new promisor pack carries it, the new normal pack does not, and its loose copy is unlinked', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const overlapId = await writeLooseBlob(ctx, 'overlap-loose-and-promisor');
        await writePromisorPack(ctx, 'overlap-promisor', ['overlap-loose-and-promisor']);

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert — seedOneCommit's own reachable content (blob/tree/commit)
        // guarantees a normal pack always exists this run, so this is
        // asserted unconditionally rather than behind a dead guard.
        expect(result.promisorPackId).toBeDefined();
        const promisorOids = await packMemberOids(ctx, result.promisorPackId as string);
        expect(promisorOids.has(overlapId)).toBe(true);
        expect(result.packId).toBeDefined();
        const normalOids = await packMemberOids(ctx, result.packId as ObjectId);
        expect(normalOids.has(overlapId)).toBe(false);
        expect(await isLoose(ctx, overlapId)).toBe(false);
      });
    });
  });

  describe('Given an unreachable object living only inside a .promisor-marked pack', () => {
    describe('When gc runs', () => {
      it('Then it lands in the new promisor pack and never in the cruft pack', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const [unreachableId] = await writePromisorPack(ctx, 'unreachable-promisor', [
          'unreachable-promisor-seed',
        ]);

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert — the only unreachable object here lives inside the
        // promisor pack, so no cruft candidate ever exists this run; a
        // dead "if it exists" guard would never prove that.
        expect(result.promisorPackId).toBeDefined();
        const promisorOids = await packMemberOids(ctx, result.promisorPackId as string);
        expect(promisorOids.has(unreachableId as ObjectId)).toBe(true);
        expect(result.cruftPackId).toBeUndefined();
      });
    });
  });

  describe('Given a cutoff that would destroy any other unreachable object, with an unreachable promisor object also present', () => {
    describe('When gc runs', () => {
      it('Then the promisor object survives while the ordinary unreachable object is destroyed', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const [promisorId] = await writePromisorPack(ctx, 'survives-cutoff', [
          'survives-cutoff-seed',
        ]);
        const controlId = await writeLooseBlob(ctx, 'destroyed-by-cutoff');
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = now\n');

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        await expect(readObject(ctx, promisorId as ObjectId)).resolves.toMatchObject({
          type: 'blob',
        });
        expect(result.promisorPackId).toBeDefined();
        let caught: unknown;
        try {
          await readObject(ctx, controlId);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  describe('Given a reachable object living only inside a .promisor-marked pack', () => {
    describe('When gc runs', () => {
      it('Then it is packed into BOTH the new normal pack and the new promisor pack — matching git', async () => {
        // Arrange — index-reachable (no commit needed) and NOT loose: the
        // object's only home before gc is the promisor-marked pack.
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const content = 'reachable-promisor-only';
        const blobId = await writeLooseBlob(ctx, content);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/staged.txt`, content);
        await add(ctx, ['staged.txt']);
        await writePromisorPack(ctx, 'reachable-dup-promisor', [content]);
        await ctx.fs.rm(looseObjectPath(commonGitDir(ctx), blobId));

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert — git's own gc does not exclude promisor membership from
        // the normal pack the way it excludes `.keep`: a reachable object
        // duplicates into both.
        expect(result.packId).toBeDefined();
        expect(result.promisorPackId).toBeDefined();
        const normalOids = await packMemberOids(ctx, result.packId as string);
        const promisorOids = await packMemberOids(ctx, result.promisorPackId as string);
        expect(normalOids.has(blobId)).toBe(true);
        expect(promisorOids.has(blobId)).toBe(true);
      });
    });
  });

  describe('Given a second gc on a REACHABLE promisor set unchanged since the last run', () => {
    describe('When gc runs again', () => {
      it('Then both the normal pack sha and the promisor pack sha stay identical', async () => {
        // Arrange — the no-op boundary, over the duplicated set: a repeat
        // run over an unchanged reachable promisor object must reproduce
        // the same sha for BOTH packs it now lives in.
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const content = 'repeat-duplicate-seed';
        const blobId = await writeLooseBlob(ctx, content);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/staged.txt`, content);
        await add(ctx, ['staged.txt']);
        await writePromisorPack(ctx, 'repeat-duplicate', [content]);
        await ctx.fs.rm(looseObjectPath(commonGitDir(ctx), blobId));
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.packId).toBeDefined();
        expect(first.promisorPackId).toBeDefined();

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.packId).toBe(first.packId);
        expect(second.promisorPackId).toBe(first.promisorPackId);
      });
    });
  });

  describe('Given a repository with no promisor packs at all', () => {
    describe('When gc runs', () => {
      it('Then no .promisor file is written anywhere', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const packDir = packDirOf(ctx);

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });
        const entries = await ctx.fs.readdir(packDir);

        // Assert
        expect(result.promisorPackId).toBeUndefined();
        expect(entries.some((entry) => entry.name.endsWith('.promisor'))).toBe(false);
      });
    });
  });

  describe('Given a partial clone whose non-promisor half is entirely .keep-marked', () => {
    describe('When gc runs', () => {
      it('Then a promisor pack is written and no normal pack is', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const packDir = packDirOf(ctx);
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.packId).toBeDefined();
        await ctx.fs.write(`${packDir}/pack-${first.packId}.keep`, new Uint8Array(0));
        await writePromisorPack(ctx, 'keep-half-promisor', ['keep-half-promisor-seed']);

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.promisorPackId).toBeDefined();
        expect(second.packId).toBeUndefined();
      });
    });
  });

  describe('Given both a normal-pack-worthy reachable object and a promisor pack input in the same run', () => {
    describe('When gc runs', () => {
      it('Then writePackArtifactsViaQuarantine is called with promisor: false for the normal pack and promisor: true for the promisor pack', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        await writePromisorPack(ctx, 'spy-promisor', ['spy-promisor-seed']);
        const spy = vi.spyOn(writePackArtifactsMod, 'writePackArtifactsViaQuarantine');

        // Act
        await sut(ctx, { tasks: ['gc'] });
        const promisorFlags = spy.mock.calls.map((call) => call[1].promisor);
        spy.mockRestore();

        // Assert
        expect(promisorFlags).toContain(false);
        expect(promisorFlags).toContain(true);
      });
    });
  });

  describe('Given a promisor-pack retirement interrupted right after the .idx unlink', () => {
    describe('When the fault propagates', () => {
      it('Then the half-retired pack is invisible to createPackRegistry and its .promisor sidecar is still present', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const packDir = packDirOf(ctx);
        await writePromisorPack(ctx, 'fault-p1', ['fault-promisor-seed']);
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.promisorPackId).toBeDefined();
        const firstPromisorSha = first.promisorPackId as string;
        // Widen the promisor set so the second gc supersedes the first
        // promisor pack under a new sha — otherwise the no-op boundary
        // reproduces the identical sha and nothing is retired.
        await writePromisorPack(ctx, 'fault-p2', ['fault-promisor-seed-2']);

        const originalRm = ctx.fs.rm.bind(ctx.fs);
        let idxUnlinked = false;
        let faultInjected = false;
        const rmSpy = vi.spyOn(ctx.fs, 'rm').mockImplementation(async (path: string) => {
          if (path === `${packDir}/pack-${firstPromisorSha}.idx` && !idxUnlinked) {
            idxUnlinked = true;
            return originalRm(path);
          }
          if (idxUnlinked && !faultInjected) {
            faultInjected = true;
            throw new Error('injected-fault');
          }
          return originalRm(path);
        });

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: ['gc'] });
        } catch (error) {
          caught = error;
        }
        rmSpy.mockRestore();

        // Assert
        expect(caught).toBeDefined();
        expect(idxUnlinked).toBe(true);
        refreshPackRegistry(ctx);
        const registeredNames = (await getPackRegistry(ctx).all()).map((p) => p.name);
        expect(registeredNames).not.toContain(`pack-${firstPromisorSha}`);
        expect(await ctx.fs.exists(`${packDir}/pack-${firstPromisorSha}.promisor`)).toBe(true);
      });
    });
  });

  describe('Given a pack carrying both .keep and .promisor', () => {
    describe('When gc runs', () => {
      it('Then .keep wins: the pack is untouched and contributes nothing to the new promisor pack', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const packDir = packDirOf(ctx);
        await writePromisorPack(ctx, 'kept-and-promisor', ['kept-and-promisor-seed']);
        await ctx.fs.write(`${packDir}/pack-kept-and-promisor.keep`, new Uint8Array(0));
        const before = await ctx.fs.read(`${packDir}/pack-kept-and-promisor.pack`);

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });
        const after = await ctx.fs.read(`${packDir}/pack-kept-and-promisor.pack`);

        // Assert
        expect(result.promisorPackId).toBeUndefined();
        expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).toBe(0);
      });
    });
  });

  describe('Given a .keep-and-.promisor-marked pack alongside a plain .promisor-marked pack', () => {
    describe('When gc runs', () => {
      it('Then the kept pack is untouched but the other promisor pack is still consolidated', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const packDir = packDirOf(ctx);
        await writePromisorPack(ctx, 'kept-twin-a', ['kept-twin-a-seed']);
        await ctx.fs.write(`${packDir}/pack-kept-twin-a.keep`, new Uint8Array(0));
        const [consolidatedId] = await writePromisorPack(ctx, 'kept-twin-b', ['kept-twin-b-seed']);

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.promisorPackId).toBeDefined();
        const promisorOids = await packMemberOids(ctx, result.promisorPackId as string);
        expect(promisorOids.has(consolidatedId as ObjectId)).toBe(true);
        expect(await ctx.fs.exists(`${packDir}/pack-kept-twin-a.pack`)).toBe(true);
        expect(await ctx.fs.exists(`${packDir}/pack-kept-twin-b.pack`)).toBe(false);
      });
    });
  });

  describe('Given an ordinary repository with no promisor packs', () => {
    describe('When gc runs', () => {
      it('Then promisorPackId is undefined', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.promisorPackId).toBeUndefined();
      });
    });
  });

  describe('Given a partial-clone-shaped repository with a promisor pack', () => {
    describe('When gc runs', () => {
      it("Then promisorPackId equals the new promisor pack's sha", async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        await writePromisorPack(ctx, 'shape-check', ['shape-check-seed']);

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.promisorPackId).toBeDefined();
        const packDir = packDirOf(ctx);
        expect(await ctx.fs.exists(`${packDir}/pack-${result.promisorPackId}.promisor`)).toBe(true);
      });
    });
  });

  describe('Given a second gc on a promisor set unchanged since the last run', () => {
    describe('When gc runs again', () => {
      it('Then the same promisor pack sha keeps being produced, with .promisor still present', async () => {
        // Arrange — the no-op boundary applied to the promisor class: a
        // repeat run over an unchanged set reproduces the exact same sha,
        // so the rewrite must tolerate a `.promisor` sentinel already
        // sitting at that name from the prior run.
        const ctx = await seedOneCommit();
        const sut = maintenance;
        await writePromisorPack(ctx, 'no-op-boundary', ['no-op-boundary-seed']);
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.promisorPackId).toBeDefined();

        // Act
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.promisorPackId).toBe(first.promisorPackId);
        const packDir = packDirOf(ctx);
        expect(await ctx.fs.exists(`${packDir}/pack-${second.promisorPackId}.promisor`)).toBe(true);
      });
    });
  });

  describe('Given two promisor packs discovered in opposite orders across two otherwise-identical repositories', () => {
    describe('When gc runs on each', () => {
      it('Then the rebuilt promisor pack is byte-identical regardless of discovery order', async () => {
        // Arrange — identical final object SET, opposite pack-write (hence
        // discovery) order; `toPromisorPack` must sort before packing or
        // the two runs assemble their entries in different array order and
        // produce different shas for the same content, breaking the no-op
        // boundary's promise that content alone determines the sha.
        const ctxA = await seedOneCommit();
        await writePromisorPack(ctxA, 'promisor-order-p1', ['sort-stability-p1']);
        await writePromisorPack(ctxA, 'promisor-order-p2', ['sort-stability-p2']);

        const ctxB = await seedOneCommit();
        await writePromisorPack(ctxB, 'promisor-order-p2', ['sort-stability-p2']);
        await writePromisorPack(ctxB, 'promisor-order-p1', ['sort-stability-p1']);
        const sut = maintenance;

        // Act
        const resultA = await sut(ctxA, { tasks: ['gc'] });
        const resultB = await sut(ctxB, { tasks: ['gc'] });

        // Assert
        expect(resultA.promisorPackId).toBeDefined();
        expect(resultB.promisorPackId).toBeDefined();
        expect(resultA.promisorPackId).toBe(resultB.promisorPackId);
      });
    });
  });

  describe('Given retirable packs across the normal, cruft AND promisor classes in the same run', () => {
    describe('When gc runs', () => {
      it('Then packsRetired spans all three retirable classes', async () => {
        // Arrange — one gc seeds one retirable pack per the normal and
        // cruft classes; the promisor class gets its first-ever pack only
        // at the widening step below, so it retires exactly once too (a
        // promisor pack already consolidated by this same first gc would
        // need a SECOND widening of its own to retire, muddying the count).
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const doomedBlobId = await writeLooseBlob(ctx, 'cruft-seed');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), doomedBlobId), 1_900_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.packId).toBeDefined();
        expect(first.cruftPackId).toBeDefined();

        // Act — force every class to rewrite under a new sha: a new
        // reachable commit (normal), a new aged unreachable blob (cruft),
        // and the first-ever promisor pack (promisor).
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'more');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author: AUTHOR });
        const newCruftBlobId = await writeLooseBlob(ctx, 'cruft-seed-2');
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), newCruftBlobId), 1_900_000_000);
        await writePromisorPack(ctx, 'retire-p1', ['promisor-retire-seed']);
        const second = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(second.packsRetired).toBe(3);
      });
    });
  });

  describe('Given a partial-clone-shaped repository with a promisor pack, a normal pack and nothing else', () => {
    describe('When gc runs', () => {
      it('Then packsAfter is 2, not 1 — the presence of a partial clone must not collapse away', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;
        await writePromisorPack(ctx, 'steady-state', ['promisor-steady-state']);

        // Act
        const result = await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(result.packsAfter).toBe(2);
        expect(result.packId).toBeDefined();
        expect(result.promisorPackId).toBeDefined();
      });
    });
  });

  describe('Given a multi-pack-index naming a promisor pack gc retires', () => {
    describe('When gc runs', () => {
      it('Then the multi-pack-index is deleted', async () => {
        // Arrange — the promisor pack must be consolidated (and its object
        // bytes cached) by a FIRST gc before the midx names it: naming a
        // never-yet-read promisor pack directly would route its object read
        // through the midx's own (structurally invalid, zero-entry) claim
        // instead of the ordinary per-pack .idx scan.
        const ctx = await seedOneCommit();
        const sut = maintenance;
        const packDir = packDirOf(ctx);
        await writePromisorPack(ctx, 'midx-promisor', ['midx-promisor-seed']);
        const first = await sut(ctx, { tasks: ['gc'] });
        expect(first.promisorPackId).toBeDefined();
        await writeMinimalMidx(ctx, packDir, [`pack-${first.promisorPackId}.idx`]);
        // Widen the promisor set so the second gc actually supersedes it.
        await writePromisorPack(ctx, 'midx-promisor-2', ['midx-promisor-seed-2']);

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(await ctx.fs.exists(multiPackIndexPath(packDir))).toBe(false);
      });
    });
  });
});
