import { spawn } from 'node:child_process';
import type {
  CommandExit,
  CommandProcess,
  CommandRequest,
  CommandResult,
  CommandRunner,
  ConversationRequest,
} from '../../ports/command-runner.js';

/** Conventional exit code for "command could not be spawned". */
const SPAWN_ERROR_EXIT = 127;
/** Exit code reported for a command killed by a signal (e.g. an abort). */
const SIGNAL_KILLED_EXIT = 128;
/** `errno` code raised when writing to a pipe whose reader has already gone. */
const BROKEN_PIPE = 'EPIPE';
const POSIX_SHELL: Shell = ['sh', '-c'];
const WINDOWS_SHELL: Shell = ['cmd', '/c'];
/** Bytes of a conversed-with child's output buffered for the consumer before its stdout pauses. */
const OUTPUT_HIGH_WATER_MARK = 1024 * 1024;

/** A readable child stream, as far as `NodeCommandRunner` consumes it. */
interface ChildOutput {
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  pause(): void;
  resume(): void;
}

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
  readonly stdout: ChildOutput;
  /** Present when stderr is piped; `null` when inherited. */
  readonly stderr: ChildOutput | null;
}

/** Spawn options: stdin and stdout piped, stderr inherited or piped. */
interface ChildOptions<Stderr extends 'inherit' | 'pipe'> {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: ['pipe', 'pipe', Stderr];
}

/**
 * Injectable process surface. Production uses `node:child_process` spawn; unit
 * tests inject a fake so every branch runs deterministically without a real
 * process (mirrors `HookRunnerOps`).
 */
export interface CommandRunnerOps {
  spawn(
    command: string,
    args: ReadonlyArray<string>,
    options: ChildOptions<'inherit'>,
  ): CommandChild;
  spawn(command: string, args: ReadonlyArray<string>, options: ChildOptions<'pipe'>): CommandChild;
}

export const realCommandRunnerOps: CommandRunnerOps = { spawn };

/** The platform shell and its "run this line" flag. */
type Shell = readonly [string, string];

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

/**
 * A started child, or the error a spawn threw before any child existed — Node
 * refuses some programs synchronously, e.g. a `.bat`/`.cmd` run without a shell.
 */
type Started =
  | { readonly child: CommandChild; readonly error?: never }
  | { readonly child?: never; readonly error: unknown };

/** Spawns `request` directly when it names its arguments, else through `shell`. */
const startChild = (
  ops: CommandRunnerOps,
  [shell, flag]: Shell,
  request: CommandRequest,
): Started => {
  const file = request.args === undefined ? shell : request.command;
  const args = request.args ?? [flag, request.command];
  const env = { ...process.env, ...request.env };
  try {
    return request.stderr === 'capture'
      ? { child: ops.spawn(file, args, { cwd: request.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }) }
      : {
          child: ops.spawn(file, args, {
            cwd: request.cwd,
            env,
            stdio: ['pipe', 'pipe', 'inherit'],
          }),
        };
  } catch (error) {
    return { error };
  }
};

/** Every chunk `stream` emits, joined on demand. */
const collect = (stream: ChildOutput): (() => Uint8Array) => {
  const chunks: Uint8Array[] = [];
  stream.on('data', (chunk: Uint8Array) => {
    chunks.push(chunk);
  });
  return () => concatChunks(chunks);
};

const resultOf = (
  exitCode: number,
  stdout: Uint8Array,
  stderr: (() => Uint8Array) | undefined,
): CommandResult => ({
  exitCode,
  ...(stdout.length > 0 ? { stdout } : {}),
  ...(stderr !== undefined ? { stderr: stderr() } : {}),
});

/** Pipes `stdin` to the child, tolerating a child that exits without reading it. */
const feedStdin = (child: CommandChild, stdin: Uint8Array, fail: () => void): void => {
  // A command that exits before draining stdin leaves the pipe broken.
  // Refusing without reading input is the command's prerogative — git does
  // the same and reads the exit status — so a broken pipe is not a failure
  // here; `close` still delivers the real exit code. Any other write error
  // is genuine and surfaces the same way a failed spawn does.
  child.stdin.on('error', (error) => {
    if (error.code !== BROKEN_PIPE) fail();
  });
  child.stdin.write(stdin);
  child.stdin.end();
};

