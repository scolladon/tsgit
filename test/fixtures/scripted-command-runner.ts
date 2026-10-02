import type {
  CommandProcess,
  CommandRequest,
  CommandRunner,
} from '../../src/ports/command-runner.js';

/** A runner whose commands answer from a script, recording what they were asked. */
export interface ScriptedCommandRunner {
  readonly runner: CommandRunner;
  /** Every request, in order; a spawned one's `stdin` accumulates what was written to it. */
  readonly requests: ReadonlyArray<CommandRequest>;
  /** How many spawned commands were closed. */
  readonly closed: () => number;
}

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
};

async function* once(stdout: Uint8Array): AsyncGenerator<Uint8Array> {
  if (stdout.byteLength > 0) yield stdout;
}

/**
 * `run` answers every request with `stdout` (the first one when several are
 * given) and `exitCode`. `spawn` starts a command whose whole output is the
 * next script — the last one repeats — then ends, and whose close reports
 * `exitCode`.
 */
export const scriptedCommandRunner = (
  stdout: Uint8Array | ReadonlyArray<Uint8Array>,
  exitCode = 0,
): ScriptedCommandRunner => {
  const scripts = stdout instanceof Uint8Array ? [stdout] : stdout;
  const requests: CommandRequest[] = [];
  let spawned = 0;
  let closed = 0;
  const spawn = (request: CommandRequest): CommandProcess => {
    const record = { ...request, stdin: new Uint8Array(0) as Uint8Array };
    requests.push(record);
    const script = scripts[Math.min(spawned, scripts.length - 1)] ?? new Uint8Array(0);
    spawned += 1;
    return {
      write: async (bytes) => {
        record.stdin = concat(record.stdin, bytes);
      },
      output: once(script),
      close: async () => {
        closed += 1;
        return { exitCode };
      },
    };
  };
  const runner: CommandRunner = {
    run: async (request) => {
      requests.push(request);
      return { exitCode, stdout: scripts[0] ?? new Uint8Array(0) };
    },
    spawn,
  };
  return { runner, requests, closed: () => closed };
};
