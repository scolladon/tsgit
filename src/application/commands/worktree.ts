/**
 * `worktree` porcelain — the `repo.worktree.*` nested namespace. Manages linked
 * working trees over one object store: `list` / `add` / `move` / `remove`.
 *
 * Per ADR-249 the results are structured data — `list` returns the per-worktree
 * fields (path, head oid, branch, detached, bare, locked, prunable), never a
 * rendered table. The namespace binder lives in
 * `internal/worktree-namespace.ts`.
 */

import { invalidOption } from '../../domain/commands/error.js';
import {
  type FilePath,
  type ObjectId,
  type RefName,
  ZERO_OID,
} from '../../domain/objects/index.js';
import { resetMovingTo } from '../../domain/reflog/reflog-messages.js';
import { HEADS_PREFIX } from '../../domain/refs/ref-prefixes.js';
import { ORIG_HEAD } from '../../domain/refs/state-files.js';
import {
  WORKTREE_COMMONDIR,
  type WorktreeHead,
  worktreeGitdirPointer,
  worktreeGitfile,
  worktreeHeadContent,
} from '../../domain/worktree/admin-files.js';
import { isUnsafeWorktreeId, worktreeAdminId } from '../../domain/worktree/admin-id.js';
import {
  branchCheckedOut,
  notAWorktree,
  worktreeDirty,
  worktreeLocked,
  worktreePathExists,
} from '../../domain/worktree/error.js';
import { resolveWorktreePath, worktreePathBasename } from '../../domain/worktree/resolve-path.js';
import type { Context } from '../../ports/context.js';
import { acquireIndexLock } from '../primitives/internal/index-lock.js';
import {
  deriveWorktreeContext,
  worktreeScopedFs,
} from '../primitives/internal/worktree-context.js';
import { listWorktrees, type WorktreeEntry } from '../primitives/list-worktrees.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { commonGitDir } from '../primitives/path-layout.js';
import { readIndex } from '../primitives/read-index.js';
import { readTree } from '../primitives/read-tree.js';
import { recordRefUpdate } from '../primitives/record-ref-update.js';
import { getRefStore } from '../primitives/ref-store.js';
import { branchCreate } from './branch.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { resolveCommit } from './internal/resolve-rev.js';
import { status } from './status.js';

export type { WorktreeEntry };

const HEAD_REF = 'HEAD' as RefName;

export interface WorktreeListResult {
  readonly entries: ReadonlyArray<WorktreeEntry>;
}

/**
 * List the repository's worktrees (`git worktree list`) — the main worktree
 * first, then each linked worktree sorted by path.
 */
export const worktreeList = async (ctx: Context): Promise<WorktreeListResult> => {
  await assertOperationalRepository(ctx);
  return { entries: await listWorktrees(ctx) };
};

export interface WorktreeAddOptions {
  /** Worktree-relative or absolute target directory for the new worktree. */
  readonly path: string;
  /** Start point (commit-ish); default `HEAD`. */
  readonly commitish?: string;
  /** `-b`: create this new branch at the start point. */
  readonly branch?: string;
  /** `--detach`: detached HEAD at the start point instead of a branch. */
  readonly detach?: boolean;
  /** Override the existing-branch / checked-out refusals. */
  readonly force?: boolean;
}

export interface WorktreeAddResult {
  readonly path: FilePath;
  readonly id: string;
  readonly head: ObjectId;
  /** Created/checked-out branch; absent when detached. */
  readonly branch?: RefName;
  readonly detached: boolean;
}

/** Create a new branch (`-b` / basename) at the start point. */
type CreateMode = { readonly kind: 'create'; readonly branchRef: RefName; readonly name: string };
/** Check out an existing local branch. */
type CheckoutMode = { readonly kind: 'checkout'; readonly branchRef: RefName };
/** Detached HEAD at the start point. */
type DetachedMode = { readonly kind: 'detached' };
type AddMode = CreateMode | CheckoutMode | DetachedMode;

/** Refuse when the target directory already exists and is not empty. */
const assertTargetFree = async (ctx: Context, worktreePath: string): Promise<void> => {
  const wfs = worktreeScopedFs(ctx, worktreePath);
  if (!(await wfs.exists(worktreePath))) return;
  if ((await wfs.readdir(worktreePath)).length > 0) throw worktreePathExists(worktreePath);
};

/** Resolve which kind of HEAD the new worktree gets. */
const decideMode = async (
  ctx: Context,
  opts: WorktreeAddOptions,
  worktreePath: string,
): Promise<AddMode> => {
  if (opts.branch !== undefined) {
    return {
      kind: 'create',
      branchRef: `${HEADS_PREFIX}${opts.branch}` as RefName,
      name: opts.branch,
    };
  }
  if (opts.detach === true) return { kind: 'detached' };
  if (opts.commitish !== undefined) {
    const branchRef = `${HEADS_PREFIX}${opts.commitish}` as RefName;
    if ((await getRefStore(ctx).resolveDirect(branchRef)).kind === 'direct') {
      return { kind: 'checkout', branchRef };
    }
    return { kind: 'detached' };
  }
  const name = worktreePathBasename(worktreePath);
  return { kind: 'create', branchRef: `${HEADS_PREFIX}${name}` as RefName, name };
};

