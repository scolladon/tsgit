/** Object kinds the fsck validator operates on. */
export type FsckObjectType = 'commit' | 'blob' | 'tree' | 'tag';

/**
 * Severity of a catalogue finding.
 * Mirrors git's WARN/ERROR/INFO classes that appear in
 * `warning in …` / `error in …` / `warning in …` (INFO) output.
 */
export type FsckSeverity = 'error' | 'warning' | 'info';
