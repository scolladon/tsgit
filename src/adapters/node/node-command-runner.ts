import { spawn } from 'node:child_process';
import type {
  CommandExit,
  CommandProcess,
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../ports/command-runner.js';

/** Conventional exit code for "command could not be spawned". */
const SPAWN_ERROR_EXIT = 127;
/** Exit code reported for a command killed by a signal (e.g. an abort). */
const SIGNAL_KILLED_EXIT = 128;
/** `errno` code raised when writing to a pipe whose reader has already gone. */
const BROKEN_PIPE = 'EPIPE';

/** Minimal child-process surface `NodeCommandRunner` consumes. */
interface CommandChild {
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  kill(): void;
  readonly stdin: {
    on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): void;
    write(chunk: Uint8Array, callback?: (error?: Error | null) => void): void;
    end(): void;
  };
  readonly stdout: {
    on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  };
}

/**
 * Injectable process surface. Production uses `node:child_process` spawn; unit
 * tests inject a fake so every branch runs deterministically without a real
 * process (mirrors `HookRunnerOps`).
 */
export interface CommandRunnerOps {
  readonly spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly stdio: ['pipe', 'pipe', 'inherit'];
    },
  ) => CommandChild;
}

export const realCommandRunnerOps: CommandRunnerOps = { spawn };

const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

const spawnCommand = (
  ops: CommandRunnerOps,
  shell: string,
  flag: string,
  request: CommandRequest,
): Promise<CommandResult> =>
  new Promise<CommandResult>((resolve) => {
    const child = ops.spawn(shell, [flag, request.command], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ['pipe', 'pipe', 'inherit'] as ['pipe', 'pipe', 'inherit'],
    });
    const signal = request.signal;
    const onAbort = (): void => {
      child.kill();
    };
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted === true) child.kill();
    const stdoutChunks: Uint8Array[] = [];
    child.stdout.on('data', (chunk: Uint8Array) => {
      stdoutChunks.push(chunk);
    });
    // `error` and `close` can both fire on a failed spawn; `resolve` is
    // idempotent, so the first result wins and any second call is a no-op.
    const finish = (exitCode: number): void => {
      signal?.removeEventListener('abort', onAbort);
      if (stdoutChunks.length > 0) {
        resolve({ exitCode, stdout: concatChunks(stdoutChunks) });
      } else {
        resolve({ exitCode });
      }
    };
    child.on('error', () => {
      finish(SPAWN_ERROR_EXIT);
    });
    child.on('close', (code) => {
      finish(code ?? SIGNAL_KILLED_EXIT);
    });
    if (request.stdin !== undefined) {
      // A command that exits before draining stdin leaves the pipe broken.
      // Refusing without reading input is the command's prerogative — git does
      // the same and reads the exit status — so a broken pipe is not a failure
      // here; `close` still delivers the real exit code. Any other write error
      // is genuine and surfaces the same way a failed spawn does.
      child.stdin.on('error', (error) => {
        if (error.code !== BROKEN_PIPE) finish(SPAWN_ERROR_EXIT);
      });
      child.stdin.write(request.stdin);
      child.stdin.end();
    }
  });

/** Chunks pushed by the child, replayed to one async consumer in order. */
interface ChunkQueue {
  readonly push: (chunk: Uint8Array) => void;
  readonly end: () => void;
  readonly chunks: AsyncIterable<Uint8Array>;
}

const createChunkQueue = (): ChunkQueue => {
  const pending: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  async function* drain(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = pending.shift();
      if (next !== undefined) yield next;
      else if (ended) return;
      else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
  }
  return {
    push: (chunk) => {
      pending.push(chunk);
      notify();
    },
    end: () => {
      ended = true;
      notify();
    },
    chunks: { [Symbol.asyncIterator]: drain },
  };
};

/** The child's exit: its code, the spawn-failure code, or the signal code. */
const exitOf = (child: CommandChild): Promise<CommandExit> =>
  new Promise<CommandExit>((resolve) => {
    child.on('error', () => resolve({ exitCode: SPAWN_ERROR_EXIT }));
    child.on('close', (code) => resolve({ exitCode: code ?? SIGNAL_KILLED_EXIT }));
  });

const writeTo = (child: CommandChild, bytes: Uint8Array): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
  });

/** Kills the child when `signal` aborts, until the child has exited. */
const killOnAbort = (child: CommandChild, exit: Promise<unknown>, signal?: AbortSignal): void => {
  const onAbort = (): void => child.kill();
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted === true) child.kill();
  void exit.then(() => signal?.removeEventListener('abort', onAbort));
};

const converse = (
  ops: CommandRunnerOps,
  [shell, flag]: readonly [string, string],
  request: CommandRequest,
): CommandProcess => {
  const child = ops.spawn(shell, [flag, request.command], {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    stdio: ['pipe', 'pipe', 'inherit'] as ['pipe', 'pipe', 'inherit'],
  });
  const output = createChunkQueue();
  child.stdout.on('data', output.push);
  const exit = exitOf(child);
  void exit.then(output.end);
  killOnAbort(child, exit, request.signal);
  // A failed write rejects `write` with the same error; the listener only
  // keeps Node from escalating that already-reported error.
  child.stdin.on('error', () => undefined);
  return {
    write: (bytes) => writeTo(child, bytes),
    output: output.chunks,
    close: () => {
      child.stdin.end();
      return exit;
    },
  };
};

/**
 * Node `CommandRunner`: runs a command line through the platform shell
 * (`sh -c` on POSIX, `cmd /c` on Windows) with `cwd` and an environment that
 * merges `request.env` over `process.env`. Stdin is piped from `request.stdin`
 * when present; stdout is captured into `result.stdout`. Never rejects for a
 * non-zero exit.
 */
export class NodeCommandRunner implements CommandRunner {
  private readonly isWindows: boolean;
  private readonly ops: CommandRunnerOps;

  constructor(
    platform: NodeJS.Platform = process.platform,
    ops: CommandRunnerOps = realCommandRunnerOps,
  ) {
    this.isWindows = platform === 'win32';
    this.ops = ops;
  }

  run(request: CommandRequest): Promise<CommandResult> {
    const shell = this.isWindows ? 'cmd' : 'sh';
    const flag = this.isWindows ? '/c' : '-c';
    return spawnCommand(this.ops, shell, flag, request);
  }

  /** Starts `request.command` through the platform shell, kept open for a conversation. */
  readonly spawn = (request: CommandRequest): CommandProcess =>
    converse(this.ops, this.isWindows ? ['cmd', '/c'] : ['sh', '-c'], request);
}
