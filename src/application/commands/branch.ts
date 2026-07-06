/**
 * `branch` porcelain — manage `refs/heads/*`, exposed as the `repo.branch.*`
 * nested namespace (`list` / `create` / `delete` / `rename`). Each verb is a
 * Context-aware function; the namespace binder lives in
 * `internal/branch-namespace.ts`.
 */
import { TsgitError } from '../../domain/error.js';
import { branchExists, branchNotFound, cannotDeleteCheckedOutBranch } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { ZERO_OID } from '../../domain/objects/index.js';
import { branchCreatedFrom, branchRenamed } from '../../domain/reflog/reflog-messages.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { readReflog, writeReflog } from '../primitives/reflog-store.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { writeSymbolicRef } from '../primitives/write-symbolic-ref.js';
import { assertOperationalRepository, readHeadRaw } from './internal/repo-state.js';

export interface BranchInfo {
  readonly name: RefName;
  readonly id: ObjectId;
  readonly current: boolean;
}

export interface BranchListResult {
  readonly branches: ReadonlyArray<BranchInfo>;
}

export interface BranchCreateInput {
  readonly name: string;
  readonly startPoint?: string;
  readonly force?: boolean;
}
export interface BranchCreateResult {
  readonly name: RefName;
  readonly id: ObjectId;
}

export interface BranchDeleteInput {
  readonly name: string;
  readonly force?: boolean;
}
export interface BranchDeleteResult {
  readonly name: RefName;
}

export interface BranchRenameInput {
  readonly from: string;
  readonly to: string;
  readonly force?: boolean;
}
export interface BranchRenameResult {
  readonly from: RefName;
  readonly to: RefName;
}

const HEADS_PREFIX = 'refs/heads/';

export const branchList = async (ctx: Context): Promise<BranchListResult> => {
  await assertOperationalRepository(ctx);
  const headsDir = `${ctx.layout.gitDir}/refs/heads`;
  if (!(await ctx.fs.exists(headsDir))) return { branches: [] };
  const head = await readHeadRaw(ctx);
  const currentTarget =
    head.kind === 'symbolic' && head.target.startsWith(HEADS_PREFIX) ? head.target : undefined;
  const entries = await ctx.fs.readdir(headsDir);
  const branches: BranchInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const name = `${HEADS_PREFIX}${entry.name}` as RefName;
    const id = await resolveRef(ctx, name);
    branches.push({ name, id, current: name === currentTarget });
  }
  branches.sort((a, b) => compareRefName(a.name, b.name));
  return { branches };
};

/**
 * Total order over ref names: `-1` / `0` / `1`. Exported for direct unit
 * testing of the equal-keys (`0`) case, which `branchList` cannot exercise
 * because directory entries are unique. A code-unit comparison (not
 * `localeCompare`) matches Git's byte-wise ref ordering.
 */
export const compareRefName = (left: RefName, right: RefName): number => {
  const lower = left < right;
  if (lower) return -1;
  const higher = left > right;
  if (higher) return 1;
  return 0;
};

export const branchCreate = async (
  ctx: Context,
  input: BranchCreateInput,
): Promise<BranchCreateResult> => {
  await assertOperationalRepository(ctx);
  const name = validateRefName(`${HEADS_PREFIX}${input.name}`);
  const startPoint = input.startPoint ?? 'HEAD';
  const target = await resolveBranchTarget(ctx, startPoint);
  const reflogMessage = branchCreatedFrom(startPoint);
  try {
    await updateRef(
      ctx,
      name,
      target,
      input.force === true ? { reflogMessage } : { expected: 'absent', reflogMessage },
    );
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_UPDATE_CONFLICT') {
      throw branchExists(name);
    }
    throw err;
  }
  return { name, id: target };
};

export const branchDelete = async (
  ctx: Context,
  input: BranchDeleteInput,
): Promise<BranchDeleteResult> => {
  await assertOperationalRepository(ctx);
  const name = validateRefName(`${HEADS_PREFIX}${input.name}`);
  const head = await readHeadRaw(ctx);
  if (head.kind === 'symbolic' && head.target === name) {
    throw cannotDeleteCheckedOutBranch(name);
  }
  if (!(await ctx.fs.exists(`${ctx.layout.gitDir}/${name}`))) {
    throw branchNotFound(name);
  }
  await updateRef(ctx, name, ZERO_OID, { delete: true });
  return { name };
};

export const branchRename = async (
  ctx: Context,
  input: BranchRenameInput,
): Promise<BranchRenameResult> => {
  await assertOperationalRepository(ctx);
  const from = validateRefName(`${HEADS_PREFIX}${input.from}`);
  const to = validateRefName(`${HEADS_PREFIX}${input.to}`);
  const id = await resolveRef(ctx, from);
  const reflogMessage = branchRenamed(from, to);
  // Capture the source log before any write so the rename preserves history.
  const movedLog = await readReflog(ctx, from);
  try {
    await updateRef(
      ctx,
      to,
      id,
      input.force === true ? { reflogMessage } : { expected: 'absent', reflogMessage },
    );
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_UPDATE_CONFLICT') {
      throw branchExists(to);
    }
    throw err;
  }
  // Re-attach `from`'s history to `to` BEFORE deleting `from`: were the
  // merged-log write to fail, `from`'s reflog must still be intact.
  if (movedLog.length > 0) {
    await writeReflog(ctx, to, [...movedLog, ...(await readReflog(ctx, to))]);
  }
  // updateRef's delete path drops `from`'s log; its history is already on `to`.
  await updateRef(ctx, from, ZERO_OID, { delete: true });
  const head = await readHeadRaw(ctx);
  if (head.kind === 'symbolic' && head.target === from) {
    await writeSymbolicRef(ctx, 'HEAD' as RefName, to);
  }
  return { from, to };
};

const resolveBranchTarget = async (ctx: Context, startPoint: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(startPoint)) return startPoint as ObjectId;
  const candidates: ReadonlyArray<RefName | 'HEAD'> =
    startPoint === 'HEAD'
      ? ['HEAD']
      : [`${HEADS_PREFIX}${startPoint}` as RefName, startPoint as RefName];
  for (const candidate of candidates) {
    try {
      return await resolveRef(ctx, candidate);
    } catch {
      // continue
    }
  }
  throw branchNotFound(startPoint as RefName);
};
