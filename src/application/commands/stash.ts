/**
 * `stash` porcelain — save the working tree + index onto the `refs/stash`
 * stack and restore it later, faithful to `git stash`. The saved W/I/U commit
 * trio, the reflog stack, and the post-push clean working tree read back
 * identically to canonical git.
 *
 * @writes
 *   surface: stash
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */
import {
  noInitialCommit,
  stashApplyWouldOverwrite,
  workingTreeFileTooLarge,
} from '../../domain/commands/error.js';
import type { EolSettings } from '../../domain/eol/crlf-action.js';
import type { EolNotice } from '../../domain/eol/crlf-conversion.js';
import { TsgitError } from '../../domain/error.js';
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import { indexPathKey, keyOfPath } from '../../domain/git-index/index-path-key.js';
import { validateTreePath } from '../../domain/git-index/path-validator.js';
import { abbreviateOid, type ConflictType, STASH_LABELS } from '../../domain/merge/index.js';
import { subjectLine } from '../../domain/objects/commit-message.js';
import { hasEscapedBytes } from '../../domain/objects/encoding.js';
import { invalidCommit, unexpectedObjectType } from '../../domain/objects/error.js';
import { deriveWorkingMode, type FilePath, type ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { FileStat } from '../../ports/file-system.js';
import { applyMergeToWorktree, mergeTreesToTree } from '../primitives/apply-merge-to-worktree.js';
import { buildIndexFromTree } from '../primitives/build-index-from-tree.js';
import {
  compareWorkingTreeEntry,
  type WorkingTreeComparison,
} from '../primitives/compare-working-tree-entry.js';
import { createCommit } from '../primitives/create-commit.js';
import { flattenTree } from '../primitives/flatten-tree.js';
import { hashBlob } from '../primitives/hash-blob.js';
import {
  admitWrite,
  type CleanOrder,
  configuresFilterDriver,
  firstFailureOrValues,
  inIndexOrder,
  type OrderSpan,
  settleInCleanTurn,
  withCleanOrder,
} from '../primitives/internal/clean-order.js';
import { boundedMapFor, limiterFor } from '../primitives/internal/concurrency.js';
import { convertToGit } from '../primitives/internal/convert-blob.js';
import type { IndexLock } from '../primitives/internal/index-lock.js';
import { joinPath } from '../primitives/internal/join-working-tree-path.js';
import { lazily } from '../primitives/internal/lazily.js';
import { pathIsOccupied } from '../primitives/internal/path-occupied.js';
import {
  type AttributeProvider,
  attributeBlobLookup,
  buildAttributeProvider,
  buildCheckinAttributeProvider,
} from '../primitives/internal/read-gitattributes.js';
import { assertRepoSettingsValid } from '../primitives/internal/repo-settings-gate.js';
import {
  assertNoPendingOperation,
  assertOperationalRepository,
  type HeadState,
  readHeadRaw,
  requireWorkTree,
} from '../primitives/internal/repo-state.js';
import { createLeadingPathScanner } from '../primitives/internal/symlinked-leading-path.js';
import { stage0Entry } from '../primitives/internal/synthetic-index-entry.js';
import {
  createWorkingTreeWriter,
  type WorkingTreeWriter,
} from '../primitives/internal/write-converted-entry.js';
import { removeWorkingTreeFile } from '../primitives/internal/write-working-tree-file.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { resolveReflogIdentity } from '../primitives/reflog-identity.js';
import { readEolSettings, resolveConversion } from '../primitives/resolve-conversion.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import {
  dropStashEntry,
  pushStashRef,
  readStashStack,
  resolveStashEntry,
  type StashDropResult,
  type StashStackEntry,
} from '../primitives/stash-ref.js';
import { synthesizeTreeFromIndex } from '../primitives/synthesize-tree-from-index.js';
import { MAX_WORKING_TREE_BLOB_BYTES } from '../primitives/types.js';
import { walkWorkingTree } from '../primitives/walk-working-tree.js';
import { buildRepoIgnorePredicate } from './internal/build-ignore-evaluator.js';
import { acquireIndexLock } from './internal/index-update.js';
import { takeMergeAutostash } from './internal/merge-autostash.js';
import { toConflictList } from './internal/replay-sequence.js';
import {
  indexMessage,
  onMessage,
  stashBranchLabel,
  untrackedMessage,
  wipMessage,
} from './internal/stash-message.js';
import { rejectUnmergedIndex } from './internal/unmerged-index.js';
import { unstageChangesUnlessNew } from './internal/unstage-changes-unless-new.js';

