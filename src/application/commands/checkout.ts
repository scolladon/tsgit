import { branchNotFound } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { writeSymbolicRef } from '../primitives/write-symbolic-ref.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
} from './internal/repo-state.js';

export interface CheckoutOptions {
  readonly target: string;
  readonly detach?: boolean;
  readonly force?: boolean;
}

export interface CheckoutResult {
  readonly branch: RefName | undefined;
  readonly id: ObjectId;
  readonly detached: boolean;
}

const HEADS_PREFIX = 'refs/heads/';

/**
 * Switch HEAD to point at `target`. When `target` is an existing branch, HEAD
 * becomes a symbolic ref to it. When `target` is an oid (or `detach: true`),
 * HEAD becomes detached and stores the oid directly.
 *
 * Working-tree update (materializing the target tree, removing absent files)
 * is a Phase 11 follow-up; v1 updates HEAD only and leaves the working tree
 * untouched. Callers who need a true "switch + checkout files" must run
 * `add` after `checkout` to re-sync.
 */
export const checkout = async (ctx: Context, opts: CheckoutOptions): Promise<CheckoutResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'checkout');
  await assertNoPendingOperation(ctx);
  if (opts.detach || /^[0-9a-f]{40}$/.test(opts.target)) {
    const id = await resolveTargetOid(ctx, opts.target);
    await ctx.fs.writeUtf8(`${ctx.config.gitDir}/HEAD`, `${id}\n`);
    return { branch: undefined, id, detached: true };
  }
  const branchName = validateRefName(`${HEADS_PREFIX}${opts.target}`);
  if (!(await ctx.fs.exists(`${ctx.config.gitDir}/${branchName}`))) {
    throw branchNotFound(branchName);
  }
  const id = await resolveRef(ctx, branchName);
  await writeSymbolicRef(ctx, 'HEAD' as RefName, branchName);
  return { branch: branchName, id, detached: false };
};

const resolveTargetOid = async (ctx: Context, target: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;
  return resolveRef(ctx, target as RefName);
};
