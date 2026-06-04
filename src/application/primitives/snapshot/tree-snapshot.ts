import { isDirectory } from '../../../domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId, Tree } from '../../../domain/objects/index.js';
import { matchesPathspec } from '../../../domain/pathspec/index.js';
import type { TreeEntryRow } from '../../../domain/snapshot/index.js';
import type { Context } from '../../../ports/context.js';
import type { TreeResolver } from '../../../ports/snapshot-resolvers.js';
import { walkTree } from '../walk-tree.js';
import type { Snapshot, SnapshotOptions } from './snapshot.js';
import { createTreeEntry, type TreeEntry } from './tree-entry.js';

const kindFromMode = (mode: FileMode): TreeEntryRow['kind'] => {
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'submodule';
  return 'file';
};

const toEntry = (ctx: Context, path: FilePath, oid: ObjectId, mode: FileMode): TreeEntry =>
  createTreeEntry(ctx, { source: 'tree', path, oid, mode, kind: kindFromMode(mode) });

interface TreeSnapshotDeps {
  readonly ctx: Context;
  readonly treeResolver: TreeResolver;
}

/**
 * Lazily evaluates a tree by its oid via `TreeResolver`. The root tree is
 * resolved on the first iteration and reused across subsequent iterations
 * for stability. Trees are content-addressed, so the captured reference
 * is independent of any external cache invalidation.
 *
 * Only leaf entries (files, symlinks, gitlinks/submodules) are yielded.
 * Directories are descended into but never yielded as their own row —
 * `kind` is therefore narrowed to `'file' | 'symlink' | 'submodule'`.
 */
export const createTreeSnapshot = (
  deps: TreeSnapshotDeps,
  treeId: ObjectId,
): Snapshot<TreeEntry> => {
  let cached: Tree | null = null;

  const root = async (bypassCache: boolean): Promise<Tree> => {
    if (cached !== null && !bypassCache) return cached;
    const fresh = await deps.treeResolver.resolve(deps.ctx, treeId, { bypassCache });
    cached = fresh;
    return fresh;
  };

  async function* entries(opts?: SnapshotOptions): AsyncIterable<TreeEntry> {
    const tree = await root(opts?.bypassCache === true);
    const walkOpts: Parameters<typeof walkTree>[2] = {
      recursive: opts?.recurse !== false,
      ...(opts?.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
      ...(opts?.maxEntries === undefined ? {} : { maxEntries: opts.maxEntries }),
    };
    for await (const node of walkTree(deps.ctx, tree, walkOpts)) {
      if (isDirectory(node.mode as FileMode)) continue;
      if (opts?.paths !== undefined && !matchesPathspec(opts.paths, node.path)) continue;
      yield toEntry(deps.ctx, node.path, node.id, node.mode as FileMode);
    }
  }

  return { kind: 'tree', entries };
};
