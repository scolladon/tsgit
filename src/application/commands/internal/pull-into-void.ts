/**
 * git pull's `pull_into_void`: an unborn HEAD takes the one fetched head. The
 * index is checked out as a two-way merge from the empty tree — what it already
 * holds is kept, a staged path the head carries differently is refused — then
 * the branch HEAD names is created at the head under the reflog `initial pull`.
 */
import { workingTreeDirty } from '../../../domain/commands/error.js';
import type { FlatTree } from '../../../domain/diff/flat-tree.js';
import type { GitIndex } from '../../../domain/git-index/index-entry.js';
import { escapedPathOf } from '../../../domain/git-index/index-path-key.js';
import { type ObjectId, RefName } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { flattenEscapedTree } from '../../primitives/flatten-tree.js';
import { materializeTree } from '../../primitives/materialize-tree.js';
import { readIndex } from '../../primitives/read-index.js';
import { resolveRefOrMissing } from '../../primitives/resolve-ref.js';
import { updateRef } from '../../primitives/update-ref.js';
import { asMergeDirtyError, type MergeResult } from '../merge.js';
import { treeOf } from './history-rewrite.js';
import { acquireIndexLock } from './index-update.js';

const INITIAL_PULL = 'initial pull';

export const pullIntoVoid = async (
  ctx: Context,
  head: ObjectId,
  branch: RefName | undefined,
): Promise<MergeResult> => {
  const currHead = await resolveRefOrMissing(ctx, 'HEAD');
  await checkoutFromEmptyTree(ctx, await treeOf(ctx, head));
  await updateRef(ctx, RefName.from('HEAD'), head, {
    expected: currHead ?? 'absent',
    reflogMessage: INITIAL_PULL,
  });
  return { kind: 'fast-forward', id: head, branch };
};

const checkoutFromEmptyTree = async (ctx: Context, tree: ObjectId): Promise<void> => {
  const target = await flattenEscapedTree(ctx, tree);
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    assertNoStagedCollision(currentIndex, target);
    const result = await materializeTree(ctx, {
      targetTree: tree,
      currentIndex,
      force: false,
      ignoredOccupants: 'protect',
      paths: new Set(target.entries.keys()),
    }).catch((err: unknown) => {
      throw asMergeDirtyError(err);
    });
    await lock.commit(result.newIndexEntries, 'replace');
  } finally {
    await lock.release();
  }
};

/** git's two-way merge with no old tree: a staged entry survives only when the head carries it unchanged. */
const assertNoStagedCollision = (index: GitIndex, target: FlatTree): void => {
  const localChanges = index.entries
    .filter((entry) => {
      const incoming = target.entries.get(escapedPathOf(entry));
      return incoming !== undefined && (incoming.id !== entry.id || incoming.mode !== entry.mode);
    })
    .map((entry) => entry.path);
  if (localChanges.length > 0) throw workingTreeDirty({ localChanges, untracked: [] });
};