export type { ConflictType } from '../../domain/merge/index.js';

export interface StashPushInput {
  readonly message?: string;
  readonly includeUntracked?: boolean;
  readonly keepIndex?: boolean;
}

export type StashPushResult =
  | {
      readonly kind: 'saved';
      readonly stash: ObjectId;
      readonly message: string;
      readonly eolNotices: ReadonlyArray<EolNotice>;
    }
  | { readonly kind: 'no-local-changes' };

const REASON_NOT_A_STASH_COMMIT = 'ref does not point at a stash commit';

interface BaseState {
  readonly b: ObjectId;
  readonly bTree: ObjectId;
  readonly branchRef: string | undefined;
  readonly subject: string;
}

const commitTreeOf = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> => {
  const obj = await readObject(ctx, commitId);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, commitId);
  return obj.data.tree;
};

/** Resolve HEAD to its commit oid, or refuse on an unborn branch. */
const resolveHeadCommit = async (ctx: Context, head: HeadState): Promise<ObjectId> => {
  if (head.kind === 'direct') return head.id;
  try {
    return await resolveRef(ctx, head.target);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_NOT_FOUND') throw noInitialCommit();
    throw err;
  }
};

/** Resolve HEAD to the base commit's id, tree, branch label, and subject (one read). */
const resolveBase = async (ctx: Context, head: HeadState): Promise<BaseState> => {
  const b = await resolveHeadCommit(ctx, head);
  const obj = await readObject(ctx, b);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, b);
  return {
    b,
    bTree: obj.data.tree,
    branchRef: head.kind === 'symbolic' ? head.target : undefined,
    subject: subjectLine(obj.data.message),
  };
};

/** What converts a path on its way into the repository: its attributes and the eol settings. */
interface ConversionScope {
  readonly provider: AttributeProvider;
  readonly settings: EolSettings;
}

interface HashedFile {
  readonly id: ObjectId;
  readonly mode: ReturnType<typeof deriveWorkingMode>;
  readonly notice?: EolNotice;
}

const buildConversionScope = async (ctx: Context): Promise<ConversionScope> => ({
  provider: await buildCheckinAttributeProvider(ctx),
  settings: await readEolSettings(ctx),
});

/** The blob bytes git stores for a work-tree file: symlink targets verbatim, files cleaned. */
const cleanedContent = async (
  ctx: Context,
  abs: string,
  request: HashRequest,
): Promise<{ readonly bytes: Uint8Array; readonly notice?: EolNotice }> => {
  const { path, stat, scope, indexBlob } = request;
  // The cap binds the raw file: conversion must not run on bytes add would refuse.
  if (stat.size > MAX_WORKING_TREE_BLOB_BYTES) {
    throw workingTreeFileTooLarge(path, stat.size, MAX_WORKING_TREE_BLOB_BYTES);
  }
  if (stat.isSymbolicLink) return { bytes: new TextEncoder().encode(await ctx.fs.readlink(abs)) };
  const conversion = await resolveConversion(ctx, scope.provider, path, scope.settings, {
    eagerSectionValidation: true,
  });
  return convertToGit(ctx, {
    path,
    bytes: await ctx.fs.read(abs),
    conversion,
    route: 'write',
    settings: scope.settings,
    ...(indexBlob !== undefined && { indexBlob }),
  });
};

interface HashRequest {
  readonly path: FilePath;
  readonly stat: FileStat;
  readonly scope: ConversionScope;
  /** The stage-0 blob, for git's index-CRLF rule; absent for untracked files. */
  readonly indexBlob?: ObjectId;
}

const hashFileAt = async (
  ctx: Context,
  workDir: string,
  request: HashRequest,
): Promise<HashedFile> => {
  await admitWrite(ctx, request.path);
  const { bytes, notice } = await cleanedContent(ctx, joinPath(workDir, request.path), request);
  const id = await hashBlob(ctx, bytes, { write: true });
  const mode = deriveWorkingMode(request.stat);
  return notice === undefined ? { id, mode } : { id, mode, notice };
};