/** The result of a command that never started: the spawn-failure exit, with no output. */
const failedStartResult = (request: CommandRequest): CommandResult =>
  resultOf(
    SPAWN_ERROR_EXIT,
    new Uint8Array(),
    request.stderr === 'capture' ? () => new Uint8Array() : undefined,
  );

const spawnCommand = (
  ops: CommandRunnerOps,
  shell: Shell,
  request: CommandRequest,
): Promise<CommandResult> => {
  const { child } = startChild(ops, shell, request);
  return child === undefined
    ? Promise.resolve(failedStartResult(request))
    : awaitChild(child, request);
};

const awaitChild = (child: CommandChild, request: CommandRequest): Promise<CommandResult> =>
  new Promise<CommandResult>((resolve) => {
    const exit = new Promise<number>((settle) => {
      child.on('error', () => settle(SPAWN_ERROR_EXIT));
      child.on('close', (code) => settle(code ?? SIGNAL_KILLED_EXIT));
    });
    killOnAbort(child, exit, request.signal);
    const stdout = collect(child.stdout);
    const stderr = child.stderr === null ? undefined : collect(child.stderr);
    // `error` and `close` can both fire on a failed spawn; `resolve` is
    // idempotent, so the first result wins and any second call is a no-op.
    const finish = (exitCode: number): void => resolve(resultOf(exitCode, stdout(), stderr));
    void exit.then(finish);
    if (request.stdin !== undefined)
      feedStdin(child, request.stdin, () => finish(SPAWN_ERROR_EXIT));
  });

/** Chunks pushed by the child, replayed to one async consumer in order. */
interface ChunkQueue {
  readonly push: (chunk: Uint8Array) => void;
  readonly end: () => void;
  /** Lifts the high-water mark for good, so a closing child can flush and exit. */
  readonly release: () => void;
  readonly chunks: AsyncIterable<Uint8Array>;
}

/**
 * Pauses `source` while more than {@link OUTPUT_HIGH_WATER_MARK} bytes wait
 * for the consumer, and resumes it once they drain back under the mark.
 */
const createFlowControl = (source: ChildOutput) => {
  let buffered = 0;
  let mark = OUTPUT_HIGH_WATER_MARK;
  let paused = false;
  const settle = (): void => {
    if (paused === buffered > mark) return;
    paused = !paused;
    if (paused) source.pause();
    else source.resume();
  };
  return {
    added: (bytes: number): void => {
      buffered += bytes;
      settle();
    },
    taken: (bytes: number): void => {
      buffered -= bytes;
      settle();
    },
    release: (): void => {
      mark = Number.POSITIVE_INFINITY;
      settle();
    },
  };
};

const createChunkQueue = (source: ChildOutput): ChunkQueue => {
  const pending: Uint8Array[] = [];
  const flow = createFlowControl(source);
  let ended = false;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  async function* drain(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = pending.shift();
      if (next !== undefined) {
        flow.taken(next.length);
        yield next;
      } else if (ended) return;
      else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
  }
  return {
    push: (chunk) => {
      pending.push(chunk);
      flow.added(chunk.length);
      notify();
    },
    end: () => {
      ended = true;
      notify();
    },
    release: flow.release,
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

/** A conversation with a command that never started: it behaves as one that exited at once. */
const failedStartProcess = (error: unknown): CommandProcess => ({
  write: () => Promise.reject(error),
  output: {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
  },
  close: () => Promise.resolve({ exitCode: SPAWN_ERROR_EXIT }),
});

const converse = (
  ops: CommandRunnerOps,
  shell: Shell,
  request: ConversationRequest,
): CommandProcess => {
  const started = startChild(ops, shell, request);
  return started.child === undefined
    ? failedStartProcess(started.error)
    : conversation(started.child, request);
};

const conversation = (child: CommandChild, request: ConversationRequest): CommandProcess => {
  const output = createChunkQueue(child.stdout);
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
      output.release();
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
    return spawnCommand(this.ops, this.shell(), request);
  }

  /** Starts `request.command` through the platform shell, kept open for a conversation. */
  readonly spawn = (request: ConversationRequest): CommandProcess =>
    converse(this.ops, this.shell(), request);

  private shell(): Shell {
    return this.isWindows ? WINDOWS_SHELL : POSIX_SHELL;
  }
}