/** Refuse checking out a branch already used by another worktree. */
const assertBranchFree = async (
  ctx: Context,
  branchRef: RefName,
  force: boolean,
): Promise<void> => {
  if (force) return;
  const used = (await listWorktrees(ctx)).find((entry) => entry.branch === branchRef);
  if (used !== undefined) throw branchCheckedOut(branchRef, used.path);
};

/** Allocate the admin id for the new worktree, deduplicated against existing ones. */
const allocateAdminId = async (ctx: Context, worktreePath: string): Promise<string> => {
  const root = `${commonGitDir(ctx)}/worktrees`;
  const taken = (await ctx.fs.exists(root))
    ? (await ctx.fs.readdir(root)).filter((entry) => entry.isDirectory).map((entry) => entry.name)
    : [];
  return worktreeAdminId(worktreePathBasename(worktreePath), new Set(taken));
};

/** Write the admin pointer files + the worktree `.git` gitfile. Returns the admin dir. */
const writeAdmin = async (
  ctx: Context,
  id: string,
  worktreePath: string,
  head: WorktreeHead,
  oid: ObjectId,
): Promise<string> => {
  const admin = `${commonGitDir(ctx)}/worktrees/${id}`;
  await ctx.fs.writeUtf8(`${admin}/commondir`, `${WORKTREE_COMMONDIR}\n`);
  await ctx.fs.writeUtf8(`${admin}/gitdir`, `${worktreeGitdirPointer(worktreePath)}\n`);
  await ctx.fs.writeUtf8(`${admin}/HEAD`, `${worktreeHeadContent(head)}\n`);
  await ctx.fs.writeUtf8(`${admin}/${ORIG_HEAD}`, `${oid}\n`);
  await worktreeScopedFs(ctx, worktreePath).writeUtf8(
    `${worktreePath}/.git`,
    `${worktreeGitfile(admin)}\n`,
  );
  return admin;
};

/** Check out the start tree into the worktree, writing the per-worktree index. */
const materializeWorktree = async (child: Context, treeId: ObjectId): Promise<void> => {
  const lock = await acquireIndexLock(child);
  try {
    const currentIndex = await readIndex(child);
    const result = await materializeTree(child, { targetTree: treeId, currentIndex });
    await lock.commit(result.newIndexEntries);
  } finally {
    await lock.release();
  }
};

/**
 * Write the worktree `logs/HEAD`. git logs an empty-message HEAD set, then —
 * when HEAD is a branch (or an existing branch checkout) — a `reset: moving to
 * HEAD` entry; a detached add logs only the first.
 */
const writeHeadReflog = async (child: Context, mode: AddMode, oid: ObjectId): Promise<void> => {
  await recordRefUpdate(child, HEAD_REF, ZERO_OID, oid, '');
  if (mode.kind !== 'detached') {
    await recordRefUpdate(child, HEAD_REF, oid, oid, resetMovingTo('HEAD'));
  }
};

/**
 * Create a linked worktree (`git worktree add`). Resolves the start point,
 * decides the mode (new branch from `-b`/the path basename, checkout of an
 * existing branch, or detached), creates the branch when needed, lays down the
 * admin pointer files + the `.git` gitfile, and materialises the working tree +
 * per-worktree index. Refuses a non-empty target, an existing branch (without
 * force), or a branch already used by another worktree (without force).
 */
export const worktreeAdd = async (
  ctx: Context,
  opts: WorktreeAddOptions,
): Promise<WorktreeAddResult> => {
  await assertOperationalRepository(ctx);
  if (opts.path === '') throw worktreePathExists('');
  const worktreePath = resolveWorktreePath(ctx.cwd, opts.path) as FilePath;
  // Defence in depth: the admin id is the path basename, joined onto
  // `worktrees/<id>`. A normalised path basename can never contain `/` or `..`,
  // but an empty basename (a path resolving to the filesystem root) would yield
  // an unusable id — reject it up front.
  if (isUnsafeWorktreeId(worktreePathBasename(worktreePath))) {
    throw invalidOption('worktree add', `invalid worktree path '${opts.path}'`);
  }
  await assertTargetFree(ctx, worktreePath);
  const oid = await resolveCommit(ctx, opts.commitish ?? 'HEAD');
  const tree = await readTree(ctx, oid);
  const mode = await decideMode(ctx, opts, worktreePath);
  if (mode.kind === 'checkout') await assertBranchFree(ctx, mode.branchRef, opts.force === true);
  if (mode.kind === 'create') {
    await branchCreate(ctx, {
      name: mode.name,
      startPoint: opts.commitish ?? 'HEAD',
      force: opts.force === true,
    });
  }
  const head: WorktreeHead =
    mode.kind === 'detached' ? { kind: 'detached', oid } : { kind: 'branch', ref: mode.branchRef };
  const id = await allocateAdminId(ctx, worktreePath);
  await writeAdmin(ctx, id, worktreePath, head, oid);
  const child = deriveWorktreeContext(ctx, id, worktreePath);
  await materializeWorktree(child, tree.id);
  await writeHeadReflog(child, mode, oid);
  return {
    path: worktreePath,
    id,
    head: oid,
    detached: mode.kind === 'detached',
    ...(mode.kind !== 'detached' ? { branch: mode.branchRef } : {}),
  };
};

