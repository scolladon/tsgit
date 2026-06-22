import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  type CommandRunnerOps,
  NodeCommandRunner,
} from '../../../../src/adapters/node/node-command-runner.js';
import type { CommandRequest } from '../../../../src/ports/command-runner.js';

/** Writable side of the fake child stdin — records written bytes and end() calls. */
class FakeStdin {
  readonly chunks: Uint8Array[] = [];
  ended = false;
  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  end(): void {
    this.ended = true;
  }
}

/** Readable side of the fake child stdout — an EventEmitter emitting `data` events. */
class FakeStdout extends EventEmitter {}

/** Controllable fake child — the test drives its `error` / `close` events. */
class FakeChild extends EventEmitter {
  killed = false;
  readonly stdin = new FakeStdin();
  readonly stdout = new FakeStdout();
  kill(): void {
    this.killed = true;
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: ['pipe', 'pipe', 'inherit'];
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
        expect(sut.exitCode).toBe(0);
        expect(calls[0]?.command).toBe('sh');
        expect(calls[0]?.args).toEqual(['-c', 'merge a b']);
        expect(calls[0]?.cwd).toBe('/repo');
        expect(calls[0]?.stdio).toEqual(['pipe', 'pipe', 'inherit']);
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
        expect(sut.exitCode).toBe(2);
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
        expect(sut.exitCode).toBe(128);
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
        expect(sut.exitCode).toBe(127);
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

  describe('Given a request with stdin bytes', () => {
    describe('When run', () => {
      it('Then writes stdin bytes to the child and captures stdout as result.stdout', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        const inputBytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
        const outputBytes = new Uint8Array([72, 69, 76, 76, 79]); // "HELLO"

        // Act
        const promise = runner.run(baseRequest({ stdin: inputBytes }));
        child.stdout.emit('data', outputBytes);
        child.emit('close', 0);
        const result = await promise;

        // Assert
        expect(result.exitCode).toBe(0);
        expect(child.stdin.chunks).toEqual([inputBytes]);
        expect(child.stdin.ended).toBe(true);
        expect(result.stdout).toEqual(outputBytes);
      });
    });
  });

  describe('Given a request without stdin bytes', () => {
    describe('When run', () => {
      it('Then resolves on exitCode alone with stdout undefined (merge-caller shape)', async () => {
        // Arrange
        const { runner, child } = makeHarness();

        // Act
        const promise = runner.run(baseRequest());
        child.emit('close', 0);
        const result = await promise;

        // Assert
        expect(result.exitCode).toBe(0);
        expect(child.stdin.chunks).toHaveLength(0);
        expect(child.stdin.ended).toBe(false);
        expect(result.stdout).toBeUndefined();
      });
    });
  });

  describe('Given multiple stdout data chunks', () => {
    describe('When run', () => {
      it('Then concatenates all chunks into result.stdout', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        const chunk1 = new Uint8Array([1, 2, 3]);
        const chunk2 = new Uint8Array([4, 5, 6]);
        const inputBytes = new Uint8Array([99]);

        // Act
        const promise = runner.run(baseRequest({ stdin: inputBytes }));
        child.stdout.emit('data', chunk1);
        child.stdout.emit('data', chunk2);
        child.emit('close', 0);
        const result = await promise;

        // Assert
        expect(result.stdout).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
      });
    });
  });
});
