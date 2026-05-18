import { revparseUnresolved } from '../../domain/commands/error.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { buildIndexFromTree } from '../primitives/build-index-from-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  readHeadRaw,
} from './internal/repo-state.js';

export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface ResetOptions {
  readonly mode: ResetMode;
  readonly target: string;
}

export interface ResetResult {
  readonly mode: ResetMode;
  readonly id: ObjectId;
  readonly branch: RefName | undefined;
}

/**
 * Reset HEAD (and optionally index/working tree) to `target`.
 *
 * - `soft`:  HEAD only.
 * - `mixed`: HEAD + rebuild the index from the target commit's tree
 *            (stat-cache donor strategy preserves cache for unchanged paths —
 *            ADR-021). Working tree is NOT touched.
 * - `hard`:  HEAD + index + working tree (working-tree mutation deferred to
 *            Phase 13.3).
 *
 * Ordering: index commit BEFORE HEAD update. A crash between the two leaves
 * the index ahead of HEAD; canonical git has the same hazard and lets the
 * user re-run `reset` — idempotent.
 */
export const reset = async (ctx: Context, opts: ResetOptions): Promise<ResetResult> => {
  await assertRepository(ctx);
  if (opts.mode === 'hard') await assertNotBare(ctx, 'reset --hard');
  await assertNoPendingOperation(ctx);
  const id = await resolveTarget(ctx, opts.target);

  if (opts.mode === 'mixed') {
    await rebuildIndexFromCommit(ctx, id);
  }

  const head = await readHeadRaw(ctx);
  const branch = head.kind === 'symbolic' ? head.target : undefined;
  if (branch !== undefined) {
    await updateRef(ctx, branch, id, {});
  } else {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${id}\n`);
  }
  return { mode: opts.mode, id, branch };
};

const rebuildIndexFromCommit = async (ctx: Context, commitId: ObjectId): Promise<void> => {
  const commit = await readObject(ctx, commitId);
  if (commit.type !== 'commit') {
    throw unexpectedObjectType('commit', commit.type, commitId);
  }
  const currentIndex = await readIndex(ctx);
  const newEntries = await buildIndexFromTree(ctx, {
    targetTree: commit.data.tree,
    currentIndex,
  });
  const lock = await acquireIndexLock(ctx);
  try {
    await lock.commit(newEntries);
  } finally {
    await lock.release();
  }
};

const resolveTarget = async (ctx: Context, target: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;
  const candidates: ReadonlyArray<RefName | 'HEAD'> =
    target === 'HEAD'
      ? ['HEAD']
      : [target as RefName, `refs/heads/${target}` as RefName, `refs/tags/${target}` as RefName];
  for (const c of candidates) {
    try {
      return await resolveRef(ctx, c);
    } catch {
      // continue
    }
  }
  throw revparseUnresolved(target);
};
