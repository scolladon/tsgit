import { EventEmitter } from 'node:events';
import { expectTypeOf } from 'expect-type';
import { describe, expect, it } from 'vitest';

import {
  type CommandRunnerOps,
  NodeCommandRunner,
} from '../../../../src/adapters/node/node-command-runner.js';
import type { CommandRequest, CommandRunner } from '../../../../src/ports/command-runner.js';

/**
 * Writable side of the fake child stdin — records written bytes and end() calls.
 * Extends `EventEmitter` so the test can drive an `error` event exactly as Node
 * does: emitting `error` with no listener attached throws, which is precisely
 * how a broken pipe escalates to an unhandled exception in production.
 */
class FakeStdin extends EventEmitter {
  readonly chunks: Uint8Array[] = [];
  ended = false;
  failure: Error | undefined;
  write(chunk: Uint8Array, done?: (error?: Error | null) => void): void {
    this.chunks.push(chunk);
    done?.(this.failure);
  }
  end(): void {
    this.ended = true;
  }
}

/** The buffered-output bound past which the runner pauses the child's stdout (1 MiB). */
const OUTPUT_HIGH_WATER_MARK = 1024 * 1024;

/** Build a stream error carrying `code`, mirroring Node's `ErrnoException`. */
const streamError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`write ${code}`), { code });

/** Readable side of the fake child stdout — emits `data` events and records flow control. */
class FakeStdout extends EventEmitter {
  readonly flow: Array<'pause' | 'resume'> = [];
  pause(): void {
    this.flow.push('pause');
  }
  resume(): void {
    this.flow.push('resume');
  }
}

/** Controllable fake child — the test drives its `error` / `close` events. */
class FakeChild extends EventEmitter {
  killed = false;
  readonly stdin = new FakeStdin();
  readonly stdout = new FakeStdout();
  stderr: FakeStdout | null = null;
  readonly pipedStderr = new FakeStdout();
  kill(): void {
    this.killed = true;
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: ['pipe', 'pipe', 'inherit' | 'pipe'];
}

type SpawnOptions = Omit<SpawnCall, 'command' | 'args'>;

/** The host a Windows runner searches: its environment and the files that exist. */
interface HostFixture {
  readonly env: NodeJS.ProcessEnv;
  readonly files: ReadonlyArray<string>;
}

const WINDOWS_INTERPRETER = 'C:\\Windows\\system32\\cmd.exe';
const WINDOWS_PROCESS_CWD = 'C:\\work';
/** The variable that keeps cmd.exe from searching its working directory for a program. */
const NO_CWD_PROGRAM_SEARCH = 'NoDefaultCurrentDirectoryInExePath';

const windowsHost = (files: ReadonlyArray<string> = []): HostFixture => ({
  env: { PATH: 'C:\\gnupg', ComSpec: WINDOWS_INTERPRETER },
  files,
});

const makeHarness = (
  platform: NodeJS.Platform = 'linux',
  host: HostFixture = { env: process.env, files: [] },
): { runner: NodeCommandRunner; child: FakeChild; calls: SpawnCall[] } => {
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const ops: CommandRunnerOps = {
    spawn: (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env, stdio: options.stdio });
      child.stderr = options.stdio[2] === 'pipe' ? child.pipedStderr : null;
      return child;
    },
    env: host.env,
    cwd: () => WINDOWS_PROCESS_CWD,
    isFile: (path) => host.files.includes(path),
  };
  return { runner: new NodeCommandRunner(platform, ops), child, calls };
};

/** Every byte a conversation's output yields, in order. */
const collect = async (output: AsyncIterable<Uint8Array>): Promise<number[]> => {
  const bytes: number[] = [];
  for await (const chunk of output) bytes.push(...chunk);
  return bytes;
};

/** A runner whose spawn throws at once, as Node does for a `.bat`/`.cmd` program run without a shell. */
const throwingRunner = (): NodeCommandRunner =>
  new NodeCommandRunner('win32', {
    spawn: () => {
      throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
    },
    env: { PATH: 'C:\\tools' },
    cwd: () => WINDOWS_PROCESS_CWD,
    isFile: () => true,
  });