interface WorkingTreeProjection {
  readonly entries: ReadonlyArray<IndexEntry>;
  readonly eolNotices: ReadonlyArray<EolNotice>;
}

interface TrackedEntry {
  readonly entry: IndexEntry;
  readonly state: WorkingTreeComparison;
}

/** One entry against its work-tree file; a conflicted stage is not a tracked file to compare. */
const classifyEntry = async (
  ctx: Context,
  entry: IndexEntry,
  provider: AttributeProvider,
  indexMtime: GitIndex['indexMtime'],
): Promise<TrackedEntry | undefined> => {
  // Stryker disable next-line ConditionalExpression: equivalent — a non-conflicted index (the only state stash push reaches) carries no stage!=0 entries, so this skip is never taken; the `if(true)` variant that drops every entry is killed by the W-tree-content tests.
  if (entry.flags.stage !== 0) return undefined;
  // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — a non-sparse index has no skip-worktree entries, so this verbatim-keep branch is never taken; the `if(true)` variant (keep stale id instead of re-hashing) is killed by the modified-content tests.
  if (entry.flags.skipWorktree) return { entry, state: 'unchanged' };
  return { entry, state: await compareWorkingTreeEntry(ctx, entry, provider, indexMtime) };
};

/**
 * Compare every stage-0 entry with its work-tree file, without hashing anything for the stash.
 * The comparisons fan out through the `ioBound` bucket; a clean driver, when one is configured,
 * still hears the paths in index order.
 */
const classifyTracked = async (
  ctx: Context,
  index: GitIndex,
  provider: AttributeProvider,
): Promise<ReadonlyArray<TrackedEntry>> => {
  const classify = (order?: CleanOrder) =>
    boundedMapFor(ctx, 'ioBound', index.entries, async (entry) => {
      try {
        return await classifyEntry(ctx, entry, provider, index.indexMtime);
      } finally {
        order?.release(entry.path);
      }
    });
  const classified = (await configuresFilterDriver(ctx))
    ? await inIndexOrder(ctx, index.entries, classify)
    : await classify();
  return classified.filter((tracked) => tracked !== undefined);
};

/**
 * Runs `task` over `items` through the `ioBound` pool, a clean driver hearing the paths in
 * input order however the reads race. Every task settles, then the earliest failure in input
 * order is rethrown: no later path is converted or written once an earlier one refused.
 */
const inInputOrder = async <T, R>(
  ctx: Context,
  scope: ConversionScope,
  items: ReadonlyArray<{ readonly path: FilePath; readonly item: T }>,
  task: (item: T) => Promise<R>,
): Promise<R[]> => {
  // git converts and writes one path at a time, dying at the first loss, under safecrlf=true.
  const span: OrderSpan = scope.settings.safeCrlf === true ? 'write' : 'clean';
  const settled = await withCleanOrder(
    ctx,
    (order) => {
      const limiter = limiterFor(ctx, 'ioBound');
      for (const { path } of items) order.enlist(path);
      return Promise.all(
        items.map(({ path, item }) => settleInCleanTurn(limiter, order, path, () => task(item))),
      );
    },
    span,
  );
  return firstFailureOrValues(settled);
};

interface Hashed {
  readonly entry: IndexEntry | undefined;
  readonly notice: EolNotice | undefined;
}

const projectEntry = async (
  ctx: Context,
  workDir: string,
  scope: ConversionScope,
  { entry, state }: TrackedEntry,
): Promise<Hashed> => {
  if (state === 'absent') return { entry: undefined, notice: undefined };
  if (state === 'unchanged') return { entry, notice: undefined };
  const stat = await ctx.fs.lstat(joinPath(workDir, entry.path));
  const { id, mode, notice } = await hashFileAt(ctx, workDir, {
    path: entry.path,
    stat,
    scope,
    indexBlob: entry.id,
  });
  return { entry: stage0Entry(entry.path, id, mode), notice };
};

