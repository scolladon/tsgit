/**
 * `revert` — record new commits that undo the changes introduced by existing
 * commits. The inverse of `cherry-pick`: each revert is a new single-parent
 * commit authored by the **current identity** (not the reverted commit's author)
 * whose patch is the **reverse** 3-way merge (`base = C`, `ours = HEAD`,
 * `theirs = parent(C)`) applied through the shared `applyMergeToWorktree`
 * primitive. Conflicts stop with a dedicated `REVERT_HEAD` state; an empty
 * revert (no net change) stops markerless (git has no `--allow-empty`).
 */
import {
  invalidOption,
  noInitialCommit,
  revertMergeNoMainline,
  workingTreeDirty,
} from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import { unsupportedOperation } from '../../domain/index.js';
import type { ConflictType, MergeConflict } from '../../domain/merge/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { AuthorIdentity, FilePath, ObjectId, RefName } from '../../domain/objects/index.js';
import type { TodoEntry } from '../../domain/sequencer/index.js';
import type { Context } from '../../ports/context.js';
import { applyMergeToWorktree } from '../primitives/apply-merge-to-worktree.js';
import { readConfig } from '../primitives/config-read.js';
import { createCommit } from '../primitives/create-commit.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  readHeadRaw,
} from '../primitives/internal/repo-state.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { writeTree } from '../primitives/write-tree.js';
import { conflictMergeMsg } from './internal/cherry-pick-state.js';
import { assertCleanWorkTree } from './internal/clean-work-tree.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { resolveCommitter, sanitizeMessage } from './internal/commit-message.js';
import { acquireIndexLock } from './internal/index-update.js';
import { writeMergeMsg } from './internal/merge-state.js';
import { revertMessage, writeRevertHead } from './internal/revert-state.js';
import {
  clearSequencer,
  writeAbortSafety,
  writeSequencerHead,
  writeSequencerOpts,
  writeSequencerTodo,
} from './internal/sequencer-state.js';
import { revParse } from './rev-parse.js';

export interface RevertRunInput {
  /** Revisions to revert, in argument order — a commit-ish each. */
  readonly commits: ReadonlyArray<string>;
}

export interface RevertedCommit {
  readonly source: ObjectId;
  readonly created: ObjectId;
}

export interface RevertConflict {
  readonly path: FilePath;
  readonly type: ConflictType;
}

export type RevertResult =
  | { readonly kind: 'reverted'; readonly commits: ReadonlyArray<RevertedCommit> }
  | {
      readonly kind: 'conflict';
      readonly commit: ObjectId;
      readonly conflicts: ReadonlyArray<RevertConflict>;
      readonly remaining: number;
    }
  | { readonly kind: 'empty'; readonly commit: ObjectId; readonly remaining: number };

type RevertOutcome =
  | { readonly kind: 'committed'; readonly id: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
  | { readonly kind: 'empty' };

const readCommitData = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, id);
  return obj.data;
};

const treeOf = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> =>
  (await readCommitData(ctx, commitId)).tree;

const subjectOf = (message: string): string => message.split('\n')[0] as string;

/** A merge commit (≥2 parents) cannot be reverted without a chosen mainline (`-m`). */
const isMergeCommit = (cData: CommitData): boolean => cData.parents.length >= 2;

const toConflictList = (conflicts: ReadonlyArray<MergeConflict>): ReadonlyArray<RevertConflict> =>
  conflicts.map((c) => ({ path: c.path, type: c.type }));

/** Resolve the (always symbolic) HEAD branch to its commit, or refuse if unborn. */
const resolveHeadCommit = async (ctx: Context, branch: RefName): Promise<ObjectId> => {
  try {
    return await resolveRef(ctx, branch);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_NOT_FOUND') throw noInitialCommit();
    throw err;
  }
};

/** The new revert commit's author AND committer is the current identity (config `user.*`, now). */
const resolveCurrentIdentity = async (ctx: Context): Promise<AuthorIdentity> => {
  const config = await readConfig(ctx);
  const user = config.user;
  const configUser =
    user !== undefined
      ? {
          name: user.name,
          email: user.email,
          timestamp: Math.floor(Date.now() / 1000),
          timezoneOffset: '+0000',
        }
      : undefined;
  return resolveCommitter(configUser !== undefined ? { configUser } : {});
};

