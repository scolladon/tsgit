/**
 * `branch` porcelain — manage `refs/heads/*`, exposed as the `repo.branch.*`
 * nested namespace (`list` / `create` / `delete` / `rename`). Each verb is a
 * Context-aware function; the namespace binder lives in
 * `internal/branch-namespace.ts`.
 */

import { revparseAmbiguous } from '../../domain/commands/error.js';
import { TsgitError, unsupportedOperation } from '../../domain/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import { branchExists, branchNotFound, branchNotFullyMerged } from '../../domain/index.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { isOid, zeroOid } from '../../domain/objects/index.js';
import {
  branchCreatedFrom,
  branchRenamed,
  branchResetTo,
} from '../../domain/reflog/reflog-messages.js';
import { validateRefName } from '../../domain/refs/index.js';
import { HEADS_PREFIX } from '../../domain/refs/ref-prefixes.js';
import { shortBranchName } from '../../domain/refs/short-branch-name.js';
import { branchCheckedOut } from '../../domain/worktree/error.js';
import type { Context } from '../../ports/context.js';
import { peelChain } from '../primitives/internal/peel-chain.js';
import { transactionLogging } from '../primitives/internal/ref-transaction-logging.js';
import { assertRepoSettingsValid } from '../primitives/internal/repo-settings-gate.js';
import { readObject } from '../primitives/read-object.js';
import {
  getRefStore,
  type RefStore,
  type ResolveDirectResult,
  refExists,
} from '../primitives/ref-store.js';
import {
  refResolvesForReading,
  resolveRef,
  resolveRefForReading,
  resolveRefOrMissing,
} from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { branchMerged } from './internal/branch-merged.js';
import { worktreeHolding } from './internal/checked-out-branches.js';
import {
  assertOperationalRepository,
  branchRefFromHead,
  readHeadRaw,
} from './internal/repo-state.js';
import { resolveRevisionName, resolvingCandidates } from './internal/revision-name.js';

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
    // resolves through the reading walk, which drops a chain that dangles,
    // loops or runs past its cap — the entries git's own iterator omits.
    const id =
      entry.value.kind === 'direct' ? entry.value.id : await resolveRefForReading(ctx, entry.name);
    if (id === undefined) continue;
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

/**
 * The label an omitted start point carries into the reflog. git resolves
 * `HEAD` up front and hands `create_branch` the ref name it landed on with
 * `refs/heads/` stripped, so an attached HEAD types the entry with the
 * current branch's own short name; only a detached HEAD — where the
 * resolution stops at `HEAD` itself — leaves the literal behind.
 */
const omittedStartPointLabel = async (ctx: Context): Promise<string> => {
  const current = await resolveCurrentBranchTarget(ctx);
  return current === undefined ? HEAD_NAME : shortBranchName(current);
};

/**
 * git's `branch_checked_out`: a branch is off limits while ANY worktree holds
 * it — the current checkout, a linked worktree, or a linked worktree whose
 * directory is gone but whose registration has not been pruned. A worktree
 * holds the branch its HEAD names, the branch its in-progress rebase will
 * reattach, and the branch its bisect started from; a bare main checkout is
 * skipped outright, so it holds nothing. Both a forced rewrite and a delete
 * run it before anything else they would refuse on, so an unresolvable start
 * point or an unmerged tip on a held branch still reports the worktree.
 */
const assertNoWorktreeHolds = async (ctx: Context, name: RefName): Promise<void> => {
  const holder = await worktreeHolding(ctx, name);
  if (holder !== undefined) throw branchCheckedOut(name, holder);
};

/**
 * HEAD as `create_branch` resolves it when no start point was given. git
 * hands it the CURRENT branch's own resolved ref name, so the default never
 * goes through the revision ladder — and never reports ambiguity against a
 * branch literally named `HEAD`. An unborn HEAD names no object at all, and
 * the refusal carries the label git had already substituted for the start
 * point (the current branch's short name), never `HEAD`.
 */
const resolveOmittedStartPoint = async (ctx: Context, label: string): Promise<ObjectId> => {
  const id = await resolveRefOrMissing(ctx, HEAD_NAME);
  if (id === undefined) throw branchNotFound(label as RefName);
  return id;
};

export const branchCreate = async (
  ctx: Context,
  input: BranchCreateInput,
): Promise<BranchCreateResult> => {
  await assertOperationalRepository(ctx);
  const name = validateRefName(`${HEADS_PREFIX}${input.name}`);
  const force = input.force === true;
  // git's `ref_exists` answers this once and the answer is kept: it both
  // refuses an unforced clobber and types the reflog message below.
  const held = await refResolvesForReading(ctx, name);
  if (!force && held) throw branchExists(name);
  if (force && held) await assertNoWorktreeHolds(ctx, name);
  const startPoint = input.startPoint ?? (await omittedStartPointLabel(ctx));
  const start =
    input.startPoint === undefined
      ? await resolveOmittedStartPoint(ctx, startPoint)
      : await resolveBranchTarget(ctx, input.startPoint);
  const target = await requireCommit(ctx, start);
  const reflogMessage = force && held ? branchResetTo(startPoint) : branchCreatedFrom(startPoint);
  await writeNewBranch(ctx, { name, target, force, reflogMessage });
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
  await assertNoWorktreeHolds(ctx, name);
  const held = await getRefStore(ctx).resolveDirect(name);
  if (held.kind === 'missing') throw branchNotFound(name);
  if (input.force !== true) await assertFullyMerged(ctx, name, held);
  // `branch -D` deletes the symref itself when `name` names one — git's
  // own `REF_NO_DEREF` on this delete.
  await updateRef(ctx, name, zeroOid(ctx.hashConfig), { delete: true, noDeref: true });
  return { name };
};