/** Project the classified entries onto their working-tree content (the W tree). */
const projectWorkingTree = async (
  ctx: Context,
  workDir: string,
  tracked: ReadonlyArray<TrackedEntry>,
  scope: ConversionScope,
): Promise<WorkingTreeProjection> => {
  const items = tracked.map((t) => ({ path: t.entry.path, item: t }));
  const projected = await inInputOrder(ctx, scope, items, (t) =>
    projectEntry(ctx, workDir, scope, t),
  );
  return assembled(projected);
};

const assembled = (hashed: ReadonlyArray<Hashed>): WorkingTreeProjection => ({
  entries: hashed.flatMap(({ entry }) => (entry === undefined ? [] : [entry])),
  eolNotices: hashed.flatMap(({ notice }) => (notice === undefined ? [] : [notice])),
});

interface UntrackedProjection {
  readonly paths: ReadonlyArray<FilePath>;
  readonly entries: ReadonlyArray<IndexEntry>;
  readonly eolNotices: ReadonlyArray<EolNotice>;
}

interface UntrackedFile {
  readonly path: FilePath;
  readonly stat: FileStat;
}

/** What `stash push` found to save, before any object is written for it. */
interface LocalChanges {
  readonly iTree: ObjectId;
  readonly scope: ConversionScope;
  readonly tracked: ReadonlyArray<TrackedEntry>;
  readonly untrackedFiles: ReadonlyArray<UntrackedFile>;
}

const findLocalChanges = async (ctx: Context, opts: StashPushInput): Promise<LocalChanges> => {
  const index = await readIndex(ctx);
  const iTree = await synthesizeTreeFromIndex(ctx, index.entries);
  const scope = await buildConversionScope(ctx);
  const tracked = await classifyTracked(ctx, index, scope.provider);
  const untrackedFiles = opts.includeUntracked ? await listUntracked(ctx, index) : [];
  return { iTree, scope, tracked, untrackedFiles };
};

const hasLocalChanges = (found: LocalChanges, base: BaseState): boolean =>
  found.iTree !== base.bTree ||
  found.tracked.some(({ state }) => state !== 'unchanged') ||
  found.untrackedFiles.length > 0;

const listUntracked = async (
  ctx: Context,
  index: GitIndex,
): Promise<ReadonlyArray<UntrackedFile>> => {
  const tracked = new Set(index.entries.map(indexPathKey));
  const ignore = await buildRepoIgnorePredicate(ctx);
  const files: UntrackedFile[] = [];
  for await (const { path, stat } of walkWorkingTree(ctx, { ignore })) {
    if (tracked.has(keyOfPath(path))) continue;
    files.push({ path, stat: await stat() });
  }
  return files;
};

const hashUntracked = async (
  ctx: Context,
  workDir: string,
  files: ReadonlyArray<UntrackedFile>,
  scope: ConversionScope,
): Promise<UntrackedProjection> => {
  const items = files.map((file) => ({ path: file.path, item: file }));
  const hashed = await inInputOrder(ctx, scope, items, async ({ path, stat }) => {
    const { id, mode, notice } = await hashFileAt(ctx, workDir, { path, stat, scope });
    return { entry: stage0Entry(path, id, mode), notice };
  });
  return { paths: files.map((file) => file.path), ...assembled(hashed) };
};

/**
 * `stash`'s own `prepare_repo_settings` prologue (git's `stash.c:2488`, top of
 * `cmd_stash`): the gate, then the work-tree requirement, then the
 * repo-settings class, in THAT order — git's `NEED_WORK_TREE` runs in
 * `run_builtin` ahead of `cmd_stash` itself, so a bare repo's `stash list`
 * dies on the missing work tree, not the class.
 */
const gateStash = async (ctx: Context, operation: string): Promise<string> => {
  await assertOperationalRepository(ctx);
  const workDir = requireWorkTree(ctx, operation);
  await assertRepoSettingsValid(ctx);
  return workDir;
};

export const stashPush = async (
  ctx: Context,
  opts: StashPushInput = {},
): Promise<StashPushResult> => {
  const workDir = await gateStash(ctx, 'stash');
  await assertNoPendingOperation(ctx);
  return stashAndReset(ctx, workDir, opts, (w) => pushStashRef(ctx, w.stash, w.message));
};