/** The empty tree (`theirs` of a root-commit revert): materialised so it can be read. */
const emptyTree = (ctx: Context): Promise<ObjectId> => writeTree(ctx, []);

/** Build the new single-parent revert commit; returns its id and message subject (reflog). */
const buildRevertCommit = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  parentId: ObjectId,
  tree: ObjectId,
): Promise<{ readonly id: ObjectId; readonly subject: string }> => {
  const identity = await resolveCurrentIdentity(ctx);
  const message = sanitizeMessage(revertMessage(cData, source), { allowEmpty: false });
  const id = await createCommit(ctx, {
    tree,
    parents: [parentId],
    author: identity,
    committer: identity,
    message,
    extraHeaders: [],
  });
  return { id, subject: subjectOf(message) };
};

/** Apply one commit's reverse change onto `ourId`, committing when the merge is clean. */
const applyOneRevert = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  branch: RefName,
  ourId: ObjectId,
): Promise<RevertOutcome> => {
  const parentId = cData.parents[0];
  const theirsTree = parentId !== undefined ? await treeOf(ctx, parentId) : await emptyTree(ctx);
  const oursTree = await treeOf(ctx, ourId);
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const res = await applyMergeToWorktree(ctx, {
      baseTree: cData.tree,
      oursTree,
      theirsTree,
      currentIndex,
    });
    if (res.kind === 'would-overwrite') throw workingTreeDirty(res.paths);
    if (res.kind === 'conflict') {
      await lock.commit(res.indexEntries);
      return { kind: 'conflict', conflicts: res.conflicts };
    }
    if (res.mergedTree === oursTree) return { kind: 'empty' };
    await lock.commit(res.result.newIndexEntries);
    const { id, subject } = await buildRevertCommit(ctx, source, cData, ourId, res.mergedTree);
    await updateRef(ctx, branch, id, { expected: ourId, reflogMessage: `revert: ${subject}` });
    return { kind: 'committed', id };
  } finally {
    await lock.release();
  }
};

/** Persist single-revert conflict state (`REVERT_HEAD` + the `Revert "…"` MERGE_MSG). */
const persistStop = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  conflicts: ReadonlyArray<MergeConflict>,
): Promise<void> => {
  await writeRevertHead(ctx, source);
  await writeMergeMsg(
    ctx,
    conflictMergeMsg(
      revertMessage(cData, source),
      conflicts.map((c) => c.path),
    ),
  );
};

interface SequenceState {
  readonly multiPick: boolean;
  readonly sequenceHead: ObjectId;
}

