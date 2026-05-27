/**
 * Discriminator for snapshot sources. Each `Snapshot` handle carries a
 * `kind` field so consumers can dispatch on the underlying source at
 * runtime (matching the static discriminator on the entry's `source` field).
 *
 * Compound state heads (`mergeHead`, `cherryPickHead`, etc.) resolve to a
 * tree but advertise their own kind so callers can distinguish a
 * fresh-cloned `head` from a `mergeHead` at the snapshot-handle level.
 */
export type SnapshotKind =
  | 'tree'
  | 'commit'
  | 'index'
  | 'workdir'
  | 'mergeHead'
  | 'cherryPickHead'
  | 'revertHead'
  | 'fetchHead'
  | 'stash';
