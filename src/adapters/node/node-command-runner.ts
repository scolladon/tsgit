import { spawn } from 'node:child_process';
import type {
  CommandExit,
  CommandProcess,
  CommandRequest,
  CommandResult,
  CommandRunner,
  ConversationRequest,
} from '../../ports/command-runner.js';
import {
  type ProgramLookupHost,
  type ProgramResolver,
  programNotFound,
  programResolverFor,
  realProgramLookupHost,
  windowsCommandInterpreter,
} from './windows-program-lookup.js';

/** Conventional exit code for "command could not be spawned". */
const SPAWN_ERROR_EXIT = 127;
/** Exit code reported for a command killed by a signal (e.g. an abort). */
const SIGNAL_KILLED_EXIT = 128;
/** `errno` code raised when writing to a pipe whose reader has already gone. */
const BROKEN_PIPE = 'EPIPE';
const POSIX_SHELL: Shell = ['sh', '-c'];
const WINDOWS_SHELL_FLAG = '/c';
/**
 * cmd.exe searches its working directory — the repository — before `PATH` for a
 * command line's program unless this variable is set, which would run a program
 * the repository planted there.
 */
const WINDOWS_SHELL_ENV: NodeJS.ProcessEnv = { NoDefaultCurrentDirectoryInExePath: '1' };
const NO_SHELL_ENV: NodeJS.ProcessEnv = {};
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
 * Injectable process surface. Production uses `node:child_process` spawn, the
 * process environment and the file system; unit tests inject fakes so every
 * branch — Windows program lookup included — runs deterministically without a
 * real process (mirrors `HookRunnerOps`).
 */
export interface CommandRunnerOps extends ProgramLookupHost {
  spawn(
    command: string,
    args: ReadonlyArray<string>,
    options: ChildOptions<'inherit'>,
  ): CommandChild;
  spawn(command: string, args: ReadonlyArray<string>, options: ChildOptions<'pipe'>): CommandChild;
}

export const realCommandRunnerOps: CommandRunnerOps = { spawn, ...realProgramLookupHost };

/** The platform shell and its "run this line" flag. */
type Shell = readonly [string, string];

/** How a platform starts programs: its shell, and where a program name resolves. */
interface Launcher {
  readonly shell: Shell;
  /** Variables a shell start sets over the caller's environment. */
  readonly shellEnv: NodeJS.ProcessEnv;
  readonly resolve: ProgramResolver;
}

