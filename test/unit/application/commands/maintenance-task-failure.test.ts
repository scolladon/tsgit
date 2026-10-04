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
import {
  commitGraphChainPath,
  commitGraphLayersDir,
  commonGitDir,
} from '../../../../src/application/primitives/path-layout.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';

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
        expect(result.tasksFailed).toEqual([{ task: 'commit-graph', code: 'FILE_EXISTS' }]);
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
        expect(result.tasksFailed).toEqual([{ task: 'commit-graph', code: 'FILE_EXISTS' }]);
        expect(result.tasksRun).toEqual(['gc']);
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
        it("Then it logs what git does and refuses with git's walk refusal", async () => {
          // Arrange
          const repo = await corruptRepo();
          const tip = await corrupt(repo);
          const sut = maintenance;

          // Act
          const caught = await sut(repo.ctx, { tasks: ['gc'] }).then(
            () => undefined,
            (error: unknown) => error,
          );

          // Assert
          expect({ data: (caught as TsgitError).data, logged: repo.logged }).toEqual(
            expectedFor(repo, tip),
          );
        });
      });
    });
  });
});
