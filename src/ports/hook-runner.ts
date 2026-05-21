import type { HookName } from '../domain/hooks/index.js';

/**
 * A single hook invocation. The port is stateless — every fact the adapter
 * needs to resolve and spawn the hook travels in this request.
 */
export interface HookRequest {
  /** Hook to run. */
  readonly name: HookName;
  /** Absolute directory holding hook scripts — `core.hooksPath` or `${gitDir}/hooks`. */
  readonly hooksDir: string;
  /** Working directory for the spawned process — the working-tree root. */
  readonly workDir: string;
  /** Absolute `.git` directory — exported to the hook environment as `GIT_DIR`. */
  readonly gitDir: string;
  /** Positional arguments (e.g. the `COMMIT_EDITMSG` path for `commit-msg`). */
  readonly args: ReadonlyArray<string>;
  /** Bytes piped to the hook's stdin. Empty string ⇒ stdin closed empty. */
  readonly stdin: string;
  /** Cancels a running hook — the adapter kills the child when it aborts. */
  readonly signal?: AbortSignal;
}

/**
 * Outcome of a hook invocation.
 *
 * `skipped` — the hook file is absent or not executable; nothing ran. Git
 * treats both as "no hook, proceed".
 *
 * `ran` — the hook ran to completion; `exitCode` is authoritative (a non-zero
 * value is the caller's signal to abort).
 */
export type HookResult =
  | { readonly kind: 'skipped' }
  | {
      readonly kind: 'ran';
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    };

/**
 * Runs git lifecycle hooks. Optional on `Context`: when absent, hooks are
 * inert (the browser has no runner; a host may opt out).
 */
export interface HookRunner {
  /**
   * Resolve `${hooksDir}/${name}`; when it exists and is executable, spawn it
   * with `args`, `stdin`, `cwd = workDir`, and `GIT_DIR` in the environment.
   * Resolves with the exit code and captured output. NEVER rejects for a
   * non-zero exit — interpreting the exit code is the caller's policy.
   */
  readonly run: (request: HookRequest) => Promise<HookResult>;
}
