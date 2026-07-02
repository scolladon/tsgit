import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { SshChannel, SshSpawnRequest, SshTransport } from '../../ports/ssh-channel.js';

/** Conventional exit code for "ssh could not be spawned". */
const SPAWN_ERROR_EXIT = 127;
/** Exit code reported for an ssh process killed by a signal (e.g. an abort). */
const SIGNAL_KILLED_EXIT = 128;

/** Minimal child-process surface `NodeSshTransport` consumes. */
interface SshChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  kill(): void;
}

/** Options `NodeSshTransport` passes through to the injectable spawn surface. */
interface SshSpawnOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: ['pipe', 'pipe', 'inherit'];
  readonly signal?: AbortSignal;
}

/**
 * Injectable process surface. Production uses `node:child_process` spawn; unit
 * tests inject a fake so every branch runs deterministically without a real
 * process (mirrors `CommandRunnerOps`).
 */
export interface SshTransportOps {
  readonly spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: SshSpawnOptions,
  ) => SshChild;
}

export const realSshTransportOps: SshTransportOps = { spawn };

/** Additions merge OVER the parent process env; `stderr` is always inherited. */
const buildSpawnOptions = (req: SshSpawnRequest): SshSpawnOptions => ({
  env: { ...process.env, ...req.env },
  stdio: ['pipe', 'pipe', 'inherit'],
  ...(req.signal !== undefined ? { signal: req.signal } : {}),
});

/** Resolves once, with the child's exit code (127 spawn-error, 128 signal-killed). */
const exitCodeOf = (child: SshChild): Promise<number> =>
  new Promise<number>((resolve) => {
    child.on('error', () => resolve(SPAWN_ERROR_EXIT));
    child.on('close', (code) => resolve(code ?? SIGNAL_KILLED_EXIT));
  });

/**
 * Node `SshTransport`: a thin duplex spawner with no faithfulness logic of
 * its own — argv/quoting/resolution are built upstream. `stderr` is always
 * inherited so ssh prompts/errors are never captured in memory (no
 * credential capture).
 */
export class NodeSshTransport implements SshTransport {
  private readonly ops: SshTransportOps;

  constructor(ops: SshTransportOps = realSshTransportOps) {
    this.ops = ops;
  }

  open = async (req: SshSpawnRequest): Promise<SshChannel> => {
    const child = this.ops.spawn(req.command, req.args, buildSpawnOptions(req));
    const exit = exitCodeOf(child);
    return {
      stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      exit,
      close: async () => {
        child.kill();
        await exit;
      },
    };
  };
}
