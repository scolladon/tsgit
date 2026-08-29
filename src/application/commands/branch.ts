/**
 * `branch` porcelain — manage `refs/heads/*`, exposed as the `repo.branch.*`
 * nested namespace (`list` / `create` / `delete` / `rename`). Each verb is a
 * Context-aware function; the namespace binder lives in
 * `internal/branch-namespace.ts`.
 */
import { TsgitError } from '../../domain/error.js';
import { branchExists, branchNotFound, cannotDeleteCheckedOutBranch } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { isOid, zeroOid } from '../../domain/objects/index.js';
import { branchCreatedFrom, branchRenamed } from '../../domain/reflog/reflog-messages.js';
import { validateRefName } from '../../domain/refs/index.js';
import { HEADS_PREFIX } from '../../domain/refs/ref-prefixes.js';
import type { Context } from '../../ports/context.js';
import { errorDataCode } from '../primitives/internal/error-data-code.js';
import { getRefStore, refExists } from '../primitives/ref-store.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { writeSymbolicRef } from '../primitives/write-symbolic-ref.js';
import {
  assertOperationalRepository,
  branchRefFromHead,
  readHeadRaw,
} from './internal/repo-state.js';

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

export const branchList = async (ctx: Context): Promise<BranchListResult> => {
  await assertOperationalRepository(ctx);
  const currentTarget = await resolveCurrentBranchTarget(ctx);
  const entries = await getRefStore(ctx).listRefs(HEADS_PREFIX as RefName);
  const branches: BranchInfo[] = [];
  for (const entry of entries) {
    // A branch ref is always direct in practice; a hand-crafted symbolic one
    // still resolves faithfully via the general (chain-following) resolver.
    const id = entry.value.kind === 'direct' ? entry.value.id : await resolveRef(ctx, entry.name);
    branches.push({ name: entry.name, id, current: entry.name === currentTarget });
  }
  branches.sort((a, b) => compareRefName(a.name, b.name));
  return { branches };
};

/**
 * The current branch's full ref, or `undefined` when HEAD is detached — or
 * does not resolve at all. Measured against git 2.55.0: `git branch --list`
 * against a repository whose `HEAD` is a dangling symlink still exits 0 and
 * lists every branch, simply marking none current — git treats an
 * unresolvable `HEAD` as "no current branch", not as a failure to list. A
 * `HEAD` that resolves to malformed content is a different, harder refusal
 * in real git (`fatal: failed to resolve HEAD as a valid ref`), so only the
 * "does not resolve" code (`REF_NOT_FOUND`) is folded here; anything else
 * — including a malformed `HEAD` (`INVALID_REF`) — still propagates.
 */
const resolveCurrentBranchTarget = async (ctx: Context): Promise<RefName | undefined> => {
  try {
    const ref = branchRefFromHead(await readHeadRaw(ctx));
    return ref?.startsWith(HEADS_PREFIX) ? ref : undefined;
  } catch (err) {
    if (errorDataCode(err) === 'REF_NOT_FOUND') return undefined;
    throw err;
  }
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
  if (!(await refExists(ctx, name))) {
    throw branchNotFound(name);
  }
  await updateRef(ctx, name, zeroOid(ctx.hashConfig), { delete: true });
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
  const store = getRefStore(ctx);
  // Probed BEFORE the CAS set below makes `to` exist: git's forced rename
  // deletes the destination ref first, which drops its log; an orphan log
  // with no live ref underneath survives and takes the rename entry as an
  // append (measured, git 2.55.0).
  const replacesLiveRef = input.force === true && (await refExists(ctx, to));
  if (from === to) {
    // git accepts a self-rename (`branch -m x x` and `-M x x` both exit 0):
    // the ref and its log stay put and only the rename entry is appended.
    // Without this arm the trailing delete below would remove the branch
    // that was just "renamed" onto itself.
    await store.applyRefUpdates([
      {
        kind: 'reflogOnly',
        name: to,
        reflog: { oldId: id, newId: id, message: branchRenamed(from, to) },
      },
    ]);
    return { from, to };
  }
  // The CAS conflict check runs BEFORE any log move: git checks and refuses
  // before touching anything. The failure window differs from git's: a throw
  // after moveReflog leaves `from` a live branch whose log already moved to
  // `to`, where git stages the log through a temp path and rolls back.
  try {
    await store.applyRefUpdates([
      {
        kind: 'set',
        name: to,
        id,
        ...(input.force === true ? {} : { expected: 'absent' as const }),
      },
    ]);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_UPDATE_CONFLICT') {
      throw branchExists(to);
    }
    throw err;
  }
  // Move the log byte-preserving (never parsed), then log the rename —
  // git's own order (`rename(2)` the log, then log the rename). A rename
  // entry notes the rename without moving the ref's value, so old/new are
  // both the resolved tip.
  if (replacesLiveRef) {
    await store.applyRefUpdates([{ kind: 'reflogReplace', name: to, entries: [] }]);
  }
  await store.moveReflog(from, to);
  await store.applyRefUpdates([
    {
      kind: 'reflogOnly',
      name: to,
      reflog: { oldId: id, newId: id, message: branchRenamed(from, to) },
    },
  ]);
  // The delete update drops `from`'s log; step 2 already moved it away.
  await updateRef(ctx, from, zeroOid(ctx.hashConfig), { delete: true });
  const head = await readHeadRaw(ctx);
  if (head.kind === 'symbolic' && head.target === from) {
    await writeSymbolicRef(ctx, 'HEAD' as RefName, to);
  }
  return { from, to };
};

const resolveBranchTarget = async (ctx: Context, startPoint: string): Promise<ObjectId> => {
  if (isOid(startPoint, ctx.hashConfig)) return startPoint as ObjectId;
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