/** git's `stash create` then `reset --hard`: the local changes as an unrecorded stash. */
export const createAutostash = async (ctx: Context): Promise<ObjectId | undefined> => {
  const workDir = requireWorkTree(ctx, 'rebase');
  const result = await stashAndReset(ctx, workDir, { message: AUTOSTASH }, async () => {});
  return result.kind === 'saved' ? result.stash : undefined;
};

const AUTOSTASH = 'autostash';

/** Snapshot the local changes into stash commits, `record` them, then reset the tree. */
const stashAndReset = async (
  ctx: Context,
  workDir: string,
  opts: StashPushInput,
  record: (w: { readonly stash: ObjectId; readonly message: string }) => Promise<void>,
): Promise<StashPushResult> => {
  const head = await readHeadRaw(ctx);
  const base = await resolveBase(ctx, head);

  const lock = await acquireIndexLock(ctx);
  try {
    const found = await findLocalChanges(ctx, opts);
    if (!hasLocalChanges(found, base)) return { kind: 'no-local-changes' };
    const { iTree } = found;
    const w = await createStashCommits(ctx, workDir, { base, found, opts });
    const { untracked, working } = w;
    await record(w);
    await resetAfterPush(ctx, lock, { base, iTree, untracked, opts });
    return {
      kind: 'saved',
      stash: w.stash,
      message: w.message,
      eolNotices: [...untracked.eolNotices, ...working.eolNotices],
    };
  } finally {
    await lock.release();
  }
};

interface CommitInputs {
  readonly base: BaseState;
  readonly found: LocalChanges;
  readonly opts: StashPushInput;
}

interface StashWrite {
  readonly stash: ObjectId;
  readonly message: string;
  readonly working: WorkingTreeProjection;
  readonly untracked: UntrackedProjection;
}

interface StashCommitWriter {
  readonly index: (tree: ObjectId) => Promise<ObjectId>;
  readonly untracked: (tree: ObjectId) => Promise<ObjectId>;
  readonly stash: (tree: ObjectId, parents: ReadonlyArray<ObjectId>) => Promise<ObjectId>;
  readonly stashMessage: string;
}

const stashCommitWriter = async (
  ctx: Context,
  base: BaseState,
  opts: StashPushInput,
): Promise<StashCommitWriter> => {
  const identity = await resolveReflogIdentity(ctx);
  const branch = stashBranchLabel(base.branchRef);
  const abbrev = abbreviateOid(base.b);
  const { subject } = base;
  const stashMessage =
    opts.message !== undefined
      ? onMessage(branch, opts.message)
      : wipMessage(branch, abbrev, subject);
  const mkCommit = (
    tree: ObjectId,
    parents: ReadonlyArray<ObjectId>,
    message: string,
  ): Promise<ObjectId> =>
    createCommit(ctx, {
      tree,
      parents,
      author: identity,
      committer: identity,
      message,
      extraHeaders: [],
    });
  return {
    index: (tree) => mkCommit(tree, [base.b], indexMessage(branch, abbrev, subject)),
    untracked: (tree) => mkCommit(tree, [], untrackedMessage(branch, abbrev, subject)),
    stash: (tree, parents) => mkCommit(tree, parents, stashMessage),
    stashMessage,
  };
};

/**
 * Write the index, untracked and WIP commits in git's order, so a refusal while hashing
 * leaves the same unreachable commits git leaves.
 */
const createStashCommits = async (
  ctx: Context,
  workDir: string,
  inputs: CommitInputs,
): Promise<StashWrite> => {
  const { base, found, opts } = inputs;
  const writer = await stashCommitWriter(ctx, base, opts);
  const i = await writer.index(found.iTree);
  const untracked = await hashUntracked(ctx, workDir, found.untrackedFiles, found.scope);
  const u =
    untracked.paths.length === 0
      ? []
      : [await writer.untracked(await synthesizeTreeFromIndex(ctx, untracked.entries))];
  const working = await projectWorkingTree(ctx, workDir, found.tracked, found.scope);
  const wTree = await synthesizeTreeFromIndex(ctx, working.entries);
  const stash = await writer.stash(wTree, [base.b, i, ...u]);
  return { stash, message: writer.stashMessage, working, untracked };
};