/** Read each commit's subject to build `revert <oid> <subject>` todo entries. */
const buildTodoEntries = async (
  ctx: Context,
  oids: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<TodoEntry>> => {
  const entries: TodoEntry[] = [];
  for (const oid of oids) {
    const cData = await readCommitData(ctx, oid);
    entries.push({ command: 'revert', oid, subject: subjectOf(cData.message) });
  }
  return entries;
};

/** Persist the git-faithful sequencer dir on a multi-revert stop. */
const writeSequencerStop = async (
  ctx: Context,
  seq: SequenceState,
  remaining: ReadonlyArray<ObjectId>,
  currentHead: ObjectId,
): Promise<void> => {
  await writeSequencerHead(ctx, seq.sequenceHead);
  await writeSequencerTodo(ctx, await buildTodoEntries(ctx, remaining));
  await writeAbortSafety(ctx, currentHead);
  // revert exposes no record-origin/allow-empty/no-commit resume flags, so the
  // opts file is always absent (the writer skips it when all options default).
  await writeSequencerOpts(ctx, { recordOrigin: false, allowEmpty: false, noCommit: false });
};

/**
 * Drive the revert work-list from `startOurId`, committing each clean revert and
 * advancing HEAD. A conflict persists `REVERT_HEAD` + `MERGE_MSG`; an empty revert
 * or a merge commit stops markerless (git has no `--allow-empty`). For a multi-
 * revert sequence each stop also persists the sequencer dir (current at `todo[0]`).
 */
const runSequence = async (
  ctx: Context,
  todo: ReadonlyArray<ObjectId>,
  branch: RefName,
  startOurId: ObjectId,
  seq: SequenceState,
): Promise<RevertResult> => {
  let ourId = startOurId;
  const applied: RevertedCommit[] = [];
  for (let i = 0; i < todo.length; i += 1) {
    const source = todo[i] as ObjectId;
    const cData = await readCommitData(ctx, source);
    if (isMergeCommit(cData)) {
      // Partial-apply: earlier reverts are already committed. Stop AT the merge,
      // keeping it as todo[0] (no REVERT_HEAD — it never started).
      if (seq.multiPick) await writeSequencerStop(ctx, seq, todo.slice(i), ourId);
      throw revertMergeNoMainline(source);
    }
    const outcome = await applyOneRevert(ctx, source, cData, branch, ourId);
    if (outcome.kind === 'committed') {
      applied.push({ source, created: outcome.id });
      ourId = outcome.id;
      continue;
    }
    if (outcome.kind === 'conflict') await persistStop(ctx, source, cData, outcome.conflicts);
    if (seq.multiPick) await writeSequencerStop(ctx, seq, todo.slice(i), ourId);
    const remaining = todo.length - (i + 1);
    return outcome.kind === 'conflict'
      ? {
          kind: 'conflict',
          commit: source,
          conflicts: toConflictList(outcome.conflicts),
          remaining,
        }
      : { kind: 'empty', commit: source, remaining };
  }
  await clearSequencer(ctx);
  return { kind: 'reverted', commits: applied };
};

const RANGE = /^(.+)\.\.(.+)$/;

/**
 * Commits in `from..to`, **newest-first** (git's revert range order — to undo a
 * span you revert its tip first). The whole ancestor set of `from` is excluded.
 */
const expandRange = async (
  ctx: Context,
  from: ObjectId,
  to: ObjectId,
): Promise<ReadonlyArray<ObjectId>> => {
  const excluded = new Set<ObjectId>();
  for await (const commit of walkCommits(ctx, { from: [from] })) {
    excluded.add(commit.id);
  }
  const ids: ObjectId[] = [];
  for await (const commit of walkCommits(ctx, { from: [to], until: [...excluded] })) {
    ids.push(commit.id);
  }
  return ids;
};

/**
 * Expand each argument to ordered commit oids — a single commit-ish or an `A..B`
 * range (newest-first). `A...B` / `^`-exclusion forms are rejected, not
 * mis-expanded.
 */
const expandRevisions = async (
  ctx: Context,
  args: ReadonlyArray<string>,
): Promise<ReadonlyArray<ObjectId>> => {
  const todo: ObjectId[] = [];
  for (const arg of args) {
    if (arg.includes('...') || arg.includes('^')) {
      throw invalidOption(
        'commits',
        `unsupported revision form '${arg}' (use a commit-ish or A..B)`,
      );
    }
    const match = RANGE.exec(arg);
    if (match === null) {
      todo.push(await resolveCommitIsh(ctx, arg));
      continue;
    }
    const from = await revParse(ctx, match[1] as string);
    const to = await revParse(ctx, match[2] as string);
    todo.push(...(await expandRange(ctx, from, to)));
  }
  return todo;
};

export const revertRun = async (ctx: Context, input: RevertRunInput): Promise<RevertResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'revert');
  await assertNoPendingOperation(ctx);
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('revert', 'cannot revert with detached HEAD');
  }
  const ourId = await resolveHeadCommit(ctx, head.target);
  const todo = await expandRevisions(ctx, input.commits);
  await assertCleanWorkTree(ctx, await treeOf(ctx, ourId));
  const seq: SequenceState = { multiPick: todo.length > 1, sequenceHead: ourId };
  return runSequence(ctx, todo, head.target, ourId, seq);
};
