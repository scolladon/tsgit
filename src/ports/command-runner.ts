/**
 * A single shell-command invocation. The port is stateless — every fact the
 * adapter needs to run the command travels in this request.
 */
export interface CommandRequest {
  /** Shell command line, executed through the platform shell (`sh -c` / `cmd /c`). */
  readonly command: string;
  /** Working directory for the spawned process. */
  readonly cwd: string;
  /** Environment additions merged onto the parent environment by the adapter. */
  readonly env: Readonly<Record<string, string>>;
  /** Cancels a running command — the adapter kills the child when it aborts. */
  readonly signal?: AbortSignal;
  /** Bytes fed to the child's stdin (clean/smudge input). When absent, stdin is not written. */
  readonly stdin?: Uint8Array;
}

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
}

/**
 * Runs an arbitrary shell command line — the custom merge-driver / textconv /
 * clean-smudge filter command. Optional on `Context`: when absent (browser /
 * memory adapters cannot spawn a process), a configured external driver falls
 * back to the built-in behaviour.
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
}
