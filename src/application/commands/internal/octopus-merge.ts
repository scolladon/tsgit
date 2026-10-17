/**
 * git's `octopus` strategy (`git-merge-octopus`), run in memory: each head in
 * turn is fast-forwarded to (the first, when it can be) or merged into the
 * running result with `read-tree -m --aggressive` and `git-merge-one-file`.
 * Only the last head may leave conflicts; one before it fails the strategy.
 */
import { octopusMergeFailed } from '../../../domain/commands/error.js';
import type { FlatTreeEntry } from '../../../domain/diff/flat-tree.js';
import { sortByPath } from '../../../domain/diff/path-compare.js';
import {
  MAX_CONFLICT_OUTPUT_BYTES,
  type MergeConflict,
  mergeContent,
  mergeLabels,
} from '../../../domain/merge/index.js';
import { type OctopusSide, resolveOctopusEntry } from '../../../domain/merge/octopus-entry.js';
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { FilePath, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { flattenEscapedTree } from '../../primitives/flatten-tree.js';
import { readConflictStyle } from '../../primitives/internal/merge-rename-config.js';
import { stage0Entry } from '../../primitives/internal/synthetic-index-entry.js';
import { mergeBasesOf } from '../../primitives/merge-base.js';
import { readBlob } from '../../primitives/read-blob.js';
import { readObject } from '../../primitives/read-object.js';
import { synthesizeTreeFromIndex } from '../../primitives/synthesize-tree-from-index.js';
import { writeObject } from '../../primitives/write-object.js';

/** A head merged, with the name it was given (git's `GITHEAD_<oid>`). */
export interface OctopusRemote {
  readonly id: ObjectId;
  readonly name: string;
}

type FlatEntries = ReadonlyMap<FilePath, FlatTreeEntry>;

export type OctopusResult =
  | { readonly kind: 'clean'; readonly tree: ObjectId }
  | {
      readonly kind: 'conflict';
      /** The index's merged (stage-0) entries. */
      readonly merged: FlatEntries;
      /** The working tree, conflicted paths aside: the merged entries plus what an unmerged path held. */
      readonly worktree: FlatEntries;
      readonly conflicts: ReadonlyArray<MergeConflict>;
    };

interface StepResult {
  readonly merged: FlatEntries;
  readonly kept: FlatEntries;
  readonly conflicts: ReadonlyArray<MergeConflict>;
}

/** The running state: git's `MRC` (the commits merged so far) and `MRT` (their merged tree). */
interface Running {
  readonly commits: readonly ObjectId[];
  readonly entries: FlatEntries;
  /** The latest head's merge step; absent while every head so far fast-forwarded. */
  readonly step?: StepResult;
}

const READ_BLOB_OPTS = { maxBytes: MAX_CONFLICT_OUTPUT_BYTES } as const;
const EMPTY = new Uint8Array(0);

const flatOfCommit = async (ctx: Context, id: ObjectId): Promise<FlatEntries> => {
  const object = await readObject(ctx, id);
  if (object.type !== 'commit') throw unexpectedObjectType('commit', object.type, id);
  return (await flattenEscapedTree(ctx, object.data.tree)).entries;
};

const blobBytes = async (ctx: Context, side: OctopusSide | undefined): Promise<Uint8Array> =>
  side === undefined ? EMPTY : (await readBlob(ctx, side.id, READ_BLOB_OPTS)).content;

const writeBlob = (ctx: Context, content: Uint8Array): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });

/**
 * `git-merge-one-file`'s content case: `git merge-file` over the three blobs.
 * A missing base, a conflicted merge, or differing modes leave the path
 * conflicted with the merged bytes in our mode; otherwise the result is staged.
 */
