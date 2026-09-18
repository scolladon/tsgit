/** Object kinds the fsck validator operates on. */
export type FsckObjectType = 'commit' | 'blob' | 'tree' | 'tag';

/**
 * Severity of a catalogue finding.
 * Mirrors git's WARN/ERROR/INFO classes that appear in
 * `warning in …` / `error in …` / `warning in …` (INFO) output.
 */
export type FsckSeverity = 'error' | 'warning' | 'info';

/**
 * A severity a repository's `fsck.<msg-id>` configuration may impose.
 * `ignore` is not a reportable severity — a finding re-typed to it is never
 * emitted, and contributes no exit bit.
 */
export type FsckConfiguredSeverity = FsckSeverity | 'ignore';

/** `fsck.<msg-id>` re-typings, keyed by the lower-cased msg-id. */
export type FsckSeverityTable = ReadonlyMap<string, FsckConfiguredSeverity>;
