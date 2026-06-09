import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  type CommandRunnerOps,
  NodeCommandRunner,
} from '../../../../src/adapters/node/node-command-runner.js';
import type { CommandRequest } from '../../../../src/ports/command-runner.js';

/** Controllable fake child — the test drives its `error` / `close` events. */
class FakeChild extends EventEmitter {
  killed = false;
  kill(): void {
    this.killed = true;
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: 'ignore';
}

const makeHarness = (
  platform: NodeJS.Platform = 'linux',
): { runner: NodeCommandRunner; child: FakeChild; calls: SpawnCall[] } => {
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const ops: CommandRunnerOps = {
    spawn: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env, stdio: options.stdio });
      return child;
    },
  };
  return { runner: new NodeCommandRunner(platform, ops), child, calls };
};

const baseRequest = (over: Partial<CommandRequest> = {}): CommandRequest => ({
  command: 'merge a b',
  cwd: '/repo',
  env: { GIT_DIR: '/repo/.git' },
  ...over,
});

describe('NodeCommandRunner', () => {
  describe('Given a command that exits cleanly', () => {
    describe('When run', () => {
      it('Then resolves with exit code 0 and spawns via `sh -c` with merged env', async () => {
        // Arrange
        const { runner, child, calls } = makeHarness();

        // Act
        const promise = runner.run(baseRequest());
        child.emit('close', 0);
        const sut = await promise;

        // Assert
        expect(sut).toEqual({ exitCode: 0 });
        expect(calls[0]?.command).toBe('sh');
        expect(calls[0]?.args).toEqual(['-c', 'merge a b']);
        expect(calls[0]?.cwd).toBe('/repo');
        expect(calls[0]?.stdio).toBe('ignore');
        expect(calls[0]?.env.GIT_DIR).toBe('/repo/.git');
        expect(calls[0]?.env.PATH).toBe(process.env.PATH);
      });
    });
  });

  describe('Given a command that exits non-zero', () => {
    describe('When run', () => {
      it('Then resolves with that exit code', async () => {
        // Arrange
        const { runner, child } = makeHarness();

        // Act
        const promise = runner.run(baseRequest());
        child.emit('close', 2);
        const sut = await promise;

        // Assert
        expect(sut).toEqual({ exitCode: 2 });
      });
    });
  });

  describe('Given a command killed by a signal (close code null)', () => {
    describe('When run', () => {
      it('Then resolves with the signal-killed exit code 128', async () => {
        // Arrange
        const { runner, child } = makeHarness();

        // Act
        const promise = runner.run(baseRequest());
        child.emit('close', null);
        const sut = await promise;

        // Assert
        expect(sut).toEqual({ exitCode: 128 });
      });
    });
  });

  describe('Given a spawn that errors', () => {
    describe('When run', () => {
      it('Then resolves with the spawn-error exit code 127', async () => {
        // Arrange
        const { runner, child } = makeHarness();

        // Act
        const promise = runner.run(baseRequest());
        child.emit('error', new Error('ENOENT'));
        const sut = await promise;

        // Assert
        expect(sut).toEqual({ exitCode: 127 });
      });
    });
  });

  describe('Given the win32 platform', () => {
    describe('When run', () => {
      it('Then spawns via `cmd /c`', async () => {
        // Arrange
        const { runner, child, calls } = makeHarness('win32');

        // Act
        const promise = runner.run(baseRequest());
        child.emit('close', 0);
        await promise;

        // Assert
        expect(calls[0]?.command).toBe('cmd');
        expect(calls[0]?.args).toEqual(['/c', 'merge a b']);
      });
    });
  });

  describe('Given an abort signal triggered mid-run', () => {
    describe('When the signal aborts', () => {
      it('Then the child is killed', async () => {
        // Arrange
        const controller = new AbortController();
        const { runner, child } = makeHarness();

        // Act
        const promise = runner.run(baseRequest({ signal: controller.signal }));
        controller.abort();
        child.emit('close', null);
        await promise;

        // Assert
        expect(child.killed).toBe(true);
      });
    });
  });

  describe('Given an already-aborted signal', () => {
    describe('When run', () => {
      it('Then the child is killed immediately', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const { runner, child } = makeHarness();

        // Act
        const promise = runner.run(baseRequest({ signal: controller.signal }));
        child.emit('close', null);
        await promise;

        // Assert
        expect(child.killed).toBe(true);
      });
    });
  });

  describe('Given construction with default arguments', () => {
    describe('When instantiated without explicit platform or ops', () => {
      it('Then a runner is produced (defaults bind without spawning)', () => {
        // Arrange + Act
        const sut = new NodeCommandRunner();

        // Assert
        expect(sut).toBeInstanceOf(NodeCommandRunner);
      });
    });
  });
});
