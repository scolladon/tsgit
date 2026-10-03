/**
 * `reset` porcelain — move HEAD and (per mode) the index and working tree to a
 * target commit, faithful to `git reset --soft|--mixed|--hard`. The resulting
 * HEAD, index, and working tree read back (via `git rev-parse` /
 * `git ls-files --stage`) match canonical git; raw index bytes differ only by
 * per-host stat-cache fields.
 *
 * @writes
 *   surface: reset
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */
import { revparseUnresolved } from '../../domain/commands/error.js';
import { bareRepository } from '../../domain/index.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { resetMovingTo } from '../../domain/reflog/reflog-messages.js';
import type { Context } from '../../ports/context.js';
import { buildIndexFromTree } from '../primitives/build-index-from-tree.js';
import { peelChain } from '../primitives/internal/peel-chain.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { loadSparseMatcher } from '../primitives/read-sparse-checkout.js';
import { updateRef } from '../primitives/update-ref.js';
import { checkoutMetadataFor } from './internal/checkout-metadata.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  assertNoPendingOperation,
  assertOperationalRepository,
  readHeadRaw,
  requireWorkTree,
} from './internal/repo-state.js';
import { resolveRevisionExpression } from './internal/revision-expression.js';

export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface ResetOptions {
  readonly mode: ResetMode;
  readonly rev: string;
}

export interface ResetResult {
  readonly mode: ResetMode;
  readonly id: ObjectId;
  readonly branch: RefName | undefined;
}

/**
 * Reset HEAD (and optionally index/working tree) to `rev`.
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
  await assertOperationalRepository(ctx);
  if (opts.mode === 'hard') requireWorkTree(ctx, 'reset --hard');
  // `is_bare_repository()`-keyed, not work-tree-keyed: a bare-flagged repo
  // opened with an explicit work tree (`--work-tree` over `core.bare=true`)
  // still refuses a mixed reset, matching git — `reset --hard` above is the
  // work-tree question, this is the bareness question, and they disagree in
  // that shape.
  if (opts.mode === 'mixed' && ctx.layout.bare) throw bareRepository('reset --mixed');
  await assertNoPendingOperation(ctx);
  const id = await resolveTarget(ctx, opts.rev);

  if (opts.mode === 'mixed') {
    await rebuildIndexFromCommit(ctx, id);
  } else if (opts.mode === 'hard') {
    await hardResetFromCommit(ctx, id, opts.rev);
  }

  const head = await readHeadRaw(ctx);
  // Always written through the literal `HEAD` — git's own reset moves HEAD
  // itself; `updateRef` dereferences a symbolic HEAD to its branch and logs
  // the coupled split, while a detached HEAD is written directly. Either
  // way it skips the reflog on a no-move — git's needs-commit semantics, so
  // `reset --hard HEAD` records no entry while a real move records the message.
  const branch = head.kind === 'symbolic' ? head.target : undefined;
  await updateRef(ctx, 'HEAD' as RefName, id, {
    reflogMessage: resetMovingTo(opts.rev),
  });
  return { mode: opts.mode, id, branch };
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
    // --mixed always replaces the whole index with the rebuilt projection, so
    // the commit is unconditional — unlike --hard, which can skip it when the
    // materialise wrote and deleted nothing.
    await lock.commit(newEntries);
  } finally {
    await lock.release();
  }
};

const hardResetFromCommit = async (
  ctx: Context,
  commitId: ObjectId,
  rev: string,
): Promise<void> => {
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
  //
  // loadSparseMatcher is a pure config/pattern-file read — no lock needed.
  const matcher = await loadSparseMatcher(ctx);
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
      checkoutMetadata: await checkoutMetadataFor(ctx, rev, commitId),
      // A defined matcher restricts materialisation to in-pattern files;
      // excluded target paths become synthesised skip-worktree index entries.
      // `exactOptionalPropertyTypes`: spread `sparse` only when defined.
      ...(matcher !== undefined ? { sparse: matcher } : {}),
    });
    // Skip the commit only when there is genuinely nothing to record. Without
    // sparse, `written`/`deleted` both 0 is the degenerate empty-tree case.
    // WITH sparse the index can change while both counts are 0 — every target
    // path excluded, nothing written, yet the synthesised skip-worktree
    // entries differ from the pre-reset index — so a defined matcher forces
    // the commit (checkout commits unconditionally for the same reason).
    if (result.written > 0 || result.deleted > 0 || matcher !== undefined) {
      await lock.commit(result.newIndexEntries);
    }
  } finally {
    await lock.release();
  }
};

/**
 * git's `get_oid_committish` read of the target, then `lookup_commit_reference`:
 * any revision expression, an annotated tag peeled to the commit it names.
 * A target naming no commit refuses, keeping the id as resolved.
 */
const resolveTarget = async (ctx: Context, target: string): Promise<ObjectId> => {
  // git reads the argument twice — once to tell a revision from a path, then
  // to resolve it — so every warning the ladder prints, it prints twice.
  await resolveRevisionExpression(ctx, target);
  const id = await resolveRevisionExpression(ctx, target);
  if (id === undefined) throw revparseUnresolved(target);
  const { id: commit, result } = await peelChain(ctx, id, readObject, (object) =>
    object.type === 'tag' ? object.data.object : undefined,
  );
  if (result.type !== 'commit') throw unexpectedObjectType('commit', result.type, id);
  return commit;
};