const mergeOneFile = async (
  ctx: Context,
  path: FilePath,
  sides: {
    readonly base: OctopusSide | undefined;
    readonly head: OctopusSide;
    readonly remote: OctopusSide;
  },
  remoteName: string,
): Promise<PathOutcome> => {
  const { base, head, remote } = sides;
  const [baseBytes, ours, theirs, style] = await Promise.all([
    blobBytes(ctx, base),
    blobBytes(ctx, head),
    blobBytes(ctx, remote),
    readConflictStyle(ctx),
  ]);
  const labels = mergeLabels(remoteName, base?.id);
  const result = mergeContent(baseBytes, ours, theirs, { labels, conflictStyle: style ?? 'merge' });
  const bytes = result.status === 'clean' ? result.bytes : result.markedBytes;
  if (result.status === 'clean' && base !== undefined && head.mode === remote.mode) {
    return { kind: 'merged', entry: { id: await writeBlob(ctx, bytes), mode: head.mode } };
  }
  return { kind: 'conflict', conflict: contentConflict(path, sides, bytes) };
};

const contentConflict = (
  path: FilePath,
  sides: {
    readonly base: OctopusSide | undefined;
    readonly head: OctopusSide;
    readonly remote: OctopusSide;
  },
  bytes: Uint8Array,
): MergeConflict => ({
  ...stageSides(path, sides.base, sides.head, sides.remote),
  type: sides.base === undefined ? 'add-add' : 'content',
  conflictContent: bytes,
  mergedMode: sides.head.mode,
});

/** The stage 1-3 ids and modes `read-tree` left for a path. */
const stageSides = (
  path: FilePath,
  base: OctopusSide | undefined,
  head: OctopusSide | undefined,
  remote: OctopusSide | undefined,
): MergeConflict => ({
  type: 'modify-delete',
  path,
  ...(base === undefined ? {} : { baseId: base.id, baseMode: base.mode }),
  ...(head === undefined ? {} : { ourId: head.id, ourMode: head.mode }),
  ...(remote === undefined ? {} : { theirId: remote.id, theirMode: remote.mode }),
});

const unionPaths = (maps: ReadonlyArray<FlatEntries>): FilePath[] => {
  const paths = new Set<FilePath>();
  for (const map of maps) for (const path of map.keys()) paths.add(path);
  return sortByPath([...paths], (path) => path);
};

type PathOutcome =
  | { readonly kind: 'merged'; readonly entry: FlatTreeEntry }
  | { readonly kind: 'dropped' }
  | { readonly kind: 'conflict'; readonly conflict: MergeConflict; readonly kept?: FlatTreeEntry };

interface StepInput {
  readonly bases: ReadonlyArray<FlatEntries>;
  readonly current: FlatEntries;
  readonly remote: FlatEntries;
  readonly remoteName: string;
}

const DROPPED: PathOutcome = { kind: 'dropped' };

/** One path through `read-tree -m --aggressive` and, when it leaves stages, `git-merge-one-file`. */
const mergePath = async (ctx: Context, input: StepInput, path: FilePath): Promise<PathOutcome> => {
  const head = input.current.get(path);
  const bases = input.bases.map((base) => base.get(path));
  const resolution = resolveOctopusEntry(bases, head, input.remote.get(path));
  if (resolution.kind === 'take') return { kind: 'merged', entry: resolution.side };
  if (resolution.kind === 'drop') return DROPPED;
  if (resolution.kind === 'content') return mergeOneFile(ctx, path, resolution, input.remoteName);
  const conflict = stageSides(path, resolution.base, resolution.head, resolution.remote);
  return head === undefined
    ? { kind: 'conflict', conflict }
    : { kind: 'conflict', conflict, kept: head };
};

/** One `read-tree -m --aggressive <bases> MRT <head>` + `merge-index -a git-merge-one-file`. */
const mergeStep = async (ctx: Context, input: StepInput): Promise<StepResult> => {
  const merged = new Map<FilePath, FlatTreeEntry>();
  const kept = new Map<FilePath, FlatTreeEntry>();
  const conflicts: MergeConflict[] = [];
  for (const path of unionPaths([...input.bases, input.current, input.remote])) {
    const outcome = await mergePath(ctx, input, path);
    if (outcome.kind === 'merged') merged.set(path, outcome.entry);
    if (outcome.kind !== 'conflict') continue;
    conflicts.push(outcome.conflict);
    if (outcome.kept !== undefined) kept.set(path, outcome.kept);
  }
  return { merged, kept, conflicts };
};

