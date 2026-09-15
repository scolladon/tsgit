/**
 * `branch` porcelain — manage `refs/heads/*`, exposed as the `repo.branch.*`
 * nested namespace (`list` / `create` / `delete` / `rename`). Each verb is a
 * Context-aware function; the namespace binder lives in
 * `internal/branch-namespace.ts`.
 */
import { TsgitError, unsupportedOperation } from '../../domain/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import { branchExists, branchNotFound, cannotDeleteCheckedOutBranch } from '../../domain/index.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { isOid, zeroOid } from '../../domain/objects/index.js';
import { branchCreatedFrom, branchRenamed } from '../../domain/reflog/reflog-messages.js';
import { validateRefName } from '../../domain/refs/index.js';
import { HEADS_PREFIX } from '../../domain/refs/ref-prefixes.js';
import type { Context } from '../../ports/context.js';
import { peelChain } from '../primitives/internal/peel-chain.js';
import { transactionLogging } from '../primitives/internal/ref-transaction-logging.js';
import { assertRepoSettingsValid } from '../primitives/internal/repo-settings-gate.js';
import { readObject } from '../primitives/read-object.js';
import { getRefStore, type RefStore, refExists } from '../primitives/ref-store.js';
import { refResolvesForReading, resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
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
  const force = input.force === true;
  if (!force && (await refResolvesForReading(ctx, name))) throw branchExists(name);
  const startPoint = input.startPoint ?? 'HEAD';
  const target = await requireCommit(ctx, await resolveBranchTarget(ctx, startPoint));
  await writeNewBranch(ctx, { name, target, force, reflogMessage: branchCreatedFrom(startPoint) });
  return { name, id: target };
};

interface NewBranch {
  readonly name: RefName;
  readonly target: ObjectId;
  readonly force: boolean;
  readonly reflogMessage: string;
}

/** Points `name` at `target`, mapping the compare-and-swap conflict of an
 *  unforced creation to the faithful `BRANCH_EXISTS`. */
const writeNewBranch = async (ctx: Context, branch: NewBranch): Promise<void> => {
  const { name, target, force, reflogMessage } = branch;
  try {
    await updateRef(
      ctx,
      name,
      target,
      force ? { reflogMessage } : { expected: 'absent', reflogMessage },
    );
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_UPDATE_CONFLICT') {
      throw branchExists(name);
    }
    throw err;
  }
};

export const branchDelete = async (
  ctx: Context,
  input: BranchDeleteInput,
): Promise<BranchDeleteResult> => {
  await assertOperationalRepository(ctx);
  await assertRepoSettingsValid(ctx);
  const name = validateRefName(`${HEADS_PREFIX}${input.name}`);
  const head = await readHeadRaw(ctx);
  if (head.kind === 'symbolic' && head.target === name) {
    throw cannotDeleteCheckedOutBranch(name);
  }
  if (!(await refExists(ctx, name))) {
    throw branchNotFound(name);
  }
  // `branch -D` deletes the symref itself when `name` names one — git's
  // own `REF_NO_DEREF` on this delete.
  await updateRef(ctx, name, zeroOid(ctx.hashConfig), { delete: true, noDeref: true });
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
  const request: RenameRequest = { from, to, force: input.force === true };
  await assertRenameAllowed(ctx, request);
  await (from === to ? renameOntoItself(ctx, request, id) : renameBranch(ctx, request, id));
  return { from, to };
};

/**
 * git accepts a self-rename (`branch -m x x` and `-M x x` both exit 0): the
 * ref and its log stay put and only the rename entry is appended. Without
 * this arm the trailing delete of a real rename would remove the branch that
 * was just "renamed" onto itself.
 */
const renameOntoItself = async (
  ctx: Context,
  { from, to }: RenameRequest,
  id: ObjectId,
): Promise<void> => {
  const message = branchRenamed(from, to);
  await getRefStore(ctx).applyRefUpdates([
    { kind: 'reflogOnly', name: to, reflog: { oldId: id, newId: id, message } },
  ]);
};

const renameBranch = async (ctx: Context, request: RenameRequest, id: ObjectId): Promise<void> => {
  const { from, to, force } = request;
  const store = getRefStore(ctx);
  // Probed BEFORE the CAS set below makes `to` exist: git's forced rename
  // deletes the destination ref first, which drops its log; an orphan log
  // with no live ref underneath survives and takes the rename entry as an
  // append (measured, git 2.55.0).
  const replacesLiveRef = force && (await refExists(ctx, to));
  await createRenameDestination(store, request, id);
  await writeRenamedBranchLog(ctx, store, { from, to, id, replacesLiveRef });
  // The delete update drops `from`'s log; the log write already moved it. HEAD
  // is still coupled to `from` here (unmoved), so this delete carries git's
  // FIRST `logs/HEAD` rename line when HEAD names the branch being renamed.
  await updateRef(ctx, from, zeroOid(ctx.hashConfig), {
    delete: true,
    noDeref: true,
    reflogMessage: branchRenamed(from, to),
  });
  await repointHeadAfterRename(ctx, store, request, id);
};

/**
 * Writes `to` — refusing `BRANCH_EXISTS` through the compare-and-swap unless
 * forced. The check runs BEFORE any log move: git checks and refuses before
 * touching anything. The failure window differs from git's: a throw after
 * the log move leaves `from` a live branch whose log already moved to `to`,
 * where git stages the log through a temp path and rolls back.
 */
