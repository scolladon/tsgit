import { mergeHasConflicts, nonFastForward } from '../../domain/commands/error.js';
import { unsupportedOperation } from '../../domain/index.js';
import {
  type ContentMergeResult,
  type ContentMerger,
  type MergeOutcome,
  mergeContent,
  mergeTrees,
} from '../../domain/merge/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import {
  type AuthorIdentity,
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
  type RefName,
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { createCommit } from '../primitives/create-commit.js';
import { flattenTree } from '../primitives/flatten-tree.js';
import { mergeBase } from '../primitives/merge-base.js';
import { readBlob } from '../primitives/read-blob.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { writeObject } from '../primitives/write-object.js';
import { writeTree } from '../primitives/write-tree.js';
import { resolveAuthor, resolveCommitter, sanitizeMessage } from './internal/commit-message.js';
import { readConfig } from './internal/config-read.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  readHeadRaw,
} from './internal/repo-state.js';

export interface MergeOptions {
  readonly target: string;
  readonly message?: string;
  readonly fastForwardOnly?: boolean;
  readonly noFastForward?: boolean;
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
}

export type MergeResult =
  | { readonly kind: 'up-to-date'; readonly id: ObjectId }
  | { readonly kind: 'fast-forward'; readonly id: ObjectId; readonly branch: RefName }
  | {
      readonly kind: 'merge';
      readonly id: ObjectId;
      readonly branch: RefName;
      readonly parents: ReadonlyArray<ObjectId>;
    };

/**
 * Merge `target` into the current HEAD branch.
 *
 * - Up-to-date: target is ancestor of HEAD → no-op.
 * - Fast-forward: HEAD is ancestor of target → branch advances.
 * - True merge for diverged histories: Phase 13.4a wires the three-way
 *   tree merge (`mergeTrees` + `mergeContent`) so a CLEAN merge commits
 *   the merged tree directly (no `add` required afterward). Conflicting
 *   merges throw `MERGE_HAS_CONFLICTS` with the offending paths;
 *   working-tree markers + unmerged stages are deferred to Phase 13.4b.
 */
export const merge = async (ctx: Context, opts: MergeOptions): Promise<MergeResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'merge');
  await assertNoPendingOperation(ctx);
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('merge', 'cannot merge with detached HEAD');
  }
  const ourId = await resolveRef(ctx, head.target);
  const theirId = await resolveTarget(ctx, opts.target);
  if (ourId === theirId) return { kind: 'up-to-date', id: ourId };
  const base = await mergeBase(ctx, ourId, theirId);
  if (base === theirId) return { kind: 'up-to-date', id: ourId };
  if (base === ourId) {
    if (opts.noFastForward !== true) {
      await updateRef(ctx, head.target, theirId, { expected: ourId });
      return { kind: 'fast-forward', id: theirId, branch: head.target };
    }
  }
  if (opts.fastForwardOnly === true) {
    throw nonFastForward(head.target, ourId, theirId);
  }
  return mergeCommit(ctx, opts, head.target, ourId, theirId, base);
};

const MERGE_WRITE_FILES_OP = 'merge:write-files';

const mergeCommit = async (
  ctx: Context,
  opts: MergeOptions,
  branchName: RefName,
  ourId: ObjectId,
  theirId: ObjectId,
  baseId: ObjectId | undefined,
): Promise<MergeResult> => {
  ctx.progress.start(MERGE_WRITE_FILES_OP);
  try {
    const mergedTree = await computeMergedTree(ctx, ourId, theirId, baseId);
    const author = await resolveMergeAuthor(ctx, opts);
    const committer = resolveMergeCommitter(opts, author);
    const message = sanitizeMessage(opts.message ?? `Merge ${opts.target}`, { allowEmpty: false });
    const commitData: CommitData = {
      tree: mergedTree,
      parents: [ourId, theirId],
      author,
      committer,
      message,
      extraHeaders: [],
    };
    const id = await createCommit(ctx, commitData);
    await updateRef(ctx, branchName, id, { expected: ourId });
    return { kind: 'merge', id, branch: branchName, parents: [ourId, theirId] };
  } finally {
    ctx.progress.end(MERGE_WRITE_FILES_OP);
  }
};

const computeMergedTree = async (
  ctx: Context,
  ourId: ObjectId,
  theirId: ObjectId,
  baseId: ObjectId | undefined,
): Promise<ObjectId> => {
  const ourTreeId = await getTree(ctx, ourId);
  const theirTreeId = await getTree(ctx, theirId);
  const baseTreeId = baseId !== undefined ? await getTree(ctx, baseId) : undefined;

  const [ourFlat, theirFlat, baseFlat] = await Promise.all([
    flattenTree(ctx, ourTreeId),
    flattenTree(ctx, theirTreeId),
    baseTreeId !== undefined ? flattenTree(ctx, baseTreeId) : Promise.resolve(undefined),
  ]);

  const contentMerger = buildContentMerger(ctx);
  const result = await mergeTrees(baseFlat, ourFlat, theirFlat, contentMerger);

  if (!result.cleanMerge) {
    const paths = result.conflicts.map((c) => c.path);
    throw mergeHasConflicts(result.conflicts.length, paths);
  }

  return synthesiseMergedTree(ctx, result.outcomes);
};