/**
 * git's unforced safety valve. It resolves the branch with `NO_RECURSE` and
 * only runs `branch_merged` when what came back is an oid, so a branch that
 * is itself a symbolic ref is deleted unchecked however far behind its
 * target stands (measured, git 2.55.0).
 *
 * `check_branch_commit` peels that oid before the valve sees it, so a branch
 * standing on an annotated tag is measured at the commit the tag names. A tip
 * that names no commit at all never reaches the valve: git refuses on the
 * type instead of reporting the branch unmerged (measured, git 2.55.0).
 */
const assertFullyMerged = async (
  ctx: Context,
  name: RefName,
  held: ResolveDirectResult,
): Promise<void> => {
  if (held.kind !== 'direct') return;
  const tipCommit = await requireCommit(ctx, held.id);
  if (await branchMerged(ctx, name, tipCommit)) return;
  throw branchNotFullyMerged(name);
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

/** git's staging name for a log in flight across a rename
 *  (`logs/refs/.tmp-renamed-log`), the same one its own rename uses. */
const STAGED_LOG = 'refs/.tmp-renamed-log' as RefName;

/** The reftable backend's `renamedBranchLog` discriminator. */
const MERGED_RENAME_LOG = 'merge-then-delete-and-create';

/** What an appended rename entry needs. */
interface RenameEntriesInput {
  readonly from: RefName;
  readonly to: RefName;
  readonly id: ObjectId;
}

/** Whether one name is a `/`-bounded prefix of the other — the pair a
 *  directory and a file would have to occupy the same path for. */
const areNested = (from: RefName, to: RefName): boolean =>
  from.startsWith(`${to}/`) || to.startsWith(`${from}/`);

const renameBranch = async (ctx: Context, request: RenameRequest, id: ObjectId): Promise<void> => {
  const { from, to, force } = request;
  const store = getRefStore(ctx);
  if (areNested(from, to)) return renameNestedBranch(ctx, store, request, id);
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
 * git's rename order, which only a nested pair needs: the source's log is
 * moved to a staging name, the source ref deleted (carrying the first
 * `logs/HEAD` rename line while HEAD is still coupled to it), the
 * destination created on the path the delete has just freed, and the staged
 * log moved in. A destination nested with the source cannot already exist —
 * no store creates a ref under or above another — so nothing is replaced.
 */
const renameNestedBranch = async (
  ctx: Context,
  store: RefStore,
  request: RenameRequest,
  id: ObjectId,
): Promise<void> => {
  const { from, to } = request;
  // Reftable keeps its logs in the stack, where nested names never collide,
  // so the records move straight across; the files backend parks them on
  // git's own staging path, since `logs/<from>` and `logs/<to>` would need
  // the same path to be a file and a directory at once.
  const staging = transactionLogging(ctx).renamedBranchLog === MERGED_RENAME_LOG ? to : STAGED_LOG;
  await store.moveReflog(from, staging);
  await updateRef(ctx, from, zeroOid(ctx.hashConfig), {
    delete: true,
    noDeref: true,
    reflogMessage: branchRenamed(from, to),
  });
  await createRenameDestination(store, request, id);
  if (staging !== to) await store.moveReflog(staging, to);
  await appendRenameEntries(ctx, store, { from, to, id });
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

const HEAD_NAME = 'HEAD' as RefName;

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
  await appendRenameEntriesFiles(store, { from, to, id });
};

/** The files backend's own rename entry: one `<id> <id>` line. */
const appendRenameEntriesFiles = async (
  store: RefStore,
  { from, to, id }: RenameEntriesInput,
): Promise<void> => {
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
  await appendRenameEntriesReftable(ctx, store, { from, to, id });
};

/** The reftable backend's own rename entries: a delete-shaped line then a
 *  create-shaped one. */
const appendRenameEntriesReftable = async (
  ctx: Context,
  store: RefStore,
  { from, to, id }: RenameEntriesInput,
): Promise<void> => {
  const message = branchRenamed(from, to);
  const zero = zeroOid(ctx.hashConfig);
  await store.applyRefUpdates([
    { kind: 'reflogOnly', name: to, reflog: { oldId: id, newId: zero, message } },
  ]);
  await store.applyRefUpdates([
    { kind: 'reflogOnly', name: to, reflog: { oldId: zero, newId: id, message } },
  ]);
};

const appendRenameEntries = (
  ctx: Context,
  store: RefStore,
  input: RenameEntriesInput,
): Promise<void> =>
  transactionLogging(ctx).renamedBranchLog === MERGED_RENAME_LOG
    ? appendRenameEntriesReftable(ctx, store, input)
    : appendRenameEntriesFiles(store, input);

/**
 * A branch's start point, through git's revision ladder. `create_branch` is
 * the one surface that refuses an ambiguous short name rather than taking the
 * first candidate and warning — `dwim_ref` returning more than one match is
 * its `ambiguous object name` refusal.
 */
const resolveBranchTarget = async (ctx: Context, startPoint: string): Promise<ObjectId> => {
  if (isOid(startPoint, ctx.hashConfig)) return startPoint as ObjectId;
  const candidates = await resolvingCandidates(ctx, startPoint);
  if (candidates.length > 1) throw revparseAmbiguous(startPoint, candidates);
  const id = await resolveRevisionName(ctx, startPoint);
  if (id === undefined) throw branchNotFound(startPoint as RefName);
  return id;
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
