/**
 * Unit tests for the Tier-1 `maintenance` command — explicit-only
 * invocation of the `commit-graph` task over Part 22's writer.
 *
 * Coverage:
 *  - refusal: empty `tasks`
 *  - refusal: an unknown task, offending value carried in the reason
 *  - success: graph written, commitsInGraph and tasksRun echo the run
 *  - "ran and found nothing": no commits still reports the task ran
 *  - structural: every result field is a count, boolean or enum — no
 *    rendered text
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  type MaintenanceTask,
  maintenance,
} from '../../../../src/application/commands/maintenance.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedOneCommit = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'hello');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'seed', author: AUTHOR });
  return ctx;
};

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

  describe('Given a successful maintenance result', () => {
    describe('When every field is inspected', () => {
      it('Then it carries no rendered text — only counts, booleans and enums', async () => {
        // Arrange
        const ctx = await seedOneCommit();
        const sut = maintenance;

        // Act
        const result = await sut(ctx, { tasks: ['commit-graph'] });

        // Assert
        expect(Object.keys(result).sort()).toEqual(
          ['commitGraphWritten', 'commitsInGraph', 'tasksRun'].sort(),
        );
        expect(typeof result.commitGraphWritten).toBe('boolean');
        expect(typeof result.commitsInGraph).toBe('number');
        expect(Array.isArray(result.tasksRun)).toBe(true);
        for (const task of result.tasksRun) {
          expect(task).toBe('commit-graph');
        }
      });
    });
  });
});
