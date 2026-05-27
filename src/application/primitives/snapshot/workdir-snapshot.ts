import type { WorkdirEntryRow } from '../../../domain/snapshot/index.js';
import type { Context } from '../../../ports/context.js';
import type {
  WalkIgnorePredicate,
  WorkdirEnumerator,
  WorkdirEnumOptions,
} from '../../../ports/snapshot-resolvers.js';
import type { Snapshot, SnapshotOptions } from './snapshot.js';
import { createWorkdirEntry, type WorkdirEntry } from './workdir-entry.js';

export interface WorkdirSnapshotOptions extends SnapshotOptions {
  readonly excludes?: WalkIgnorePredicate;
  readonly consistency?: 'eager' | 'verified';
}

export interface WorkdirSnapshotDeps {
  readonly ctx: Context;
  readonly enumerator: WorkdirEnumerator;
}

const mergeEnumOptions = (
  fixed: WorkdirSnapshotOptions | undefined,
  perCall: SnapshotOptions | undefined,
): WorkdirEnumOptions => {
  const paths = perCall?.paths ?? fixed?.paths;
  const maxDepth = perCall?.maxDepth ?? fixed?.maxDepth;
  const maxEntries = perCall?.maxEntries ?? fixed?.maxEntries;
  const signal = perCall?.signal ?? fixed?.signal;
  const excludes = fixed?.excludes;
  return {
    ...(paths === undefined ? {} : { paths }),
    ...(excludes === undefined ? {} : { excludes }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxEntries === undefined ? {} : { maxEntries }),
    ...(signal === undefined ? {} : { signal }),
  };
};

/**
 * Lazily streams working-tree entries via `WorkdirEnumerator`. Excludes
 * and consistency are captured at factory time (per design §8.2 boundary
 * table); the iteration-level option bundle accepts only the base
 * `SnapshotOptions` overrides.
 *
 *   - `'eager'` (default) — stream rows straight from the enumerator;
 *     race detection is opt-in via `entry.verify()` per row.
 *   - `'verified'` — drain the enumerator into an array first, then
 *     yield in stored order. Provides an atomic point-in-time view of
 *     which paths existed at enumerate-time; per-row content is still
 *     subject to mutation between yield and consumption.
 *
 * `bypassCache` and `recurse` are no-ops here — the working tree has
 * no resolver cache, and enumeration is inherently recursive.
 */
export const createWorkdirSnapshot = (
  deps: WorkdirSnapshotDeps,
  fixed?: WorkdirSnapshotOptions,
): Snapshot<WorkdirEntry> => {
  async function* entries(perCall?: SnapshotOptions): AsyncIterable<WorkdirEntry> {
    const enumOpts = mergeEnumOptions(fixed, perCall);
    const stream = deps.enumerator.enumerate(deps.ctx, enumOpts);
    if (fixed?.consistency === 'verified') {
      const buffered: WorkdirEntryRow[] = [];
      for await (const row of stream) buffered.push(row);
      for (const row of buffered) yield createWorkdirEntry(deps.ctx, row);
      return;
    }
    for await (const row of stream) yield createWorkdirEntry(deps.ctx, row);
  }

  return { kind: 'workdir', entries };
};
