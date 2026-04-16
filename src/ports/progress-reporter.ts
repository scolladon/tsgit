/** The phase of a git operation producing progress events. */
export type ProgressPhase =
  | 'counting'
  | 'compressing'
  | 'receiving'
  | 'resolving'
  | 'checking-out'
  | 'writing';

export interface ProgressEvent {
  readonly phase: ProgressPhase;
  readonly loaded: number;
  /** Total count, if known. Undefined for indeterminate progress. */
  readonly total?: number;
}

export interface ProgressReporter {
  /** Report progress. Implementations should be tolerant of high call frequency. */
  readonly report: (event: ProgressEvent) => void;
}

/** No-op ProgressReporter — used by contexts that don't need progress reporting. */
export const noopProgressReporter: ProgressReporter = {
  report: () => {},
};