/** A Windows runner whose file probe throws `failure`, recording any spawn it makes. */
const probeFailingRunner = (failure: Error): { runner: NodeCommandRunner; spawned: string[] } => {
  const spawned: string[] = [];
  const runner = new NodeCommandRunner('win32', {
    spawn: (command: string) => {
      spawned.push(command);
      return new FakeChild();
    },
    env: { PATH: 'C:\\tools' },
    cwd: () => WINDOWS_PROCESS_CWD,
    isFile: () => {
      throw failure;
    },
  });
  return { runner, spawned };
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
        const result = await promise;

        // Assert
        expect(result.exitCode).toBe(0);
        expect(calls[0]?.command).toBe('sh');
        expect(calls[0]?.args).toEqual(['-c', 'merge a b']);
        expect(calls[0]?.cwd).toBe('/repo');
        expect(calls[0]?.stdio).toEqual(['pipe', 'pipe', 'inherit']);
        expect(calls[0]?.env.GIT_DIR).toBe('/repo/.git');
        expect(calls[0]?.env.PATH).toBe(process.env.PATH);
      });
    });
  });

  describe('Given a command whose outcome is reported via exitCode', () => {
    describe('When run', () => {
      it.each([
        {
          emit: (c: FakeChild) => c.emit('close', 2),
          expectedExitCode: 2,
          label: 'a non-zero close code resolves with that exit code',
        },
        {
          emit: (c: FakeChild) => c.emit('close', null),
          expectedExitCode: 128,
          label: 'a null close code (signal-killed) resolves with exit code 128',
        },
        {
          emit: (c: FakeChild) => c.emit('error', new Error('ENOENT')),
          expectedExitCode: 127,
          label: 'a spawn error resolves with exit code 127',
        },
      ])('Then $label', async ({ emit, expectedExitCode }) => {
        // Arrange
        const { runner, child } = makeHarness();

        // Act
        const promise = runner.run(baseRequest());
        emit(child);
        const result = await promise;

        // Assert
        expect(result.exitCode).toBe(expectedExitCode);
      });
    });
  });

  describe('Given a program whose spawn throws synchronously', () => {
    describe('When run', () => {
      it('Then resolves with the spawn-error exit code instead of rejecting', async () => {
        // Arrange
        const runner = throwingRunner();
        const sut = runner.run.bind(runner);

        // Act
        const result = await sut(baseRequest({ command: 'signer.bat', args: [] }));

        // Assert
        expect(result).toEqual({ exitCode: 127 });
      });
    });

    describe('When run capturing stderr', () => {
      it('Then the spawn-error result carries empty stderr bytes', async () => {
        // Arrange
        const runner = throwingRunner();
        const sut = runner.run.bind(runner);

        // Act
        const result = await sut(
          baseRequest({ command: 'signer.bat', args: [], stderr: 'capture' }),
        );

        // Assert
        expect(result).toEqual({ exitCode: 127, stderr: new Uint8Array() });
      });
    });

    describe('When spawned for a conversation', () => {
      it('Then the write rejects with the spawn error, the output ends empty and close reports the spawn-error exit', async () => {
        // Arrange
        const runner = throwingRunner();
        const sut = runner.spawn;

        // Act
        const conversation = sut(baseRequest({ command: 'filter.cmd', args: [] }));
        const written = await conversation
          .write(new Uint8Array([1]))
          .catch((error: unknown) => error);
        const output = await collect(conversation.output);
        const exit = await conversation.close();

        // Assert
        expect((written as NodeJS.ErrnoException).code).toBe('EINVAL');
        expect(output).toEqual([]);
        expect(exit).toEqual({ exitCode: 127 });
      });
    });
  });

  describe('Given the win32 platform', () => {
    describe('When run', () => {
      it('Then spawns via the absolute ComSpec interpreter with `/c`', async () => {
        // Arrange
        const { runner, child, calls } = makeHarness('win32', windowsHost());

        // Act
        const promise = runner.run(baseRequest());
        child.emit('close', 0);
        await promise;

        // Assert
        expect(calls[0]?.command).toBe(WINDOWS_INTERPRETER);
        expect(calls[0]?.args).toEqual(['/c', 'merge a b']);
      });
    });
  });

  describe('Given the win32 platform and a request without arguments', () => {
    describe('When run', () => {
      it('Then the shell runs with the working-directory program search disabled, the caller environment kept', async () => {
        // Arrange
        const { runner, child, calls } = makeHarness('win32', windowsHost());
        const sut = runner.run.bind(runner);

        // Act
        const promise = sut(baseRequest());
        child.emit('close', 0);
        await promise;

        // Assert
        expect(calls[0]?.env[NO_CWD_PROGRAM_SEARCH]).toBe('1');
        expect(calls[0]?.env.GIT_DIR).toBe('/repo/.git');
        expect(calls[0]?.env.PATH).toBe('C:\\gnupg');
      });
    });

    describe('When spawned for a conversation', () => {
      it('Then the shell runs with the working-directory program search disabled', () => {
        // Arrange
        const { runner, calls } = makeHarness('win32', windowsHost());
        const sut = runner.spawn;

        // Act
        sut(baseRequest());

        // Assert
        expect(calls[0]?.env[NO_CWD_PROGRAM_SEARCH]).toBe('1');
      });
    });
  });

  describe('Given the win32 platform and a request naming its arguments', () => {
    describe('When run', () => {
      it('Then the environment is the caller environment alone', async () => {
        // Arrange
        const host = windowsHost(['C:\\gnupg\\gpg.exe']);
        const { runner, child, calls } = makeHarness('win32', host);
        const sut = runner.run.bind(runner);

        // Act
        const promise = sut(baseRequest({ command: 'gpg', args: ['--verify'] }));
        child.emit('close', 0);
        await promise;

        // Assert
        expect(calls[0]?.env).toEqual({ ...host.env, GIT_DIR: '/repo/.git' });
      });
    });
  });

  describe('Given a POSIX platform and a request without arguments', () => {
    describe('When run', () => {
      it('Then the environment is the caller environment alone', async () => {
        // Arrange
        const { runner, child, calls } = makeHarness();
        const sut = runner.run.bind(runner);

        // Act
        const promise = sut(baseRequest());
        child.emit('close', 0);
        await promise;

        // Assert
        expect(calls[0]?.env).toEqual({ ...process.env, GIT_DIR: '/repo/.git' });
      });
    });
  });

  describe('Given the win32 platform and a file probe that throws', () => {
    describe('When run', () => {
      it('Then resolves with the spawn-error exit code without spawning', async () => {
        // Arrange
        const { runner, spawned } = probeFailingRunner(new Error('probe failed'));
        const sut = runner.run.bind(runner);

        // Act
        const result = await sut(baseRequest({ command: 'gpg', args: [] }));

        // Assert
        expect(result).toEqual({ exitCode: 127 });
        expect(spawned).toEqual([]);
      });
    });

    describe('When spawned for a conversation', () => {
      it('Then the write rejects with the probe failure and close reports the spawn-error exit', async () => {
        // Arrange
        const failure = new Error('probe failed');
        const { runner } = probeFailingRunner(failure);
        const sut = runner.spawn;

        // Act
        const conversation = sut(baseRequest({ command: 'filter', args: [] }));
        const written = await conversation
          .write(new Uint8Array([1]))
          .catch((error: unknown) => error);
        const exit = await conversation.close();

        // Assert
        expect(written).toBe(failure);
        expect(exit).toEqual({ exitCode: 127 });
      });
    });
  });

  describe('Given the win32 platform and a program planted in the working directory', () => {
    describe('When run naming that program bare', () => {
      it('Then spawns the absolute PATH program, never the planted one', async () => {
        // Arrange
        const host = windowsHost(['C:\\repo\\gpg.exe', 'C:\\gnupg\\gpg.exe']);
        const { runner, child, calls } = makeHarness('win32', host);
        const sut = runner.run.bind(runner);

        // Act
        const promise = sut(baseRequest({ command: 'gpg', args: ['--verify'], cwd: 'C:\\repo' }));
        child.emit('close', 0);
        await promise;

        // Assert
        expect(calls[0]?.command).toBe('C:\\gnupg\\gpg.exe');
      });
    });
  });

  describe('Given the win32 platform and a program on no PATH entry', () => {
    describe('When run', () => {
      it('Then resolves with the spawn-error exit code without spawning', async () => {
        // Arrange
        const host = windowsHost(['C:\\repo\\gpg.exe']);
        const { runner, calls } = makeHarness('win32', host);
        const sut = runner.run.bind(runner);

        // Act
        const result = await sut(
          baseRequest({ command: 'gpg', args: [], cwd: 'C:\\repo', stderr: 'capture' }),
        );

        // Assert
        expect(result).toEqual({ exitCode: 127, stderr: new Uint8Array() });
        expect(calls).toEqual([]);
      });
    });

    describe('When run leaving stderr inherited', () => {
      it('Then the spawn-error result carries no stderr', async () => {
        // Arrange
        const { runner } = makeHarness('win32', windowsHost());
        const sut = runner.run.bind(runner);

        // Act
        const result = await sut(baseRequest({ command: 'gpg', args: [] }));

        // Assert
        expect(result).toEqual({ exitCode: 127 });
      });
    });

    describe('When spawned for a conversation', () => {
      it('Then the write rejects, the output ends empty and close reports the spawn-error exit', async () => {
        // Arrange
        const { runner, calls } = makeHarness('win32', windowsHost());
        const sut = runner.spawn;

        // Act
        const conversation = sut(baseRequest({ command: 'filter', args: [] }));
        const written = await conversation
          .write(new Uint8Array([1]))
          .catch((error: unknown) => error);
        const output = await collect(conversation.output);
        const exit = await conversation.close();

        // Assert
        expect((written as Error).message).toBe('cannot run filter: not found on PATH');
        expect(output).toEqual([]);
        expect(exit).toEqual({ exitCode: 127 });
        expect(calls).toEqual([]);
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

  describe('Given a signal that aborts after the command has already finished', () => {
    describe('When the signal aborts post-completion', () => {
      it('Then the child is not killed (the abort listener was detached on finish)', async () => {
        // Arrange
        const controller = new AbortController();
        const { runner, child } = makeHarness();

        // Act
        const promise = runner.run(baseRequest({ signal: controller.signal }));
        child.emit('close', 0);
        await promise;
        controller.abort();

        // Assert
        expect(child.killed).toBe(false);
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

  describe('Given a command that exits without draining stdin', () => {
    describe('When the stdin write fails with a broken pipe', () => {
      it('Then ignores it and resolves with the exit code the command reported', async () => {
        // Arrange
        const { runner, child } = makeHarness();

        // Act
        const promise = runner.run(baseRequest({ stdin: new Uint8Array([104, 105]) }));
        child.stdin.emit('error', streamError('EPIPE'));
        child.emit('close', 1);
        const result = await promise;

        // Assert
        expect(result.exitCode).toBe(1);
      });
    });

    describe('When the stdin write fails for a reason other than a broken pipe', () => {
      it('Then resolves with the spawn-error exit code', async () => {
        // Arrange
        const { runner, child } = makeHarness();

        // Act
        const promise = runner.run(baseRequest({ stdin: new Uint8Array([104, 105]) }));
        child.stdin.emit('error', streamError('ENOSPC'));
        const result = await promise;

        // Assert
        expect(result.exitCode).toBe(127);
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

  describe('Given a request naming its program and arguments', () => {
    describe.each([
      { platform: 'linux', host: undefined, program: 'gpg' },
      {
        platform: 'win32',
        host: windowsHost(['C:\\gnupg\\gpg.exe']),
        program: 'C:\\gnupg\\gpg.exe',
      },
    ] as const)('When run on $platform', ({ platform, host, program }) => {
      it('Then spawns the program directly with those arguments, no shell', async () => {
        // Arrange
        const { runner, child, calls } = makeHarness(platform, host);
        const sut = runner.run.bind(runner);

        // Act
        const promise = sut(baseRequest({ command: 'gpg', args: ['--verify', "it's", '-'] }));
        child.emit('close', 0);
        await promise;

        // Assert
        expect(calls[0]?.command).toBe(program);
        expect(calls[0]?.args).toEqual(['--verify', "it's", '-']);
      });
    });
  });

  describe('Given a request capturing stderr', () => {
    describe('When the child writes to stderr', () => {
      it('Then pipes stderr and returns its bytes apart from stdout', async () => {
        // Arrange
        const { runner, child, calls } = makeHarness();
        const sut = runner.run.bind(runner);

        // Act
        const promise = sut(baseRequest({ stderr: 'capture' }));
        child.pipedStderr.emit('data', new Uint8Array([1, 2]));
        child.pipedStderr.emit('data', new Uint8Array([3]));
        child.stdout.emit('data', new Uint8Array([9]));
        child.emit('close', 0);
        const result = await promise;

        // Assert
        expect(calls[0]?.stdio).toEqual(['pipe', 'pipe', 'pipe']);
        expect(result).toEqual({
          exitCode: 0,
          stdout: new Uint8Array([9]),
          stderr: new Uint8Array([1, 2, 3]),
        });
      });
    });

    describe('When the child writes nothing', () => {
      it('Then returns empty stderr bytes', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        const sut = runner.run.bind(runner);

        // Act
        const promise = sut(baseRequest({ stderr: 'capture' }));
        child.emit('close', 3);
        const result = await promise;

        // Assert
        expect(result).toEqual({ exitCode: 3, stderr: new Uint8Array(0) });
      });
    });
  });

  describe('Given a request leaving stderr inherited', () => {
    describe('When the child exits', () => {
      it('Then the result carries no stderr', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        const sut = runner.run.bind(runner);

        // Act
        const promise = sut(baseRequest({ stderr: 'inherit' }));
        child.emit('close', 0);
        const result = await promise;

        // Assert
        expect(result).toEqual({ exitCode: 0 });
      });
    });
  });

  describe('Given the request a conversation starts from', () => {
    describe('When a caller would capture its stderr or feed it stdin', () => {
      it('Then the type offers neither, so no undrained stderr pipe can stall the child', () => {
        // Arrange + Assert (type-level)
        type ConversationStart = Parameters<NonNullable<CommandRunner['spawn']>>[0];
        expectTypeOf<ConversationStart>().not.toHaveProperty('stderr');
        expectTypeOf<ConversationStart>().not.toHaveProperty('stdin');
      });
    });
  });

  describe('Given a spawned conversation', () => {
    describe('When bytes are written and the child answers, then exits', () => {
      it('Then the writes reach stdin, the output streams in order and close reports the exit', async () => {
        // Arrange
        const { runner, child, calls } = makeHarness();
        const sut = runner.spawn;

        // Act
        const conversation = sut(baseRequest({ command: 'filter' }));
        const output = collect(conversation.output);
        await conversation.write(new Uint8Array([7]));
        child.stdout.emit('data', new Uint8Array([1, 2]));
        child.stdout.emit('data', new Uint8Array([3]));
        const closing = conversation.close();
        child.emit('close', 0);
        const exit = await closing;

        // Assert
        expect(calls[0]?.args).toEqual(['-c', 'filter']);
        expect(child.stdin.chunks).toEqual([new Uint8Array([7])]);
        expect(child.stdin.ended).toBe(true);
        expect(await output).toEqual([1, 2, 3]);
        expect(exit).toEqual({ exitCode: 0 });
      });
    });

    describe('When the child outpaces the consumer past the high-water mark', () => {
      it('Then stdout pauses once, and resumes once the consumer drains below the mark', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        const sut = runner.spawn;
        const conversation = sut(baseRequest({ command: 'filter' }));
        const reader = conversation.output[Symbol.asyncIterator]();

        // Act
        child.stdout.emit('data', new Uint8Array(OUTPUT_HIGH_WATER_MARK));
        const atMark = [...child.stdout.flow];
        child.stdout.emit('data', new Uint8Array(1));
        child.stdout.emit('data', new Uint8Array(1));
        const pastMark = [...child.stdout.flow];
        await reader.next();
        const result = { atMark, pastMark, drained: child.stdout.flow };

        // Assert
        expect(result).toEqual({ atMark: [], pastMark: ['pause'], drained: ['pause', 'resume'] });
      });
    });

    describe('When the consumer drains a chunk while still above the mark', () => {
      it('Then stdout stays paused', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        const sut = runner.spawn;
        const conversation = sut(baseRequest({ command: 'filter' }));
        const reader = conversation.output[Symbol.asyncIterator]();

        // Act
        child.stdout.emit('data', new Uint8Array(1));
        child.stdout.emit('data', new Uint8Array(OUTPUT_HIGH_WATER_MARK + 1));
        await reader.next();

        // Assert
        expect(child.stdout.flow).toEqual(['pause']);
      });
    });

    describe('When closed while stdout is paused', () => {
      it('Then stdout resumes so the child can finish writing and exit', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        const sut = runner.spawn;
        const conversation = sut(baseRequest({ command: 'filter' }));
        child.stdout.emit('data', new Uint8Array(OUTPUT_HIGH_WATER_MARK + 1));

        // Act
        const closing = conversation.close();
        child.emit('close', 0);
        await closing;

        // Assert
        expect(child.stdout.flow).toEqual(['pause', 'resume']);
      });
    });

    describe('When closed without stdout ever pausing', () => {
      it('Then the flow is left alone', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        const sut = runner.spawn;
        const conversation = sut(baseRequest({ command: 'filter' }));

        // Act
        const closing = conversation.close();
        child.emit('close', 0);
        await closing;

        // Assert
        expect(child.stdout.flow).toEqual([]);
      });
    });

    describe('When started on Windows', () => {
      it('Then the command runs through the absolute ComSpec interpreter with `/c`', () => {
        // Arrange
        const { runner, calls } = makeHarness('win32', windowsHost());
        const sut = runner.spawn;

        // Act
        sut(baseRequest({ command: 'filter' }));

        // Assert
        expect(calls[0]?.command).toBe(WINDOWS_INTERPRETER);
        expect(calls[0]?.args).toEqual(['/c', 'filter']);
      });
    });

    describe('When a write fails', () => {
      it('Then the write rejects with the pipe error, which escalates no further', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        child.stdin.failure = streamError('EPIPE');
        const sut = runner.spawn;

        // Act
        const conversation = sut(baseRequest());
        const writing = conversation.write(new Uint8Array([1]));
        child.stdin.emit('error', child.stdin.failure);
        const result = await writing.catch((error: unknown) => error);

        // Assert
        expect((result as NodeJS.ErrnoException).code).toBe('EPIPE');
      });
    });

    describe('When the child cannot be started', () => {
      it('Then the output ends empty and close reports the spawn-failure exit', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        const sut = runner.spawn;

        // Act
        const conversation = sut(baseRequest());
        child.emit('error', new Error('spawn sh ENOENT'));
        const output = await collect(conversation.output);
        const exit = await conversation.close();

        // Assert
        expect(output).toEqual([]);
        expect(exit).toEqual({ exitCode: 127 });
      });
    });

    describe('When the child is killed by a signal', () => {
      it('Then close reports the signal exit', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        const sut = runner.spawn;

        // Act
        const conversation = sut(baseRequest());
        child.emit('close', null);
        const exit = await conversation.close();

        // Assert
        expect(exit).toEqual({ exitCode: 128 });
      });
    });

    describe('When the signal aborts mid-conversation', () => {
      it('Then the child is killed', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        const controller = new AbortController();
        const sut = runner.spawn;

        // Act
        sut(baseRequest({ signal: controller.signal }));
        controller.abort();

        // Assert
        expect(child.killed).toBe(true);
      });
    });

    describe('When the signal had already aborted', () => {
      it('Then the child is killed at once', () => {
        // Arrange
        const { runner, child } = makeHarness();
        const controller = new AbortController();
        controller.abort();
        const sut = runner.spawn;

        // Act
        sut(baseRequest({ signal: controller.signal }));

        // Assert
        expect(child.killed).toBe(true);
      });
    });

    describe('When the signal aborts after the child exited', () => {
      it('Then the child is not killed', async () => {
        // Arrange
        const { runner, child } = makeHarness();
        const controller = new AbortController();
        const sut = runner.spawn;

        // Act
        const conversation = sut(baseRequest({ signal: controller.signal }));
        child.emit('close', 0);
        await conversation.close();
        controller.abort();

        // Assert
        expect(child.killed).toBe(false);
      });
    });
  });
});