export type { StashDropResult } from '../primitives/stash-ref.js';

export type StashListEntry = StashStackEntry;
export interface StashListResult {
  readonly entries: ReadonlyArray<StashListEntry>;
}

/** List the stash stack, newest-first (`stash@{0}` first). */
export const stashList = async (ctx: Context): Promise<StashListResult> => {
  await gateStash(ctx, 'stash list');
  return { entries: await readStashStack(ctx) };
};

export interface StashDropInput {
  readonly index?: number;
}

/** Drop `stash@{index}` (default newest) from the stack. */
export const stashDrop = async (
  ctx: Context,
  input: StashDropInput = {},
): Promise<StashDropResult> => {
  await gateStash(ctx, 'stash drop');
  return dropStashEntry(ctx, input.index ?? 0);
};

interface ResetInputs {
  readonly base: BaseState;
  readonly iTree: ObjectId;
  readonly untracked: UntrackedProjection;
  readonly opts: StashPushInput;
}

/** Reset the working tree + index to HEAD (or the index tree under `--keep-index`). */
const resetAfterPush = async (
  ctx: Context,
  lock: IndexLock,
  inputs: ResetInputs,
): Promise<void> => {
  const { base, iTree, untracked, opts } = inputs;
  const currentIndex = await readIndex(ctx);
  const target = opts.keepIndex === true ? iTree : base.bTree;
  const result = await materializeTree(ctx, {
    targetTree: target,
    currentIndex,
    force: true,
    forceRewriteAll: true,
  });
  await lock.commit(result.newIndexEntries, 'replace');
  // Stryker disable next-line ConditionalExpression: equivalent — when `includeUntracked` is falsy `untracked.paths` is always empty, so the `if(true)` variant iterates an empty list (no-op); the `if(false)` variant is killed by the `-u` removal test.
  if (opts.includeUntracked === true) {
    for (const path of untracked.paths) await removeWorkingTreeFile(ctx, path);
  }
};

export interface StashApplyInput {
  readonly index?: number;
  readonly restoreIndex?: boolean;
}

export interface StashConflict {
  readonly path: FilePath;
  readonly type: ConflictType;
}

export type StashApplyResult =
  | { readonly kind: 'applied'; readonly stash: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<StashConflict> };

interface StashParents {
  readonly base: ObjectId;
  readonly indexParent: ObjectId;
  readonly untrackedParent: ObjectId | undefined;
  readonly wTree: ObjectId;
}

/** Parse a W commit's parents into the stash trio's commit oids. */
const parseStashCommit = async (ctx: Context, w: ObjectId): Promise<StashParents> => {
  const obj = await readObject(ctx, w);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, w);
  const [base, indexParent, untrackedParent] = obj.data.parents;
  // A well-formed stash W always has at least [base, index] parents; fewer means
  // the ref points at a non-stash commit.
  if (base === undefined || indexParent === undefined) {
    throw invalidCommit(REASON_NOT_A_STASH_COMMIT);
  }
  return { base, indexParent, untrackedParent, wTree: obj.data.tree };
};

/** Untracked paths whose restoration would overwrite an existing working file. */
const untrackedOverwrites = async (
  ctx: Context,
  workDir: string,
  uTree: ObjectId,
): Promise<ReadonlyArray<FilePath>> => {
  const flat = await flattenTree(ctx, uTree);
  const clobbered: FilePath[] = [];
  for (const path of flat.entries.keys()) {
    if (hasEscapedBytes(path)) continue;
    if (await pathIsOccupied(ctx, joinPath(workDir, path))) clobbered.push(path);
  }
  return clobbered;
};

/** git restores untracked files through a checkout of a temporary index holding exactly them. */
const untrackedWriter = (
  ctx: Context,
  entries: ReadonlyMap<FilePath, { readonly id: ObjectId }>,
): WorkingTreeWriter =>
  createWorkingTreeWriter(ctx, {
    provider: lazily(() =>
      buildAttributeProvider(ctx, {
        kind: 'index-first',
        index: attributeBlobLookup([...entries].map(([path, { id }]) => ({ path, id }))),
      }),
    ),
    settings: lazily(() => readEolSettings(ctx)),
    limiter: limiterFor(ctx, 'cpuBound'),
  });

