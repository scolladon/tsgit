/**
 * A single shell-command invocation. The port is stateless — every fact the
 * adapter needs to run the command travels in this request.
 */
export interface CommandRequest {
  /**
   * Shell command line, executed through the platform shell (`sh -c` / `cmd /c`)
   * — or, when `args` is present, the program run directly.
   */
  readonly command: string;
  /**
   * Arguments for `command` run directly, with no shell between — git's
   * `start_command` with `use_shell` off. Each argument reaches the program
   * verbatim, whatever its quotes or spaces.
   */
  readonly args?: ReadonlyArray<string>;
  /** Working directory for the spawned process. */
  readonly cwd: string;
  /** Environment additions merged onto the parent environment by the adapter. */
  readonly env: Readonly<Record<string, string>>;
  /** Cancels a running command — the adapter kills the child when it aborts. */
  readonly signal?: AbortSignal;
  /** Bytes fed to the child's stdin (clean/smudge input). When absent, stdin is not written. */
  readonly stdin?: Uint8Array;
  /** Where the child's stderr goes: inherited by default; `capture` returns it on `result.stderr`. */
  readonly stderr?: StderrMode;
}

/** `inherit` shares the parent's stderr; `capture` pipes it back to the caller. */
export type StderrMode = 'inherit' | 'capture';

/**
 * Outcome of a command. Two output conventions are carried by one port:
 * - A merge driver communicates its result by overwriting its output file `%A`
 *   — only the exit code matters (`0` ⇒ success); `stdout` is ignored.
 * - A textconv or clean/smudge filter driver communicates its result via stdout
 *   — the caller reads `result.stdout` for the transformed bytes.
 */
export interface CommandResult {
  readonly exitCode: number;
  /** Bytes captured from the child's stdout (textconv/filter output). Absent when not captured. */
  readonly stdout?: Uint8Array;
  /** Bytes captured from the child's stderr when the request captured it. Absent otherwise. */
  readonly stderr?: Uint8Array;
}

/**
 * Runs an arbitrary shell command line — the custom merge-driver / textconv /
 * clean-smudge filter command. Optional on `Context`: when absent (browser /
 * memory adapters cannot spawn a process), a configured merge or textconv
 * driver falls back to the built-in behaviour and an optional clean/smudge
 * driver leaves the bytes as stored, while a required clean/smudge driver
 * refuses — git refuses a required driver it cannot start.
 *
 * NEVER rejects for a non-zero exit — interpreting the exit code is the
 * caller's policy.
 *
 * Two output conventions coexist on this single port:
 * - **Merge driver**: communicates via its `%A` output file; the caller
 *   ignores `result.stdout`. Pass no `stdin`; `stdout` will be absent.
 * - **Textconv / filter driver**: communicates via stdout; the caller reads
 *   `result.stdout`. Pass `stdin` bytes when the driver reads from stdin
 *   (clean/smudge); omit `stdin` when the driver reads from a file argument
 *   (textconv).
 */
export interface CommandRunner {
  readonly run: (request: CommandRequest) => Promise<CommandResult>;
  /**
   * Starts a long-running command the caller converses with — a
   * `filter.<driver>.process` speaking git's filter protocol. Optional: a
   * runtime that cannot keep a process open omits it, and a process driver
   * then cannot start. The request's `stdin` is ignored; bytes travel
   * through {@link CommandProcess.write}.
   */
  readonly spawn?: (request: CommandRequest) => CommandProcess;
}

/** The exit of a conversed-with command, once it has finished. */
export interface CommandExit {
  readonly exitCode: number;
}

/**
 * A running command started by {@link CommandRunner.spawn}. A command that
 * fails to start behaves as one that exits at once: `output` ends empty,
 * `write` rejects and `close` reports the spawn-failure exit code.
 */
export interface CommandProcess {
  /** Feeds bytes to the child's stdin; rejects once the child can no longer read them. */
  readonly write: (bytes: Uint8Array) => Promise<void>;
  /** The child's stdout, chunk by chunk, ending when the child exits. */
  readonly output: AsyncIterable<Uint8Array>;
  /** Ends the child's stdin and resolves once the child has exited. Never rejects. */
  readonly close: () => Promise<CommandExit>;
}