/** git's `write-tree` over flat entries. */
export const writeFlatTree = (ctx: Context, entries: FlatEntries): Promise<ObjectId> =>
  synthesizeTreeFromIndex(
    ctx,
    [...entries].map(([path, entry]) => stage0Entry(path, entry.id, entry.mode)),
  );

/**
 * One head of git's loop: a fast-forward to it, or a merge step into the
 * running result — `undefined` when the head shares no history with it.
 */
const advance = async (
  ctx: Context,
  running: Running,
  remote: OctopusRemote,
): Promise<Running | undefined> => {
  const common = await mergeBasesOf(ctx, [remote.id, ...running.commits], { all: true });
  if (common.length === 0) return undefined;
  const remoteEntries = await flatOfCommit(ctx, remote.id);
  if (running.step === undefined && common[0] === running.commits[0]) {
    ctx.logger?.info?.(`Fast-forwarding to: ${remote.name}`);
    return { commits: [remote.id], entries: remoteEntries };
  }
  ctx.logger?.info?.(`Trying simple merge with ${remote.name}`);
  const bases = await Promise.all(common.map((id) => flatOfCommit(ctx, id)));
  const input = { bases, current: running.entries, remote: remoteEntries, remoteName: remote.name };
  const step = await mergeStep(ctx, input);
  return { commits: [...running.commits, remote.id], entries: step.merged, step };
};

/**
 * `git-merge-octopus` dies on a head sharing no history — git's merge then
 * takes the strategy's exit as conflicts, keeping what merged so far.
 */
const stopAtUnrelated = (ctx: Context, running: Running, remote: OctopusRemote): OctopusResult => {
  ctx.logger?.error?.(`Unable to find common commit with ${remote.name}`);
  return { kind: 'conflict', merged: running.entries, worktree: running.entries, conflicts: [] };
};

/** The strategy's outcome: the merged tree, or the last head's conflicts. */
const settle = async (ctx: Context, running: Running): Promise<OctopusResult> => {
  const step = running.step;
  if (step === undefined || step.conflicts.length === 0) {
    return { kind: 'clean', tree: await writeFlatTree(ctx, running.entries) };
  }
  const worktree = new Map([...step.merged, ...step.kept]);
  return { kind: 'conflict', merged: step.merged, worktree, conflicts: step.conflicts };
};

const isLast = (index: number, remotes: ReadonlyArray<OctopusRemote>): boolean =>
  index === remotes.length - 1;

/**
 * Merge `remotes` into `headId` as `git-merge-octopus` does: intermediate
 * results are written as trees (its `write-tree`), a conflict before the last
 * head refuses with `OCTOPUS_MERGE_FAILED`, one on the last is returned, and a
 * head sharing no history ends the merge as a conflict with nothing unmerged.
 */
export const octopusMerge = async (
  ctx: Context,
  headId: ObjectId,
  remotes: ReadonlyArray<OctopusRemote>,
): Promise<OctopusResult> => {
  let running: Running = { commits: [headId], entries: await flatOfCommit(ctx, headId) };
  for (const [index, remote] of remotes.entries()) {
    const next = await advance(ctx, running, remote);
    if (next === undefined) return stopAtUnrelated(ctx, running, remote);
    running = next;
    const step = running.step;
    if (step === undefined || isLast(index, remotes)) continue;
    if (step.conflicts.length > 0)
      throw octopusMergeFailed(remote.name, 'conflict-before-last-head');
    await writeFlatTree(ctx, step.merged);
  }
  return settle(ctx, running);
};
