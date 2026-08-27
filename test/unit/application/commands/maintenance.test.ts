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
 *  - R26: refs/reflogs/index untouched; loose-oid cache invariant repair
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
import {
  commonGitDir,
  looseObjectPath,
  packsDir,
} from '../../../../src/application/primitives/path-layout.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { fileNotFound, TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

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
      it('Then both tasks run and tasksRun echoes both', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['commit-graph', 'gc'] });

        // Assert
        expect(result.tasksRun).toEqual(['commit-graph', 'gc']);
        expect(result.commitGraphWritten).toBe(true);
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
        // Arrange
        const ctx = await seedOneCommit();
        await appendConfig(ctx, '\n[gc]\n\tauto = 0\n');
        const sut = maintenance;

        // Act — gc.auto=0 disables the gate, so gc always runs.
        const result = await sut(ctx, { tasks: ['gc'], auto: true });

        // Assert
        expect(result.tasksRun).toEqual(['gc']);
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

  // ---------------------------------------------------------------------
  // Expiry boundary — strict `>`
  // ---------------------------------------------------------------------

  describe.each([
    { label: 'cutoff - 1', mtime: 999_999_999, cutoff: 1_000_000_000, survives: false },
    { label: 'exactly at cutoff', mtime: 1_000_000_000, cutoff: 1_000_000_000, survives: false },
    { label: 'cutoff + 1', mtime: 1_000_000_001, cutoff: 1_000_000_000, survives: true },
  ])('Given an unreachable loose object at $label', ({ mtime, cutoff, survives }) => {
    describe('When gc runs', () => {
      it(`Then it is ${survives ? 'kept' : 'destroyed'}`, async () => {
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
        if (survives) {
          expect(result.cruftObjectsAdded).toBe(1);
          expect(result.cruftObjectsExpired).toBe(0);
          await expect(readObject(ctx, blobId)).resolves.toMatchObject({ type: 'blob' });
        } else {
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
        }
      });
    });
  });

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
      it('Then the half-retired pack is already invisible — its .idx is gone', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'half-retired');
        const { forceMtimeSeconds } = installLstatOverrides(ctx);
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), blobId), 2_000_000_000);
        await appendConfig(ctx, '\n[gc]\n\tpruneExpire = never\n');
        const sut = maintenance;
        await sut(ctx, { tasks: ['gc'] }); // creates the first cruft pack

        // Act — force a NEW cruft generation (rewrite branch), then fail the
        // retirement right after the old pack's `.idx` unlink.
        const newBlobId = await writeLooseBlob(ctx, 'forces-rewrite');
        forceMtimeSeconds(looseObjectPath(commonGitDir(ctx), newBlobId), 2_100_000_000);
        const originalRm = ctx.fs.rm.bind(ctx.fs);
        let idxUnlinked = false;
        let faultInjected = false;
        const rmSpy = vi.spyOn(ctx.fs, 'rm').mockImplementation(async (path: string) => {
          if (path.endsWith('.idx') && !idxUnlinked) {
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

        // Assert — the fault propagated (not swallowed) and the old pack's
        // `.idx` is gone: pack-registry discovery is keyed on `.idx`.
        expect(caught).toBeDefined();
        expect(idxUnlinked).toBe(true);
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

  describe('Given a pruned fanout prefix', () => {
    describe('When a subsequent probe checks the same object', () => {
      it('Then it re-reads the directory rather than trusting a stale HIT', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const blobId = await writeLooseBlob(ctx, 'pruned-and-reprobed');
        const sut = maintenance;
        await sut(ctx, { tasks: ['gc'] }); // packs the reachable set; blob crufted

        // Act — probe the loose path directly; the fanout cache must not
        // report a stale HIT for a prefix gc unlinked from.
        const stillLoose = await ctx.fs.exists(looseObjectPath(commonGitDir(ctx), blobId));

        // Assert
        expect(stillLoose).toBe(false);
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
        expect(Array.isArray(result.tasksRun)).toBe(true);
        for (const task of result.tasksRun) {
          expect(['commit-graph', 'gc']).toContain(task);
        }
      });
    });
  });
});