const createRenameDestination = async (
  store: RefStore,
  { to, force }: RenameRequest,
  id: ObjectId,
): Promise<void> => {
  try {
    await store.applyRefUpdates([
      { kind: 'set', name: to, id, ...(force ? {} : { expected: 'absent' as const }) },
    ]);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_UPDATE_CONFLICT') {
      throw branchExists(to);
    }
    throw err;
  }
};

/** The re-point is git's SECOND `logs/HEAD` rename line: the old id is null
 *  because `from` is already gone. */
const repointHeadAfterRename = async (
  ctx: Context,
  store: RefStore,
  { from, to }: RenameRequest,
  id: ObjectId,
): Promise<void> => {
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic' || head.target !== from) return;
  const reflog = { oldId: zeroOid(ctx.hashConfig), newId: id, message: branchRenamed(from, to) };
  await store.applyRefUpdates([
    { kind: 'setSymbolic', name: 'HEAD' as RefName, target: to, reflog },
  ]);
};

const BRANCH_RENAME = 'branch.rename';

interface RenameRequest {
  readonly from: RefName;
  readonly to: RefName;
  readonly force: boolean;
}

/**
 * git's own pre-checks, in its order, before anything changes: an unforced
 * rename onto a distinct destination that resolves for reading — a live
 * symbolic ref included, a dangling one not — refuses "already exists";
 * then a symbolic source refuses, itself included (measured, git 2.55.0:
 * `branch -m a y` with `y → main` and `branch -m sym y` report `y` exists,
 * `branch -M sym y` and `branch -m sym sym` report the symbolic ref).
 */
const assertRenameAllowed = async (ctx: Context, request: RenameRequest): Promise<void> => {
  const { from, to, force } = request;
  if (from !== to && !force && (await refResolvesForReading(ctx, to))) throw branchExists(to);
  if ((await getRefStore(ctx).resolveDirect(from)).kind !== 'symbolic') return;
  throw unsupportedOperation(BRANCH_RENAME, `refname ${from} is a symbolic ref`);
};

interface RenamedBranchLogInput {
  readonly from: RefName;
  readonly to: RefName;
  readonly id: ObjectId;
  readonly replacesLiveRef: boolean;
}

/**
 * Writes the RENAMED branch's own log — shaped per backend.
 */
const writeRenamedBranchLog = async (
  ctx: Context,
  store: RefStore,
  input: RenamedBranchLogInput,
): Promise<void> =>
  transactionLogging(ctx).renamedBranchLog === 'merge-then-delete-and-create'
    ? writeRenamedBranchLogReftable(ctx, store, input)
    : writeRenamedBranchLogFiles(store, input);

/**
 * Files backend: a forced rename replaces the destination's history first
 * (dropping its log), the source's log moves in byte-preserving (never
 * parsed), then one `<id> <id>` rename entry is appended.
 */
const writeRenamedBranchLogFiles = async (
  store: RefStore,
  { from, to, id, replacesLiveRef }: RenamedBranchLogInput,
): Promise<void> => {
  if (replacesLiveRef) {
    await store.applyRefUpdates([{ kind: 'reflogReplace', name: to, entries: [] }]);
  }
  await store.moveReflog(from, to);
  const message = branchRenamed(from, to);
  await store.applyRefUpdates([
    { kind: 'reflogOnly', name: to, reflog: { oldId: id, newId: id, message } },
  ]);
};

/**
 * Reftable backend: the destination is never dropped — `moveReflog` merges
 * the source's live records under `to` at their own update indices — then
 * git's own reftable delete-then-create shape appends `<id> 0{40}` followed
 * by `0{40} <id>`, each its OWN transaction: two `reflogOnly` entries for
 * the SAME name in one `applyRefUpdates` call would share one update
 * index, and the second would silently shadow the first at that key.
 */
const writeRenamedBranchLogReftable = async (
  ctx: Context,
  store: RefStore,
  { from, to, id }: RenamedBranchLogInput,
): Promise<void> => {
  await store.moveReflog(from, to);
  const message = branchRenamed(from, to);
  const zero = zeroOid(ctx.hashConfig);
  await store.applyRefUpdates([
    { kind: 'reflogOnly', name: to, reflog: { oldId: id, newId: zero, message } },
  ]);
  await store.applyRefUpdates([
    { kind: 'reflogOnly', name: to, reflog: { oldId: zero, newId: id, message } },
  ]);
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

/**
 * Peels `id` through any tag objects to the commit it names (git's
 * `lookup_commit_reference`), bounded by `MAX_PEEL_DEPTH` — the same shared
 * walker `readTree`/`peelToTree` use, so a hostile repository's self- or
 * mutually-referential tag chain refuses with `REF_CHAIN_TOO_DEEP` instead of
 * looping forever. The refusal keeps `id` as resolved — an annotated tag's
 * own oid, never its target — because that is the oid git's `error: object
 * <oid> is a <type>, not a commit` reports (measured, git 2.55.0); only
 * `actual` reflects the fully peeled type.
 */
const requireCommit = async (ctx: Context, id: ObjectId): Promise<ObjectId> => {
  const { id: peeledId, result } = await peelChain(ctx, id, readObject, (object) =>
    object.type === 'tag' ? object.data.object : undefined,
  );
  if (result.type !== 'commit') throw unexpectedObjectType('commit', result.type, id);
  return peeledId;
};