/** Check out the untracked tree into the working tree (clean-apply path only). */
const restoreUntracked = async (ctx: Context, uTree: ObjectId): Promise<void> => {
  const flat = await flattenTree(ctx, uTree);
  // Whole-tree name gate before the first write: a stash's untracked tree is
  // attacker-controllable, so a hostile entry name (`.git/**`, a `.git` alias,
  // a traversal) must refuse the entire restore untouched — mirroring the
  // index-write boundary a checkout crosses.
  for (const [path, entry] of flat.entries) {
    validateTreePath(path, entry.mode);
  }
  // One scanner for the whole restore: its per-directory memo means a deep
  // untracked tree with many paths under the same symlinked directory costs
  // one `lstat` per distinct directory, not one per path.
  const scanner = createLeadingPathScanner(ctx);
  const writer = untrackedWriter(ctx, flat.entries);
  for (const [path, entry] of flat.entries) {
    await writer.writeBlob(path, entry.id, entry.mode, scanner);
  }
};

/** git skips `--index` when the stash staged nothing, or the index already equals what was staged. */
const hasStagedChanges = (trees: {
  readonly bTree: ObjectId;
  readonly cTree: ObjectId;
  readonly iTree: ObjectId;
}): boolean => trees.iTree !== trees.bTree && trees.iTree !== trees.cTree;

/** Reinstate the staged state (`--index`) when the index-side 3-way merge is clean. */
const reinstateIndex = async (
  ctx: Context,
  lock: IndexLock,
  args: {
    readonly bTree: ObjectId;
    readonly cTree: ObjectId;
    readonly iTree: ObjectId;
    readonly currentIndex: GitIndex;
  },
): Promise<void> => {
  const merged = await mergeTreesToTree(ctx, {
    baseTree: args.bTree,
    oursTree: args.cTree,
    theirsTree: args.iTree,
    labels: STASH_LABELS,
  });
  if (merged.kind !== 'clean') return;
  const entries = await buildIndexFromTree(ctx, {
    targetTree: merged.mergedTree,
    currentIndex: args.currentIndex,
  });
  await lock.commit(entries, 'replace');
};

/** Apply `stash@{index}` (default newest) onto the working tree via a 3-way merge. */
export const stashApply = async (
  ctx: Context,
  input: StashApplyInput = {},
): Promise<StashApplyResult> => {
  const workDir = await gateStash(ctx, 'stash apply');
  await assertNoPendingOperation(ctx);
  return applyStashCommit(ctx, workDir, await resolveStashEntry(ctx, input.index ?? 0), input);
};

/**
 * git's `apply_autostash`: re-apply the autostash; on a conflict keep the
 * conflicted tree and store the stash in `refs/stash` (`autostash`).
 */
export const applyAutostash = async (ctx: Context, w: ObjectId): Promise<void> => {
  const workDir = requireWorkTree(ctx, 'rebase');
  const result = await applyStashCommit(ctx, workDir, w, {}).catch((err: unknown) => {
    if (!(err instanceof TsgitError)) throw err;
    return err;
  });
  if (!(result instanceof TsgitError) && result.kind === 'applied') {
    ctx.logger?.info?.('Applied autostash.');
    return;
  }
  await pushStashRef(ctx, w, AUTOSTASH);
  const refusal = result instanceof TsgitError ? { code: result.data.code } : undefined;
  ctx.logger?.warn?.(AUTOSTASH_CONFLICT, refusal);
};

/** git's `apply_autostash_ref(MERGE_AUTOSTASH)`: re-apply a merge's autostash, if any. */
export const applyMergeAutostash = async (ctx: Context): Promise<void> => {
  const stash = await takeMergeAutostash(ctx);
  if (stash !== undefined) await applyAutostash(ctx, stash);
};

const AUTOSTASH_CONFLICT =
  'Your local changes are stashed, however applying them\n' +
  'resulted in conflicts.  You can either resolve the conflicts\n' +
  'and then discard the stash with "git stash drop", or, if you\n' +
  'do not want to resolve them now, run "git reset --hard" and\n' +
  'apply the local changes later by running "git stash pop".';

