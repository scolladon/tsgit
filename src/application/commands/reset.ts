import { revparseUnresolved } from '../../domain/commands/error.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { buildIndexFromTree } from '../primitives/build-index-from-tree.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { loadSparseMatcher } from '../primitives/read-sparse-checkout.js';
import { recordRefUpdate } from '../primitives/record-ref-update.js';
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
 * - `soft`: HEAD only.
 * - `mixed`: HEAD + rebuild the index from the target commit's tree
 *  (stat-cache donor strategy preserves cache for unchanged paths —
 * ). Working tree is NOT touched.
 * - `hard`: HEAD + index + working tree — materialise the target tree onto
 *  the working tree with `force: true`, then commit the post-write
 *  index entries. Bare repos are rejected upfront.
 *
 * Ordering: working tree → index → HEAD. The index lock wraps both the
 * working-tree write AND the index commit, matching tightened
 * pattern. A crash between the index commit and HEAD update leaves the index
 * ahead of HEAD — same recoverable hazard as canonical git.
 */
export const reset = async (ctx: Context, opts: ResetOptions): Promise<ResetResult> => {
  await assertRepository(ctx);
  if (opts.mode === 'hard') await assertNotBare(ctx, 'reset --hard');
  await assertNoPendingOperation(ctx);
  const id = await resolveTarget(ctx, opts.target);

  if (opts.mode === 'mixed') {
    await rebuildIndexFromCommit(ctx, id);
  } else if (opts.mode === 'hard') {
    await hardResetFromCommit(ctx, id);
  }

  const head = await readHeadRaw(ctx);
  const reflogMessage = `reset: moving to ${opts.target}`;
  if (head.kind === 'symbolic') {
    await updateRef(ctx, head.target, id, { reflogMessage });
    return { mode: opts.mode, id, branch: head.target };
  }
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${id}\n`);
  await recordRefUpdate(ctx, 'HEAD' as RefName, head.id, id, reflogMessage);
  return { mode: opts.mode, id, branch: undefined };
};

const rebuildIndexFromCommit = async (ctx: Context, commitId: ObjectId): Promise<void> => {
  const commit = await readObject(ctx, commitId);
  if (commit.type !== 'commit') {
    throw unexpectedObjectType('commit', commit.type, commitId);
  }
  // loadSparseMatcher is a pure config/pattern-file read — no index lock
  // needed. A defined matcher marks excluded paths skip-worktree in the
  // rebuilt index; `undefined` ⇒ sparse inactive and the rebuild is unchanged.
  const matcher = await loadSparseMatcher(ctx);
  // Acquire the index lock BEFORE reading the index. A concurrent writer
  // (another reset, add, rm…) between read and commit would otherwise let
  // the donor map go stale, producing a result that reflects neither the
  // pre- nor the post-reset state.
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const newEntries = await buildIndexFromTree(ctx, {
      targetTree: commit.data.tree,
      currentIndex,
      // `exactOptionalPropertyTypes`: spread `sparse` only when defined.
      ...(matcher !== undefined ? { sparse: matcher } : {}),
    });
    await lock.commit(newEntries);
  } finally {
    await lock.release();
  }
};

const hardResetFromCommit = async (ctx: Context, commitId: ObjectId): Promise<void> => {
  const commit = await readObject(ctx, commitId);
  if (commit.type !== 'commit') {
    throw unexpectedObjectType('commit', commit.type, commitId);
  }
  // Same lock-first ordering as the mixed path. The lock wraps
  // the working-tree materialise too, so a concurrent index writer is
  // serialised for the entire hard-reset transaction. This intentionally
  // diverges from.1 checkout's lock-around-commit-only pattern,
  // which has a known TOCTOU window between `readIndex` and `acquireIndexLock`.
  // Tightening checkout's lock pattern is captured as a follow-up in
  // `the backlog`
  //
  // The index commit uses materializeTree's `newIndexEntries` (post-write
  // lstat-derived stats), not buildIndexFromTree's donor stats — donor stats
  // would be stale for files we just rewrote.
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const result = await materializeTree(ctx, {
      targetTree: commit.data.tree,
      currentIndex,
      force: true,
      // Hard reset must overwrite working-tree files even when the index
      // says they match the target — the user may have uncommitted local
      // modifications that the index→target diff can't see. Without this
      // flag, dirty noop'd paths would survive the reset.
      forceRewriteAll: true,
    });
    // Skip the commit when there is genuinely nothing to write — matches
    // checkout's no-op skip. With `forceRewriteAll: true`, this only fires
    // in the degenerate case (empty target tree against an empty index);
    // otherwise every target-tree path becomes an upgraded update.
    if (result.written > 0 || result.deleted > 0) {
      await lock.commit(result.newIndexEntries);
    }
  } finally {
    await lock.release();
  }
};

const resolveTarget = async (ctx: Context, target: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;
  // equivalent-mutant: the `target === 'HEAD'` short-circuit is an
  // optimisation — the else branch's first candidate is also `'HEAD' as
  // RefName`, which `resolveRef` resolves to the same commit. Removing or
  // emptying the literal routes the call through the else branch, which
  // succeeds on the first try, producing the same observable result.
  const candidates: ReadonlyArray<RefName | 'HEAD'> =
    // Stryker disable next-line ConditionalExpression: equivalent — forcing the else branch routes `'HEAD'` through `[target as RefName, ...]` whose first candidate is `'HEAD'`, resolved identically by resolveRef.
    // Stryker disable next-line StringLiteral: equivalent — emptying the literal makes `target === ''` false for `'HEAD'`, routing it through the else branch whose first candidate `'HEAD'` resolves to the same commit.
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
