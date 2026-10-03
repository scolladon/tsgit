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
        expect(result.tasksFailed).toEqual([{ task: 'commit-graph', code: 'NOT_A_DIRECTORY' }]);
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
        expect(result.tasksFailed).toEqual([{ task: 'commit-graph', code: 'NOT_A_DIRECTORY' }]);
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
});
