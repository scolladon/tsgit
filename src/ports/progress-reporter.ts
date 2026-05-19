/**
 * Progress reporter shape consumed by long-running commands. The facade
 *  accepts a user-supplied implementation via
 * `OpenRepositoryOptions.progress` and plumbs it onto `Context.progress`.
 *
 * Reporters are synchronous and fire-and-forget. The facade wraps every call
 * site in try/catch; a throwing reporter never crashes the operation.
 */
export interface ProgressReporter {
  /**
   * Called once before the first work unit of a sub-task. `op` is a stable
   * internal identifier (e.g., 'clone:write-objects'). `total`, when known,
   * lets consumers render a percentage; absent for indeterminate work.
   */
  readonly start: (op: string, total?: number) => void;

  /**
   * Called periodically during the sub-task. `current` is the count of items
   * processed so far; `total` may be undefined when not known. `text`, when
   * provided, is sideband-style auxiliary text (sanitized by built-in reporters).
   */
  readonly update: (op: string, current: number, total?: number, text?: string) => void;

  /** Called when the sub-task completes (success OR failure). */
  readonly end: (op: string) => void;
}
