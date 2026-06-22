import { spawn } from 'node:child_process';
import type { CommandRequest, CommandResult, CommandRunner } from '../../ports/command-runner.js';

/** Conventional exit code for "command could not be spawned". */
const SPAWN_ERROR_EXIT = 127;
/** Exit code reported for a command killed by a signal (e.g. an abort). */
const SIGNAL_KILLED_EXIT = 128;

/** Minimal child-process surface `NodeCommandRunner` consumes. */
interface CommandChild {
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  kill(): void;
  readonly stdin: {
    write(chunk: Uint8Array): void;
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
    if (request.stdin !== undefined) {
      child.stdin.write(request.stdin);
      child.stdin.end();
    }
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
  });

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
}
