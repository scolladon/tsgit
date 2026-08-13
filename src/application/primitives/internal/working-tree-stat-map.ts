import type { FilePath } from '../../../domain/objects/object-id.js';
import type { FileStat } from '../../../ports/file-system.js';

/**
 * A per-`status`-invocation cache of working-tree `lstat` samples, shared
 * between `status`'s tracked pass (`scanWorkingTree` → `compareWorkingTreeDelta`)
 * and its untracked pass (`scanUntracked` → `walkWorkingTree`), so a path
 * sampled by one pass is never re-stated by the other.
 *
 * CQS-split on purpose: `sampled` never populates, `record` never returns.
 * Created inside one `status` call, passed explicitly down two call paths,
 * unreachable once `status` returns — the containment here is lifetime, not
 * immutability. No module-level state, no `Context` field, no adapter cache,
 * no eviction policy: memory is bounded by the paths one `status` call
 * already materialises in its own tracked/untracked results.
 */
export interface WorkingTreeStatMap {
  readonly sampled: (path: FilePath) => FileStat | undefined;
  readonly record: (path: FilePath, stat: FileStat) => void;
}

export const createWorkingTreeStatMap = (): WorkingTreeStatMap => {
  const samples = new Map<FilePath, FileStat>();
  return {
    sampled: (path) => samples.get(path),
    record: (path, stat) => {
      samples.set(path, stat);
    },
  };
};