const applyStashCommit = async (
  ctx: Context,
  workDir: string,
  w: ObjectId,
  input: StashApplyInput,
): Promise<StashApplyResult> => {
  const parsed = await parseStashCommit(ctx, w);
  const bTree = await commitTreeOf(ctx, parsed.base);
  const uTree =
    parsed.untrackedParent !== undefined
      ? await commitTreeOf(ctx, parsed.untrackedParent)
      : undefined;
  const lock = await acquireIndexLock(ctx);
  try {
    return await applyUnderLock(ctx, lock, { workDir, w, input, parsed, bTree, uTree });
  } finally {
    await lock.release();
  }
};

/** A stash being applied: its commit, its parents' trees and how to apply it. */
interface StashApplication {
  readonly workDir: string;
  readonly w: ObjectId;
  readonly input: StashApplyInput;
  readonly parsed: StashParents;
  readonly bTree: ObjectId;
  readonly uTree: ObjectId | undefined;
}

/** Merge the stash into the index and work tree, then restore its index and untracked files. */
const applyUnderLock = async (
  ctx: Context,
  lock: IndexLock,
  { workDir, w, input, parsed, bTree, uTree }: StashApplication,
): Promise<StashApplyResult> => {
  const currentIndex = await readIndex(ctx);
  rejectUnmergedIndex(currentIndex.entries);
  const cTree = await synthesizeTreeFromIndex(ctx, currentIndex.entries);
  if (uTree !== undefined) await refuseUntrackedOverwrites(ctx, workDir, uTree);
  const result = await mergeStash(ctx, { bTree, cTree, wTree: parsed.wTree, currentIndex });
  if (result.kind === 'conflict') {
    await lock.commit(result.indexEntries, 'replace');
    return {
      kind: 'conflict',
      conflicts: toConflictList(result.conflicts),
    };
  }
  const iTree = await commitTreeOf(ctx, parsed.indexParent);
  if (input.restoreIndex === true && hasStagedChanges({ bTree, cTree, iTree })) {
    await reinstateIndex(ctx, lock, { bTree, cTree, iTree, currentIndex });
  } else {
    const { entries, restagedPaths } = unstageChangesUnlessNew(
      result.result.newIndexEntries,
      currentIndex.entries,
    );
    await lock.commit(entries, 'replace', { restagedPaths });
  }
  if (uTree !== undefined) await restoreUntracked(ctx, uTree);
  return { kind: 'applied', stash: w };
};

const refuseUntrackedOverwrites = async (
  ctx: Context,
  workDir: string,
  uTree: ObjectId,
): Promise<void> => {
  const clobbered = await untrackedOverwrites(ctx, workDir, uTree);
  if (clobbered.length > 0) throw stashApplyWouldOverwrite(clobbered);
};

/** Three-way merge the stash's work tree onto the current index; refuse a clobber. */
const mergeStash = async (
  ctx: Context,
  trees: {
    readonly bTree: ObjectId;
    readonly cTree: ObjectId;
    readonly wTree: ObjectId;
    readonly currentIndex: GitIndex;
  },
) => {
  const result = await applyMergeToWorktree(ctx, {
    baseTree: trees.bTree,
    oursTree: trees.cTree,
    theirsTree: trees.wTree,
    currentIndex: trees.currentIndex,
    labels: STASH_LABELS,
  });
  if (result.kind === 'would-overwrite')
    throw stashApplyWouldOverwrite([...result.localChanges, ...result.untracked]);
  return result;
};

export type StashPopResult =
  | { readonly kind: 'applied'; readonly stash: ObjectId; readonly dropped: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<StashConflict> };

/** Apply `stash@{index}` then drop it; on conflict the stash is retained. */
export const stashPop = async (
  ctx: Context,
  input: StashApplyInput = {},
): Promise<StashPopResult> => {
  // Gated here, ahead of the `stashApply` delegation below, so a work-tree
  // refusal names 'stash pop' rather than the delegate's own 'stash apply'.
  await gateStash(ctx, 'stash pop');
  const applied = await stashApply(ctx, input);
  if (applied.kind === 'conflict') return applied;
  const dropped = await stashDrop(ctx, { index: input.index ?? 0 });
  return { kind: 'applied', stash: applied.stash, dropped: dropped.dropped };
};
