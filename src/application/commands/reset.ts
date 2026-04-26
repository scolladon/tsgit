import { revparseUnresolved } from '../../domain/commands/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
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
 * - `mixed`: HEAD + clears the index (Phase 9 stub: index cleared via lock release).
 * - `hard`:  HEAD + index + working tree (working-tree mutation deferred to Phase 11).
 *
 * v1 implements the HEAD-update path; index/working-tree side effects beyond
 * the HEAD move land in subsequent passes once `materializeFile`/`removeFile`
 * orchestration is in place.
 */
export const reset = async (ctx: Context, opts: ResetOptions): Promise<ResetResult> => {
  await assertRepository(ctx);
  if (opts.mode === 'hard') await assertNotBare(ctx, 'reset --hard');
  await assertNoPendingOperation(ctx);
  const id = await resolveTarget(ctx, opts.target);
  const head = await readHeadRaw(ctx);
  const branch = head.kind === 'symbolic' ? head.target : undefined;
  if (branch !== undefined) {
    await updateRef(ctx, branch, id, {});
  } else {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${id}\n`);
  }
  return { mode: opts.mode, id, branch };
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
