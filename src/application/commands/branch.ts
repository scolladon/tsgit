import { TsgitError } from '../../domain/error.js';
import { branchExists, branchNotFound, cannotDeleteCheckedOutBranch } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { writeSymbolicRef } from '../primitives/write-symbolic-ref.js';
import { assertRepository, readHeadRaw } from './internal/repo-state.js';

export type BranchAction =
  | { readonly kind: 'list' }
  | {
      readonly kind: 'create';
      readonly name: string;
      readonly startPoint?: string;
      readonly force?: boolean;
    }
  | { readonly kind: 'delete'; readonly name: string; readonly force?: boolean }
  | {
      readonly kind: 'rename';
      readonly from: string;
      readonly to: string;
      readonly force?: boolean;
    };

export interface BranchInfo {
  readonly name: RefName;
  readonly id: ObjectId;
  readonly current: boolean;
}

export type BranchResult =
  | { readonly kind: 'list'; readonly branches: ReadonlyArray<BranchInfo> }
  | { readonly kind: 'create'; readonly name: RefName; readonly id: ObjectId }
  | { readonly kind: 'delete'; readonly name: RefName }
  | { readonly kind: 'rename'; readonly from: RefName; readonly to: RefName };

const HEADS_PREFIX = 'refs/heads/';

export const branch = async (ctx: Context, action: BranchAction): Promise<BranchResult> => {
  await assertRepository(ctx);
  if (action.kind === 'list') return listBranches(ctx);
  if (action.kind === 'create') return createBranch(ctx, action);
  if (action.kind === 'delete') return deleteBranch(ctx, action);
  return renameBranch(ctx, action);
};

const listBranches = async (ctx: Context): Promise<BranchResult> => {
  const headsDir = `${ctx.layout.gitDir}/refs/heads`;
  if (!(await ctx.fs.exists(headsDir))) return { kind: 'list', branches: [] };
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
  return { kind: 'list', branches };
};

/**
 * Total order over ref names: `-1` / `0` / `1`. Exported for direct unit
 * testing of the equal-keys (`0`) case, which `listBranches` cannot exercise
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

const createBranch = async (
  ctx: Context,
  action: { readonly name: string; readonly startPoint?: string; readonly force?: boolean },
): Promise<BranchResult> => {
  const name = validateRefName(`${HEADS_PREFIX}${action.name}`);
  const startPoint = action.startPoint ?? 'HEAD';
  const target = await resolveBranchTarget(ctx, startPoint);
  try {
    await updateRef(ctx, name, target, action.force === true ? {} : { expected: 'absent' });
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_UPDATE_CONFLICT') {
      throw branchExists(name);
    }
    throw err;
  }
  return { kind: 'create', name, id: target };
};

const deleteBranch = async (
  ctx: Context,
  action: { readonly name: string; readonly force?: boolean },
): Promise<BranchResult> => {
  const name = validateRefName(`${HEADS_PREFIX}${action.name}`);
  const head = await readHeadRaw(ctx);
  if (head.kind === 'symbolic' && head.target === name) {
    throw cannotDeleteCheckedOutBranch(name);
  }
  if (!(await ctx.fs.exists(`${ctx.layout.gitDir}/${name}`))) {
    throw branchNotFound(name);
  }
  await updateRef(ctx, name, '0'.repeat(40) as ObjectId, { delete: true });
  return { kind: 'delete', name };
};

const renameBranch = async (
  ctx: Context,
  action: { readonly from: string; readonly to: string; readonly force?: boolean },
): Promise<BranchResult> => {
  const from = validateRefName(`${HEADS_PREFIX}${action.from}`);
  const to = validateRefName(`${HEADS_PREFIX}${action.to}`);
  const id = await resolveRef(ctx, from);
  try {
    await updateRef(ctx, to, id, action.force === true ? {} : { expected: 'absent' });
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_UPDATE_CONFLICT') {
      throw branchExists(to);
    }
    throw err;
  }
  await updateRef(ctx, from, '0'.repeat(40) as ObjectId, { delete: true });
  const head = await readHeadRaw(ctx);
  if (head.kind === 'symbolic' && head.target === from) {
    await writeSymbolicRef(ctx, 'HEAD' as RefName, to);
  }
  return { kind: 'rename', from, to };
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
