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
}

/**
 * Outcome of a command. A merge driver communicates its result by overwriting
 * its output file, so only the exit code is surfaced (`0` ⇒ success).
 */
export interface CommandResult {
  readonly exitCode: number;
}

/**
 * Runs an arbitrary shell command line — the custom merge-driver command.
 * Optional on `Context`: when absent (browser / memory adapters cannot spawn a
 * process), a configured external driver falls back to the built-in merge.
 * NEVER rejects for a non-zero exit — interpreting the exit code is the caller's
 * policy.
 */
export interface CommandRunner {
  readonly run: (request: CommandRequest) => Promise<CommandResult>;
}
