/**
 * `git maintenance run` reports a task that fails — `error: task '<name>'
 * failed` — runs the tasks after it, and exits 1 rather than dying.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { maintenance } from '../../../../src/application/commands/maintenance.js';
import { forgetLooseOidPrefix } from '../../../../src/application/primitives/internal/loose-oid-cache.js';
import {
  commitGraphChainPath,
  commitGraphLayersDir,
  commonGitDir,
  looseObjectPath,
  packsDir,
} from '../../../../src/application/primitives/path-layout.js';
import * as readObjectMod from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { errorDataCode } from '../../../../src/domain/error-data-code.js';
import type { FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';
import { writeSelfHashedLooseWithDeclaredSize } from '../primitives/fixtures.js';

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const repoWithLayersDirAsFile = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'hello');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'seed', author: AUTHOR });
  await ctx.fs.writeUtf8(commitGraphLayersDir(commonGitDir(ctx)), 'x\n');
  return ctx;
};

describe('maintenance task failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given info/commit-graphs is a file', () => {
    describe('When the commit-graph task runs', () => {
      it('Then the task is reported failed with the refusal it met', async () => {
        // Arrange
        const ctx = await repoWithLayersDirAsFile();
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['commit-graph'] });

        // Assert
        expect(result.tasksFailed).toEqual([
          {
            task: 'commit-graph',
            code: 'FILE_EXISTS',
            data: { code: 'FILE_EXISTS', path: commitGraphLayersDir(commonGitDir(ctx)) },
          },
        ]);
        expect(result.tasksRun).toEqual([]);
        expect(result.commitGraphWritten).toBe(false);
      });
    });

    describe('When the commit-graph task runs before gc', () => {
      it('Then gc still runs after the failed task', async () => {
        // Arrange
        const ctx = await repoWithLayersDirAsFile();
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['commit-graph', 'gc'] });

        // Assert
        expect(result.tasksFailed).toEqual([
          {
            task: 'commit-graph',
            code: 'FILE_EXISTS',
            data: { code: 'FILE_EXISTS', path: commitGraphLayersDir(commonGitDir(ctx)) },
          },
        ]);
        expect(result.tasksRun).toEqual(['gc']);
      });
    });
  });

  describe('Given a malformed core.deltaBaseCacheLimit', () => {
    describe('When the gc task runs', () => {
      it('Then maintenance itself refuses, as git dies before running the task', async () => {
        // Arrange
        const ctx = await repoWithLayersDirAsFile();
        await ctx.fs.appendUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n\tdeltaBaseCacheLimit = bogus\n',
        );
        const sut = maintenance;

        // Act
        const caught = await sut(ctx, { tasks: ['gc'] }).then(
          () => undefined,
          (error: unknown) => error,
        );

        // Assert
        expect((caught as { data?: unknown }).data).toMatchObject({
          code: 'CONFIG_BAD_NUMERIC_VALUE',
          key: 'core.deltabasecachelimit',
          value: 'bogus',
        });
      });
    });
  });

  describe('Given reading the chain fails outside the error model', () => {
    describe('When the commit-graph task runs', () => {
      it('Then the fault propagates rather than failing the task', async () => {
        // Arrange
        const ctx = await repoWithLayersDirAsFile();
        await ctx.fs.rm(commitGraphLayersDir(commonGitDir(ctx)));
        const fault = new Error('unexpected');
        const original = ctx.fs.tryReadUtf8;
        if (original === undefined) throw new Error('memory fs reads without a probe');
        const read = original.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'tryReadUtf8').mockImplementation((path) =>
          path === commitGraphChainPath(commonGitDir(ctx)) ? Promise.reject(fault) : read(path),
        );
        const sut = maintenance;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: ['commit-graph'] });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(fault);
      });
    });
  });

  describe('gc over a history git cannot walk', () => {
    const MISSING = `cd${'0'.repeat(38)}` as ObjectId;

    interface Corrupt {
      readonly ctx: Context;
      readonly logged: string[];
      readonly blob: ObjectId;
      readonly empty: ObjectId;
    }

    const corruptRepo = async (): Promise<Corrupt> => {
      const logged: string[] = [];
      const base = createMemoryContext();
      const ctx: Context = { ...base, logger: { error: (line: string) => logged.push(line) } };
      await init(ctx);
      const content = new TextEncoder().encode('hi\n');
      const blob = await writeObject(ctx, { type: 'blob', id: '' as ObjectId, content });
      const empty = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
      return { ctx, logged, blob, empty };
    };

    const commitNaming = async (
      ctx: Context,
      tree: ObjectId,
      parents: ReadonlyArray<ObjectId>,
    ): Promise<ObjectId> => {
      const id = await writeObject(ctx, {
        type: 'commit',
        id: '' as ObjectId,
        data: {
          tree,
          parents,
          author: AUTHOR,
          committer: AUTHOR,
          message: 'm\n',
          extraHeaders: [],
        },
      });
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${id}\n`);
      return id;
    };

    const subtreeNaming = (ctx: Context, blob: ObjectId): Promise<ObjectId> =>
      writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry('40000' as FileMode, 'sub', blob)],
      });

    describe.each([
      [
        'a tree listing a blob as a subtree',
        async ({ ctx, blob }: Corrupt) => commitNaming(ctx, await subtreeNaming(ctx, blob), []),
        ({ blob }: Corrupt) => ({
          data: { code: 'BAD_TREE_OBJECT', id: blob },
          logged: [`Object ${blob} not a tree`],
        }),
      ],
      [
        'a commit naming a blob as its tree',
        ({ ctx, blob }: Corrupt) => commitNaming(ctx, blob, []),
        ({ blob }: Corrupt) => ({
          data: { code: 'BAD_TREE_OBJECT', id: blob },
          logged: [`Object ${blob} not a tree`],
        }),
      ],
      [
        'a commit naming a blob as its parent',
        ({ ctx, blob, empty }: Corrupt) => commitNaming(ctx, empty, [blob]),
        ({ blob }: Corrupt, tip: ObjectId) => ({
          data: { code: 'REVISION_WALK_FAILED', commit: tip },
          logged: [`Object ${blob} not a commit`],
        }),
      ],
      [
        'a commit naming a parent the store lacks',
        ({ ctx, empty }: Corrupt) => commitNaming(ctx, empty, [MISSING]),
        (_repo: Corrupt, tip: ObjectId) => ({
          data: { code: 'REVISION_WALK_FAILED', commit: tip },
          logged: [`Could not read ${MISSING}`],
        }),
      ],
    ] as const)('Given %s', (_label, corrupt, expectedFor) => {
      describe('When the gc task runs', () => {
        it("Then it logs what git does and the task fails with git's walk refusal", async () => {
          // Arrange
          const repo = await corruptRepo();
          const tip = await corrupt(repo);
          const sut = maintenance;

          // Act
          const result = await sut(repo.ctx, { tasks: ['gc'] });

          // Assert
          const { data, logged } = expectedFor(repo, tip);
          expect({
            tasksFailed: result.tasksFailed,
            tasksRun: result.tasksRun,
            logged: repo.logged,
          }).toEqual({
            tasksFailed: [{ task: 'gc', code: data.code, data }],
            tasksRun: [],
            logged,
          });
        });
      });
    });

    describe('Given a commit naming a blob as its tree', () => {
      describe('When the gc task fails before the commit-graph task', () => {
        it('Then the commit-graph task still runs', async () => {
          // Arrange
          const repo = await corruptRepo();
          await commitNaming(repo.ctx, repo.blob, []);
          const sut = maintenance;

          // Act
          const result = await sut(repo.ctx, { tasks: ['gc', 'commit-graph'] });

          // Assert
          expect({
            tasksFailed: result.tasksFailed,
            tasksRun: result.tasksRun,
            commitGraphWritten: result.commitGraphWritten,
          }).toEqual({
            tasksFailed: [
              {
                task: 'gc',
                code: 'BAD_TREE_OBJECT',
                data: { code: 'BAD_TREE_OBJECT', id: repo.blob },
              },
            ],
            tasksRun: ['commit-graph'],
            commitGraphWritten: true,
          });
        });
      });
    });
  });

  describe('gc over a size-lying loose blob', () => {
    const OVERRUN_BODY = new Uint8Array(200).fill(0x61);
    const DECLARED_SIZE = 5;
    const PACK_ARTIFACT = /\.(pack|idx|mtimes)$/;

    interface Liar {
      readonly ctx: Context;
      readonly liarId: ObjectId;
    }

    const liarRepo = async (reachable: boolean): Promise<Liar> => {
      const ctx = createMemoryContext();
      await init(ctx);
      const liarId = await writeSelfHashedLooseWithDeclaredSize(
        ctx,
        'blob',
        DECLARED_SIZE,
        OVERRUN_BODY,
      );
      const hello = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: new TextEncoder().encode('hello'),
      });
      const entries = [
        treeEntry('100644' as FileMode, 'a.txt', hello),
        ...(reachable ? [treeEntry('100644' as FileMode, 'liar.bin', liarId)] : []),
      ];
      const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries });
      const id = await writeObject(ctx, {
        type: 'commit',
        id: '' as ObjectId,
        data: {
          tree,
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'm\n',
          extraHeaders: [],
        },
      });
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${id}\n`);
      return { ctx, liarId };
    };

    const advanceMainWithBlob = async (ctx: Context, text: string): Promise<void> => {
      const blob = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: new TextEncoder().encode(text),
      });
      const tree = await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry('100644' as FileMode, 'b.txt', blob)],
      });
      const id = await writeObject(ctx, {
        type: 'commit',
        id: '' as ObjectId,
        data: {
          tree,
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'n\n',
          extraHeaders: [],
        },
      });
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${id}\n`);
    };

    const packDirNames = async (ctx: Context): Promise<ReadonlyArray<string>> => {
      try {
        const entries = await ctx.fs.readdir(packsDir(commonGitDir(ctx)));
        return entries
          .map((entry) => entry.name)
          .filter((name) => PACK_ARTIFACT.test(name))
          .sort();
      } catch (error) {
        if (errorDataCode(error) === 'FILE_NOT_FOUND') return [];
        throw error;
      }
    };

    const liarRefusal = (liarId: ObjectId) => [
      {
        task: 'gc',
        code: 'LOOSE_OBJECT_CORRUPT',
        data: { code: 'LOOSE_OBJECT_CORRUPT', id: liarId },
      },
    ];

    describe('Given a reachable liar', () => {
      describe('When the gc task runs', () => {
        it('Then the task fails, no pack is written and the liar is untouched', async () => {
          // Arrange
          const { ctx, liarId } = await liarRepo(true);
          const before = await ctx.fs.read(looseObjectPath(commonGitDir(ctx), liarId));
          const sut = maintenance;

          // Act
          const result = await sut(ctx, { tasks: ['gc'] });

          // Assert
          expect({
            tasksFailed: result.tasksFailed,
            tasksRun: result.tasksRun,
            census: await packDirNames(ctx),
            liar: await ctx.fs.read(looseObjectPath(commonGitDir(ctx), liarId)),
          }).toEqual({
            tasksFailed: liarRefusal(liarId),
            tasksRun: [],
            census: [],
            liar: before,
          });
        });
      });
    });

    describe('Given an unreachable unexpired liar and cruft packs on', () => {
      describe('When the gc task runs', () => {
        it('Then the task fails and no pack or mtimes sidecar is written', async () => {
          // Arrange
          const { ctx, liarId } = await liarRepo(false);
          const sut = maintenance;

          // Act
          const result = await sut(ctx, { tasks: ['gc'] });

          // Assert
          expect({
            tasksFailed: result.tasksFailed,
            census: await packDirNames(ctx),
          }).toEqual({ tasksFailed: liarRefusal(liarId), census: [] });
        });
      });
    });

    describe('Given an unreachable unexpired liar planted after a first gc', () => {
      describe('When the gc task runs again', () => {
        it('Then the task fails and the pack census is unchanged', async () => {
          // Arrange
          const { ctx, liarId } = await liarRepo(false);
          await ctx.fs.rm(looseObjectPath(commonGitDir(ctx), liarId));
          const sut = maintenance;
          await sut(ctx, { tasks: ['gc'] });
          await advanceMainWithBlob(ctx, 'more');
          await writeSelfHashedLooseWithDeclaredSize(ctx, 'blob', DECLARED_SIZE, OVERRUN_BODY);
          forgetLooseOidPrefix(ctx, liarId);
          const before = await packDirNames(ctx);

          // Act
          const result = await sut(ctx, { tasks: ['gc'] });

          // Assert
          expect({
            tasksFailed: result.tasksFailed,
            census: await packDirNames(ctx),
          }).toEqual({ tasksFailed: liarRefusal(liarId), census: before });
        });
      });
    });

    const appendConfig = async (ctx: Context, text: string): Promise<void> => {
      const path = `${ctx.layout.gitDir}/config`;
      await ctx.fs.writeUtf8(path, `${await ctx.fs.readUtf8(path)}${text}`);
    };

    const readsOf = (
      spy: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
      id: ObjectId,
    ) => spy.mock.calls.filter((call) => call[1] === id);

    describe('Given an unreachable unexpired liar and cruft packs off', () => {
      describe('When the gc task runs', () => {
        it('Then the liar stays loose, unread, with one pack written and no task failure', async () => {
          // Arrange
          const { ctx, liarId } = await liarRepo(false);
          await appendConfig(ctx, '\n[gc]\n\tcruftPacks = false\n');
          const before = await ctx.fs.read(looseObjectPath(commonGitDir(ctx), liarId));
          const readSpy = vi.spyOn(readObjectMod, 'readObject');
          const sut = maintenance;

          // Act
          const result = await sut(ctx, { tasks: ['gc'] });

          // Assert
          expect({
            tasksFailed: result.tasksFailed,
            ranGc: result.tasksRun.includes('gc'),
            liar: await ctx.fs.read(looseObjectPath(commonGitDir(ctx), liarId)),
            packs: (await packDirNames(ctx)).filter((name) => name.endsWith('.pack')).length,
            liarReads: readsOf(readSpy, liarId).length,
          }).toEqual({ tasksFailed: [], ranGc: true, liar: before, packs: 1, liarReads: 0 });
        });
      });
    });

    describe('Given an unreachable expired liar', () => {
      describe('When the gc task runs', () => {
        it('Then the liar is pruned without being read', async () => {
          // Arrange
          const { ctx, liarId } = await liarRepo(false);
          await appendConfig(ctx, '\n[gc]\n\tpruneExpire = now\n');
          const readSpy = vi.spyOn(readObjectMod, 'readObject');
          const sut = maintenance;

          // Act
          const result = await sut(ctx, { tasks: ['gc'] });

          // Assert
          expect({
            tasksFailed: result.tasksFailed,
            liarExists: await ctx.fs.exists(looseObjectPath(commonGitDir(ctx), liarId)),
            liarReads: readsOf(readSpy, liarId).length,
          }).toEqual({ tasksFailed: [], liarExists: false, liarReads: 0 });
        });
      });
    });
  });
});