/** Where a started child runs: the resolved program, its arguments and environment. */
interface Invocation {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

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

const spawnChild = (
  ops: CommandRunnerOps,
  { file, args, env }: Invocation,
  request: CommandRequest,
): CommandChild =>
  request.stderr === 'capture'
    ? ops.spawn(file, args, { cwd: request.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    : ops.spawn(file, args, { cwd: request.cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });

/**
 * What `request` starts, its program not yet resolved: the program with its own
 * arguments when it names them, else the launcher's shell running its command line.
 */
const invocationOf = (
  { shell: [shell, flag], shellEnv }: Launcher,
  baseEnv: NodeJS.ProcessEnv,
  request: CommandRequest,
): Invocation => {
  const env = { ...baseEnv, ...request.env };
  return request.args === undefined
    ? { file: shell, args: [flag, request.command], env: { ...env, ...shellEnv } }
    : { file: request.command, args: request.args, env };
};

/**
 * Spawns `request` directly when it names its arguments, else through the
 * launcher's shell; a program the launcher cannot find never starts.
 */
const startChild = (
  ops: CommandRunnerOps,
  launcher: Launcher,
  request: CommandRequest,
): Started => {
  const invocation = invocationOf(launcher, ops.env, request);
  try {
    const file = launcher.resolve(invocation.file);
    if (file === undefined) return { error: programNotFound(invocation.file) };
    return { child: spawnChild(ops, { ...invocation, file }, request) };
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
  launcher: Launcher,
  request: CommandRequest,
): Promise<CommandResult> => {
  const { child } = startChild(ops, launcher, request);
  return child === undefined
    ? Promise.resolve(failedStartResult(request))
    : awaitChild(child, request);
};

const awaitChild = (child: CommandChild, request: CommandRequest): Promise<CommandResult> =>
  new Promise<CommandResult>((resolve) => {
    const exit = exitOf(child);
    killOnAbort(child, exit, request.signal);
    const stdout = collect(child.stdout);
    const stderr = child.stderr === null ? undefined : collect(child.stderr);
    // A failed stdin write and the exit can both finish the run; `resolve` is
    // idempotent, so the first result wins and any second call is a no-op.
    const finish = (exitCode: number): void => resolve(resultOf(exitCode, stdout(), stderr));
    void exit.then(({ exitCode }) => finish(exitCode));
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

/** Tracks the bytes waiting for the consumer, pausing the child's stdout while they pile up. */
interface FlowControl {
  readonly added: (bytes: number) => void;
  readonly taken: (bytes: number) => void;
  /** Lifts the high-water mark for good. */
  readonly release: () => void;
}

const shouldPause = (buffered: number, mark: number): boolean => buffered > mark;

/**
 * Pauses `source` while more than {@link OUTPUT_HIGH_WATER_MARK} bytes wait
 * for the consumer, and resumes it once they drain back under the mark.
 */
const createFlowControl = (source: ChildOutput): FlowControl => {
  let buffered = 0;
  let mark = OUTPUT_HIGH_WATER_MARK;
  let paused = false;
  const settle = (): void => {
    if (paused === shouldPause(buffered, mark)) return;
    paused = !paused;
    if (paused) source.pause();
    else source.resume();
  };
  const adjust = (delta: number): void => {
    buffered += delta;
    settle();
  };
  const release = (): void => {
    mark = Number.POSITIVE_INFINITY;
    settle();
  };
  return { added: adjust, taken: (bytes) => adjust(-bytes), release };
};

/** A wake-up the consumer awaits while the queue is empty. */
interface Waker {
  readonly wait: () => Promise<void>;
  readonly notify: () => void;
}

const createWaker = (): Waker => {
  let wake: (() => void) | undefined;
  return {
    wait: () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
    notify: () => {
      wake?.();
      wake = undefined;
    },
  };
};

/** Yields `pending` chunks as they arrive, until the queue has ended and emptied. */
async function* drainChunks(
  pending: Uint8Array[],
  flow: FlowControl,
  waker: Waker,
  hasEnded: () => boolean,
): AsyncGenerator<Uint8Array> {
  for (;;) {
    const next = pending.shift();
    if (next !== undefined) {
      flow.taken(next.length);
      yield next;
    } else if (hasEnded()) return;
    else await waker.wait();
  }
}

const createChunkQueue = (source: ChildOutput): ChunkQueue => {
  const pending: Uint8Array[] = [];
  const flow = createFlowControl(source);
  const waker = createWaker();
  let ended = false;
  return {
    push: (chunk) => {
      pending.push(chunk);
      flow.added(chunk.length);
      waker.notify();
    },
    end: () => {
      ended = true;
      waker.notify();
    },
    release: flow.release,
    chunks: { [Symbol.asyncIterator]: () => drainChunks(pending, flow, waker, () => ended) },
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
  launcher: Launcher,
  request: ConversationRequest,
): CommandProcess => {
  const started = startChild(ops, launcher, request);
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
 * (`sh -c` on POSIX; on Windows the absolute `ComSpec` interpreter with `/c`)
 * with `cwd` and an environment that merges `request.env` over `process.env`.
 * On Windows a bare program the runner starts itself resolves against `PATH`
 * alone, never `cwd`; a command line goes to cmd.exe with
 * `NoDefaultCurrentDirectoryInExePath` set, so cmd.exe searches `PATH` and not
 * `cwd` for its program; the programs it starts inherit that variable.
 * Stdin is piped from `request.stdin` when present; stdout is captured into
 * `result.stdout`. Never rejects for a non-zero exit.
 */
export class NodeCommandRunner implements CommandRunner {
  private readonly isWindows: boolean;
  private readonly ops: CommandRunnerOps;
  private readonly resolve: ProgramResolver;

  constructor(
    platform: NodeJS.Platform = process.platform,
    ops: CommandRunnerOps = realCommandRunnerOps,
  ) {
    this.isWindows = platform === 'win32';
    this.ops = ops;
    this.resolve = programResolverFor(platform, ops);
  }

  run(request: CommandRequest): Promise<CommandResult> {
    return spawnCommand(this.ops, this.launcher(), request);
  }

  /** Starts `request.command` through the platform shell, kept open for a conversation. */
  readonly spawn = (request: ConversationRequest): CommandProcess =>
    converse(this.ops, this.launcher(), request);

  /** Read per start: the interpreter follows `ComSpec` as the environment changes. */
  private launcher(): Launcher {
    return this.isWindows
      ? {
          shell: [windowsCommandInterpreter(this.ops.env), WINDOWS_SHELL_FLAG],
          shellEnv: WINDOWS_SHELL_ENV,
          resolve: this.resolve,
        }
      : { shell: POSIX_SHELL, shellEnv: NO_SHELL_ENV, resolve: this.resolve };
  }
}