const buildContentMerger =
  (ctx: Context): ContentMerger =>
  async (mergeCtx, _baseStub, _oursStub, _theirsStub): Promise<ContentMergeResult> => {
    const oursBytes = (await readBlob(ctx, mergeCtx.ourId)).content;
    const theirsBytes = (await readBlob(ctx, mergeCtx.theirId)).content;
    const baseBytes =
      mergeCtx.baseId !== undefined ? (await readBlob(ctx, mergeCtx.baseId)).content : undefined;
    return mergeContent(baseBytes, oursBytes, theirsBytes);
  };

interface LeafRecord {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const collectLeaves = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
): Promise<LeafRecord[]> => {
  const leaves: LeafRecord[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'resolved-deleted' || outcome.status === 'conflict') continue;
    if (outcome.status === 'resolved-merged') {
      // The empty-string `id` is a sentinel — `writeObject` computes the
      // real ObjectId from the content and returns it. The cast lets us
      // construct the typed input without circular dependence on the hash.
      const id = await writeObject(ctx, {
        type: 'blob',
        content: outcome.bytes,
        id: '' as ObjectId,
      });
      leaves.push({ path: outcome.path, id, mode: outcome.mode });
      continue;
    }
    // unchanged | resolved-known
    leaves.push({ path: outcome.path, id: outcome.id, mode: outcome.mode });
  }
  return leaves;
};

const synthesiseMergedTree = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
): Promise<ObjectId> => {
  const leaves = await collectLeaves(ctx, outcomes);
  return writeNestedTree(ctx, leaves);
};

interface PartitionedLeaves {
  readonly files: ReadonlyArray<LeafRecord>;
  readonly subdirs: ReadonlyMap<string, ReadonlyArray<LeafRecord>>;
}

const partitionByPrefix = (leaves: ReadonlyArray<LeafRecord>): PartitionedLeaves => {
  const files: LeafRecord[] = [];
  const subdirs = new Map<string, LeafRecord[]>();
  for (const leaf of leaves) {
    const slashIndex = leaf.path.indexOf('/');
    if (slashIndex === -1) {
      files.push(leaf);
      continue;
    }
    const prefix = leaf.path.slice(0, slashIndex);
    const rest = leaf.path.slice(slashIndex + 1) as FilePath;
    const sub: LeafRecord = { path: rest, id: leaf.id, mode: leaf.mode };
    const bucket = subdirs.get(prefix);
    if (bucket === undefined) subdirs.set(prefix, [sub]);
    else bucket.push(sub);
  }
  return { files, subdirs };
};

const writeNestedTree = async (
  ctx: Context,
  leaves: ReadonlyArray<LeafRecord>,
): Promise<ObjectId> => {
  const { files, subdirs } = partitionByPrefix(leaves);
  // Resolve sub-trees in parallel — each branch is independent of the
  // others, so awaiting them serially would needlessly stretch the
  // merge wall time when a target tree has many top-level dirs.
  const subdirEntries = await Promise.all(
    Array.from(subdirs, async ([prefix, subLeaves]) => ({
      name: prefix as FilePath,
      id: await writeNestedTree(ctx, subLeaves),
      mode: FILE_MODE.DIRECTORY,
    })),
  );
  const fileEntries = files.map((f) => ({ name: f.path, id: f.id, mode: f.mode }));
  return writeTree(ctx, [...fileEntries, ...subdirEntries]);
};

const resolveMergeAuthor = async (ctx: Context, opts: MergeOptions): Promise<AuthorIdentity> => {
  const config = await readConfig(ctx);
  const cfgUser = config.user
    ? {
        name: config.user.name,
        email: config.user.email,
        timestamp: Math.floor(Date.now() / 1000),
        timezoneOffset: '+0000',
      }
    : undefined;
  const authorInput: { explicit?: AuthorIdentity; configUser?: AuthorIdentity } = {};
  if (opts.author !== undefined) authorInput.explicit = opts.author;
  if (cfgUser !== undefined) authorInput.configUser = cfgUser;
  return resolveAuthor(authorInput);
};

const resolveMergeCommitter = (opts: MergeOptions, author: AuthorIdentity): AuthorIdentity => {
  const committerInput: {
    explicit?: AuthorIdentity;
    author?: AuthorIdentity;
    configUser?: AuthorIdentity;
  } = { author };
  if (opts.committer !== undefined) committerInput.explicit = opts.committer;
  return resolveCommitter(committerInput);
};

const resolveTarget = async (ctx: Context, target: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;
  return resolveRef(ctx, `refs/heads/${target}` as RefName);
};

const getTree = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> => {
  const obj = await readObject(ctx, commitId);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, commitId);
  return obj.data.tree;
};
