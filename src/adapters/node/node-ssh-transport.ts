import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { SshChannel, SshSpawnRequest, SshTransport } from '../../ports/ssh-channel.js';
import {
  type ProgramLookupHost,
  type ProgramResolver,
  programNotFound,
  programResolverFor,
  realProgramLookupHost,
} from './windows-program-lookup.js';

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
 * Injectable process surface. Production uses `node:child_process` spawn, the
 * process environment and the file system; unit tests inject fakes so every
 * branch — Windows program lookup included — runs deterministically without a
 * real process (mirrors `CommandRunnerOps`).
 */
export interface SshTransportOps extends ProgramLookupHost {
  readonly spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: SshSpawnOptions,
  ) => SshChild;
}

export const realSshTransportOps: SshTransportOps = { spawn, ...realProgramLookupHost };

/** Additions merge OVER the parent process env; `stderr` is always inherited. */
const buildSpawnOptions = (
  parentEnv: NodeJS.ProcessEnv,
  req: SshSpawnRequest,
): SshSpawnOptions => ({
  env: { ...parentEnv, ...req.env },
  stdio: ['pipe', 'pipe', 'inherit'],
  ...(req.signal !== undefined ? { signal: req.signal } : {}),
});

/** Resolves once, with the child's exit code (127 spawn-error, 128 signal-killed). */
const exitCodeOf = (child: SshChild): Promise<number> =>
  new Promise<number>((resolve) => {
    child.on('error', () => resolve(SPAWN_ERROR_EXIT));
    child.on('close', (code) => resolve(code ?? SIGNAL_KILLED_EXIT));
  });

const channelOf = (child: SshChild): SshChannel => {
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

/** A channel to an ssh that never started: it behaves as one that exited at once. */
const failedStartChannel = (program: string): SshChannel => {
  const error = programNotFound(program);
  return {
    stdin: new WritableStream<Uint8Array>({ start: (controller) => controller.error(error) }),
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    exit: Promise.resolve(SPAWN_ERROR_EXIT),
    close: () => Promise.resolve(),
  };
};

/**
 * Node `SshTransport`: a thin duplex spawner — argv/quoting and the choice of
 * ssh program are built upstream. On Windows a bare program name resolves
 * against `PATH` alone, never the working directory. `stderr` is always
 * inherited so ssh prompts/errors are never captured in memory (no
 * credential capture).
 */
export class NodeSshTransport implements SshTransport {
  private readonly ops: SshTransportOps;
  private readonly resolve: ProgramResolver;

  constructor(
    platform: NodeJS.Platform = process.platform,
    ops: SshTransportOps = realSshTransportOps,
  ) {
    this.ops = ops;
    this.resolve = programResolverFor(platform, ops);
  }

  open = async (req: SshSpawnRequest): Promise<SshChannel> => {
    const program = this.resolve(req.command);
    if (program === undefined) return failedStartChannel(req.command);
    return channelOf(this.ops.spawn(program, req.args, buildSpawnOptions(this.ops.env, req)));
  };
}
