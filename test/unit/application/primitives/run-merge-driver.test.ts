import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryCommandRunner } from '../../../../src/adapters/memory/memory-command-runner.js';
import { runMergeDriver } from '../../../../src/application/primitives/run-merge-driver.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import type { CommandRequest } from '../../../../src/ports/command-runner.js';
import type { Context } from '../../../../src/ports/context.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const baseInput = {
  command: '%O %A %B',
  base: enc('BASE'),
  ours: enc('OURS'),
  theirs: enc('THEIRS'),
  path: 'f.txt' as FilePath,
  markerSize: 7,
  labels: { ours: 'HEAD', theirs: 'feature', base: 'main' },
};

/** Driver that copies the `%O` file onto the `%A` output and exits 0. */
const copyBaseToOutput =
  (ctx: Context) =>
  async (req: CommandRequest): Promise<number> => {
    const [o, a] = req.command.split(' ');
    await ctx.fs.write(a as string, await ctx.fs.read(o as string));
    return 0;
  };

describe('runMergeDriver', () => {
  describe('Given a driver that exits 0', () => {
    describe('When run', () => {
      it('Then the merge is clean with the output-file bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const runner = new MemoryCommandRunner(copyBaseToOutput(ctx));

        // Act
        const sut = await runMergeDriver(ctx, runner, baseInput);

        // Assert
        expect(sut.status).toBe('clean');
        expect(sut.status === 'clean' && dec(sut.bytes)).toBe('BASE');
      });
    });
  });

  describe('Given a command using the marker-size and label placeholders', () => {
    describe('When run', () => {
      it('Then %L %S %X %Y are substituted from markerSize and labels', async () => {
        // Arrange
        const ctx = createMemoryContext();
        let captured = '';
        const runner = new MemoryCommandRunner(async (req) => {
          captured = req.command;
          const a = req.command.split(' ')[0] as string;
          await ctx.fs.write(a, enc('x'));
          return 0;
        });

        // Act
        await runMergeDriver(ctx, runner, {
          ...baseInput,
          command: '%A | %L | %S | %X | %Y',
          markerSize: 15,
          labels: { ours: 'HEAD', theirs: '2c77705 (s)', base: 'parent of 2c77705 (s)' },
        });

        // Assert
        expect(captured.endsWith(' | 15 | parent of 2c77705 (s) | HEAD | 2c77705 (s)')).toBe(true);
      });
    });
  });

  describe('Given a driver that exits non-zero', () => {
    describe('When run', () => {
      it('Then the merge is a content conflict carrying the output bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const runner = new MemoryCommandRunner(async (req) => {
          const a = req.command.split(' ')[1] as string;
          await ctx.fs.write(a, enc('<<< markers'));
          return 1;
        });

        // Act
        const sut = await runMergeDriver(ctx, runner, baseInput);

        // Assert
        expect(sut.status).toBe('conflict');
        expect(sut.status === 'conflict' && sut.conflictType).toBe('content');
        expect(sut.status === 'conflict' && dec(sut.markedBytes)).toBe('<<< markers');
      });
    });
  });

  describe('Given an add/add merge (no base)', () => {
    describe('When run', () => {
      it('Then the `%O` file is written empty', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const runner = new MemoryCommandRunner(copyBaseToOutput(ctx));

        // Act
        const sut = await runMergeDriver(ctx, runner, { ...baseInput, base: undefined });

        // Assert — the copied `%O` content is empty
        expect(sut.status === 'clean' && dec(sut.bytes)).toBe('');
      });
    });
  });

  describe('Given a completed driver run', () => {
    describe('When it finishes', () => {
      it('Then the temp files are removed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const runner = new MemoryCommandRunner(copyBaseToOutput(ctx));

        // Act
        await runMergeDriver(ctx, runner, baseInput);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_DRIVER_O`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_DRIVER_A`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_DRIVER_B`)).toBe(false);
      });
    });
  });

  describe('Given the substituted command', () => {
    describe('When the driver runs', () => {
      it('Then it runs with cwd at the work tree and GIT_DIR in the env', async () => {
        // Arrange — a no-op driver (output file keeps its seeded `ours` bytes)
        const ctx = createMemoryContext();
        const runner = new MemoryCommandRunner();

        // Act
        await runMergeDriver(ctx, runner, { ...baseInput, command: 'tool %P %L' });

        // Assert
        expect(runner.calls[0]?.cwd).toBe(ctx.layout.workDir);
        expect(runner.calls[0]?.env.GIT_DIR).toBe(ctx.layout.gitDir);
        expect(runner.calls[0]?.command).toBe('tool f.txt 7');
      });
    });
  });

  describe('Given a context with an abort signal', () => {
    describe('When the driver runs', () => {
      it('Then the signal is forwarded to the runner', async () => {
        // Arrange
        const controller = new AbortController();
        const ctx = createMemoryContext({ signal: controller.signal });
        const runner = new MemoryCommandRunner(copyBaseToOutput(ctx));

        // Act
        await runMergeDriver(ctx, runner, baseInput);

        // Assert
        expect(runner.calls[0]?.signal).toBe(controller.signal);
      });
    });
  });

  describe('Given a context without an abort signal', () => {
    describe('When the driver runs', () => {
      it('Then no signal is set on the request', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const runner = new MemoryCommandRunner(copyBaseToOutput(ctx));

        // Act
        await runMergeDriver(ctx, runner, baseInput);

        // Assert — the request omits the `signal` key entirely (conditional
        // spread), not a present `signal: undefined`.
        const request = runner.calls[0];
        expect(request).toBeDefined();
        expect(request !== undefined && 'signal' in request).toBe(false);
      });
    });
  });
});
