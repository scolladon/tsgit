/**
 * Request to open one SSH duplex channel. `command`/`args` are the fully
 * resolved ssh program and argv (host token, `-p` flag, sq-quoted remote
 * command) — the adapter performs no faithfulness logic of its own.
 */
export interface SshSpawnRequest {
  /** Resolved ssh program (e.g. `ssh`, or a `GIT_SSH`/`core.sshCommand` override). */
  readonly command: string;
  /** Full argv, incl. host token and remote-command token. */
  readonly args: ReadonlyArray<string>;
  /** Additions merged OVER the parent process environment by the adapter. */
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/**
 * One live SSH duplex channel — a thin process bridge. Stream shapes mirror
 * `HttpTransport`: web streams in, web streams out.
 */
export interface SshChannel {
  /** Request bytes written to the server. */
  readonly stdin: WritableStream<Uint8Array>;
  /** Advertisement + response bytes read from the server. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** Resolves with the ssh process's exit code. */
  readonly exit: Promise<number>;
  /** Idempotent teardown — kills the child process. */
  readonly close: () => Promise<void>;
}

/**
 * Thin duplex process spawner. Knows nothing about git — argv building,
 * quoting, and command resolution are pure application-tier concerns tested
 * independently of this port.
 */
export interface SshTransport {
  readonly open: (req: SshSpawnRequest) => Promise<SshChannel>;
}