/** A linked worktree entry resolved by path (carries its admin id). */
interface LinkedWorktree extends WorktreeEntry {
  readonly id: string;
}

/**
 * Resolve the linked worktree at `worktreePath`. Refuses the main worktree
 * (`INVALID_OPTION`) and an unknown path (`NOT_A_WORKTREE`).
 */
const resolveLinked = async (
  ctx: Context,
  worktreePath: string,
  verb: string,
): Promise<LinkedWorktree> => {
  const entry = (await listWorktrees(ctx)).find((candidate) => candidate.path === worktreePath);
  if (entry === undefined) throw notAWorktree(worktreePath);
  // Stryker disable next-line LogicalOperator: equivalent — every listWorktrees entry has entry.main === (entry.id === undefined) (the main entry never carries an id, a linked entry always does), so && and || select the identical rows
  if (entry.main || entry.id === undefined) {
    throw invalidOption(`worktree ${verb}`, 'cannot operate on the main working tree');
  }
  return entry as LinkedWorktree;
};

/** Refuse a locked worktree unless forced. */
const assertUnlocked = (entry: WorktreeEntry, force: boolean): void => {
  if (entry.locked !== undefined && !force) throw worktreeLocked(entry.path, entry.locked.reason);
};

export interface WorktreeMoveOptions {
  /** Move even when the worktree is locked. */
  readonly force?: boolean;
}

export interface WorktreeMoveResult {
  readonly from: FilePath;
  readonly to: FilePath;
  readonly id: string;
}

/**
 * Relocate a linked worktree (`git worktree move`). Renames the worktree
 * directory and re-points the admin `gitdir` file at the new `.git` location;
 * the `.git` gitfile itself moves with the directory and still points at the
 * (unchanged) admin dir. Refuses a locked worktree (without force), a non-empty
 * destination, the main worktree, or a non-worktree source.
 */
export const worktreeMove = async (
  ctx: Context,
  from: string,
  to: string,
  opts: WorktreeMoveOptions = {},
): Promise<WorktreeMoveResult> => {
  await assertOperationalRepository(ctx);
  const fromPath = resolveWorktreePath(ctx.cwd, from) as FilePath;
  const toPath = resolveWorktreePath(ctx.cwd, to) as FilePath;
  const entry = await resolveLinked(ctx, fromPath, 'move');
  assertUnlocked(entry, opts.force === true);
  await assertTargetFree(ctx, toPath);
  await worktreeScopedFs(ctx, [fromPath, toPath]).rename(fromPath, toPath);
  const admin = `${commonGitDir(ctx)}/worktrees/${entry.id}`;
  await ctx.fs.writeUtf8(`${admin}/gitdir`, `${worktreeGitdirPointer(toPath)}\n`);
  return { from: fromPath, to: toPath, id: entry.id };
};

export interface WorktreeRemoveOptions {
  /** Remove even when the worktree is dirty or locked. */
  readonly force?: boolean;
}

export interface WorktreeRemoveResult {
  readonly path: FilePath;
  readonly id: string;
}

/**
 * Remove a linked worktree (`git worktree remove`). Refuses a locked worktree or
 * one with modified/untracked files (without force), then deletes the worktree
 * directory and its admin dir. The branch is left intact. Refuses the main
 * worktree or a non-worktree path.
 */
export const worktreeRemove = async (
  ctx: Context,
  path: string,
  opts: WorktreeRemoveOptions = {},
): Promise<WorktreeRemoveResult> => {
  await assertOperationalRepository(ctx);
  const worktreePath = resolveWorktreePath(ctx.cwd, path) as FilePath;
  const entry = await resolveLinked(ctx, worktreePath, 'remove');
  assertUnlocked(entry, opts.force === true);
  if (opts.force !== true) {
    const child = deriveWorktreeContext(ctx, entry.id, worktreePath);
    if (!(await status(child)).clean) throw worktreeDirty(worktreePath);
  }
  await worktreeScopedFs(ctx, worktreePath).rmRecursive(worktreePath);
  await ctx.fs.rmRecursive(`${commonGitDir(ctx)}/worktrees/${entry.id}`);
  return { path: worktreePath, id: entry.id };
};
