import { nonFastForward } from '../../domain/commands/error.js';
import { conflictsToIndexEntries } from '../../domain/diff/index.js';
import type { IndexEntry, StatData } from '../../domain/git-index/index.js';
import { unsupportedOperation } from '../../domain/index.js';
import {
  type ConflictType,
  type ContentMergeResult,
  type ContentMerger,
  MAX_CONFLICT_OUTPUT_BYTES,
  type MergeConflict,
  type MergeOutcome,
  mergeContent,
  mergeTrees,
  writeConflictMarkers,
} from '../../domain/merge/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { treeDepthExceeded, unexpectedObjectType } from '../../domain/objects/error.js';
import {
  type AuthorIdentity,
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
  type RefName,
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from '../primitives/config-read.js';
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
import { acquireIndexLock } from './internal/index-update.js';
import { writeMergeHead, writeMergeMsg, writeOrigHead } from './internal/merge-state.js';
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

export interface MergeConflictDescriptor {
  readonly path: FilePath;
  readonly type: ConflictType;
}

export type MergeResult =
  | { readonly kind: 'up-to-date'; readonly id: ObjectId }
  | { readonly kind: 'fast-forward'; readonly id: ObjectId; readonly branch: RefName }
  | {
      readonly kind: 'merge';
      readonly id: ObjectId;
      readonly branch: RefName;
      readonly parents: ReadonlyArray<ObjectId>;
    }
  | {
      readonly kind: 'conflict';
      readonly conflicts: ReadonlyArray<MergeConflictDescriptor>;
      readonly mergeHead: ObjectId;
      readonly origHead: ObjectId;
    };

/**
 * Merge `target` into the current HEAD branch.
 *
 * - Up-to-date: target is ancestor of HEAD → no-op.
 * - Fast-forward: HEAD is ancestor of target → branch advances.
 * - True merge for diverged histories:.4a wired the three-way
 *  tree merge (`mergeTrees` + `mergeContent`) so a CLEAN merge commits
 *  the merged tree directly.4b persists conflict state on
 *  disk (marker files, stage-1/2/3 index entries, MERGE_HEAD /
 *  MERGE_MSG / ORIG_HEAD) and returns `{ kind: 'conflict',... }`.
 *  Resolution path: edit the marker files, `repo.add(paths)`,
 *  `repo.commit({ message })` — the resulting commit has two parents.
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
  // Stryker disable next-line ConditionalExpression: equivalent — when ourId===theirId, mergeBase returns that same commit, so the `base === theirId` check below yields the identical up-to-date result.
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

export const UNSUPPORTED_CONFLICT_TYPES: ReadonlySet<ConflictType> = new Set([
  'rename-rename',
  'gitlink',
]);

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
    const treeResult = await computeMergeTreeResult(ctx, ourId, theirId, baseId);
    if (treeResult.kind === 'conflict') {
      return persistConflictState(ctx, opts, treeResult, ourId, theirId);
    }
    return commitCleanMerge(ctx, opts, branchName, ourId, theirId, treeResult.tree);
  } finally {
    ctx.progress.end(MERGE_WRITE_FILES_OP);
  }
};

const commitCleanMerge = async (
  ctx: Context,
  opts: MergeOptions,
  branchName: RefName,
  ourId: ObjectId,
  theirId: ObjectId,
  mergedTree: ObjectId,
): Promise<MergeResult> => {
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
};

type MergeTreeResult =
  | { readonly kind: 'clean'; readonly tree: ObjectId }
  | {
      readonly kind: 'conflict';
      readonly outcomes: ReadonlyArray<MergeOutcome>;
      readonly conflicts: ReadonlyArray<MergeConflict>;
    };

const computeMergeTreeResult = async (
  ctx: Context,
  ourId: ObjectId,
  theirId: ObjectId,
  baseId: ObjectId | undefined,
): Promise<MergeTreeResult> => {
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

  if (result.cleanMerge) {
    const tree = await synthesiseMergedTree(ctx, result.outcomes);
    return { kind: 'clean', tree };
  }
  return { kind: 'conflict', outcomes: result.outcomes, conflicts: result.conflicts };
};

const buildContentMerger =
  (ctx: Context): ContentMerger =>
  async (mergeCtx, _baseStub, _oursStub, _theirsStub): Promise<ContentMergeResult> => {
    // Parallel-capped fetch. Each blob is bounded by
    // MAX_CONFLICT_OUTPUT_BYTES; a hostile adversarial input
    // is rejected upfront via OBJECT_TOO_LARGE without ever reaching
    // `mergeContent`'s line-diff path. The Promise.all parallelism is
    // exercised by the "issue concurrently" test in merge.test.ts —
    // mutating it to a serial loop would drop maxInFlight to 1 and the
    // test would fail.
    //
    // equivalent-mutant: Stryker mutates `{ maxBytes: MAX_CONFLICT_OUTPUT_BYTES }`
    // to `{}` at the three call sites below — observationally equivalent
    // in the test suite because no fixture allocates a real
    // MAX_CONFLICT_OUTPUT_BYTES (256 MiB) blob to trigger the cap at this
    // integration boundary. The cap mechanics themselves are fully
    // covered by direct unit tests on readObject / readBlob
    // (test/unit/application/primitives/read-object.test.ts and
    // read-blob.test.ts) at every cap site (loose, pack-base,
    // pre-apply-delta, cached). The integration line is mechanical
    // wiring; allocating a 256 MiB fixture to kill these three mutants
    // would cost ~1 GiB peak RSS per CI run for ~zero additional
    // assurance.
    const [ours, theirs, base] = await Promise.all([
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      readBlob(ctx, mergeCtx.ourId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      readBlob(ctx, mergeCtx.theirId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
      mergeCtx.baseId !== undefined
        ? // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
          readBlob(ctx, mergeCtx.baseId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })
        : Promise.resolve(undefined),
    ]);
    return mergeContent(base?.content, ours.content, theirs.content);
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

export const MAX_MERGE_TREE_DEPTH = 4096;

/** Build a nested tree from flat leaf records. Exported for direct unit testing. */
export const writeNestedTree = async (
  ctx: Context,
  leaves: ReadonlyArray<LeafRecord>,
  depth = 0,
): Promise<ObjectId> => {
  // Depth cap matches `synthesizeTreeFromIndex`'s contract — an adversarial
  // commit with pathologically deep paths would otherwise exhaust the JS
  // call stack before any async tick yielded. The cap fires upstream too:
  // walkTree (via flattenTree) caps at MAX_FLAT_TREE_ENTRIES depth, but
  // re-asserting here keeps the primitive safe under future composers.
  if (depth > MAX_MERGE_TREE_DEPTH) throw treeDepthExceeded(depth);
  const { files, subdirs } = partitionByPrefix(leaves);
  // Resolve sub-trees in parallel — each branch is independent of the
  // others, so awaiting them serially would needlessly stretch the
  // merge wall time when a target tree has many top-level dirs.
  // equivalent-mutant: swapping Promise.all for a serial for-await loop
  // produces the same output (the merge is deterministic and order-
  // independent at the tree-content level). The parallelisation is a
  // performance optimisation; a unit-level mutation test cannot
  // distinguish parallel from serial without timing or call-order
  // instrumentation, so we accept the mutant as documented.
  const subdirEntries = await Promise.all(
    Array.from(subdirs, async ([prefix, subLeaves]) => ({
      name: prefix as FilePath,
      id: await writeNestedTree(ctx, subLeaves, depth + 1),
      mode: FILE_MODE.DIRECTORY,
    })),
  );
  const fileEntries = files.map((f) => ({ name: f.path, id: f.id, mode: f.mode }));
  return writeTree(ctx, [...fileEntries, ...subdirEntries]);
};

/**
 * Persist the conflicting-merge state on disk's write order:
 * working-tree files → ORIG_HEAD → MERGE_HEAD → MERGE_MSG → index.
 *
 * Unsupported conflict types are rejected upfront BEFORE any disk write
 * so the operation fails atomically (HEAD/index/working-tree untouched).
 */
const persistConflictState = async (
  ctx: Context,
  opts: MergeOptions,
  result: Extract<MergeTreeResult, { readonly kind: 'conflict' }>,
  ourId: ObjectId,
  theirId: ObjectId,
): Promise<MergeResult> => {
  rejectUnsupportedConflicts(result.conflicts);

  const lock = await acquireIndexLock(ctx);
  try {
    await writeConflictingWorkingTree(ctx, result.outcomes, result.conflicts);
    await writeOrigHead(ctx, ourId);
    await writeMergeHead(ctx, theirId);
    const message = sanitizeMessage(opts.message ?? `Merge ${opts.target}`, { allowEmpty: false });
    await writeMergeMsg(ctx, message);
    const indexEntries = buildConflictIndexEntries(result.outcomes, result.conflicts);
    await lock.commit(indexEntries);
  } finally {
    // Always release the lock — `commit` flips the lock to a no-op state
    // on success, so this is safe regardless of which path completed.
    // Matches the `try/finally` pattern in `add.ts` and `checkout.ts`.
    await lock.release();
  }

  return {
    kind: 'conflict',
    conflicts: result.conflicts.map((c) => ({ path: c.path, type: c.type })),
    mergeHead: theirId,
    origHead: ourId,
  };
};

/**
 * Reject conflict types that v1 cannot persist as resolvable merge state
 * (`rename-rename`, `gitlink`). Fires BEFORE `acquireIndexLock` in the
 * caller so an unsupported conflict surfaces atomically — no stale
 * `index.lock`, no working-tree pollution, no MERGE_HEAD on disk.
 * Exported for direct unit testing.
 */
export const rejectUnsupportedConflicts = (conflicts: ReadonlyArray<MergeConflict>): void => {
  for (const conflict of conflicts) {
    if (UNSUPPORTED_CONFLICT_TYPES.has(conflict.type)) {
      throw unsupportedOperation(
        'merge',
        `conflict type '${conflict.type}' not supported in v1 (path=${conflict.path})`,
      );
    }
  }
};

// Hard cap on concurrent path writes during a conflicting merge. Without it
// large merges (thousands of paths) blow past the default `ulimit -n`
// (256 on macOS, 1024 on most Linux) and surface as EMFILE.
const MAX_CONCURRENT_PATH_WRITES = 32;

const writeConflictingWorkingTree = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
): Promise<void> => {
  // Bounded parallelism — independent path writes overlap, but the pool
  // caps in-flight at MAX_CONCURRENT_PATH_WRITES so a 10k-path merge
  // doesn't exhaust file descriptors.
  await runBounded(outcomes, MAX_CONCURRENT_PATH_WRITES, (outcome) =>
    writeOutcomeToTree(ctx, outcome),
  );
  await runBounded(conflicts, MAX_CONCURRENT_PATH_WRITES, (conflict) =>
    writeConflictToTree(ctx, conflict),
  );
};

/**
 * Run `fn` over `items` with at most `limit` in-flight at once. Promise
 * rejection propagates upward (matches `Promise.all` semantics); in-flight
 * tasks are not cancelled. Exported for direct unit testing.
 */
export const runBounded = async <T>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    // Stryker disable next-line EqualityOperator: equivalent — `cursor <= items.length` reads `items[items.length]` (undefined) once, and the `next === undefined` break below terminates identically.
    while (cursor < items.length) {
      const next = items[cursor++];
      if (next === undefined) break;
      await fn(next);
    }
  };
  const concurrency = Math.min(limit, items.length);
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
};

/** Write a single merge outcome to the working tree. Exported for direct unit testing. */
export const writeOutcomeToTree = async (ctx: Context, outcome: MergeOutcome): Promise<void> => {
  if (outcome.status === 'unchanged' || outcome.status === 'resolved-known') {
    // Cap with MAX_CONFLICT_OUTPUT_BYTES so a hostile clean-tree blob
    // cannot OOM the merge consumer during a conflicting merge.
    // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
    const blob = await readBlob(ctx, outcome.id, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES });
    await writeWorkingTreeFile(ctx, outcome.path, blob.content);
    return;
  }
  if (outcome.status === 'resolved-merged') {
    await writeWorkingTreeFile(ctx, outcome.path, outcome.bytes);
    return;
  }
  if (outcome.status === 'resolved-deleted') {
    await removeWorkingTreeFile(ctx, outcome.path);
  }
  // 'conflict' outcomes are handled by the parallel conflicts batch.
};

const writeConflictToTree = async (ctx: Context, conflict: MergeConflict): Promise<void> => {
  const bytes = await materialiseConflictBytes(ctx, conflict);
  if (bytes !== undefined) {
    await writeWorkingTreeFile(ctx, conflict.path, bytes);
  }
};

/** Derive the working-tree bytes for a conflicting path. Exported for direct unit testing. */
export const materialiseConflictBytes = async (
  ctx: Context,
  conflict: MergeConflict,
): Promise<Uint8Array | undefined> => {
  if (conflict.type === 'content' && conflict.conflictContent !== undefined) {
    return conflict.conflictContent;
  }
  if (conflict.type === 'binary') {
    // Binary conflicts: write ours bytes verbatim (matches mergeContent's
    // existing fallback shape). User must manually choose a side.
    if (conflict.ourId !== undefined) {
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      return (await readBlob(ctx, conflict.ourId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })).content;
    }
  }
  if (conflict.type === 'add-add' || conflict.type === 'type-change') {
    if (conflict.ourId !== undefined) {
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      return (await readBlob(ctx, conflict.ourId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })).content;
    }
  }
  if (conflict.type === 'modify-delete') {
    // Preserve the surviving side's bytes (whichever has an id).
    const survivorId = conflict.ourId ?? conflict.theirId;
    if (survivorId !== undefined) {
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      return (await readBlob(ctx, survivorId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })).content;
    }
  }
  // Content conflict whose mergeContent didn't produce conflictContent —
  // build the markers from ours/theirs blobs directly.
  if (
    conflict.type === 'content' &&
    conflict.ourId !== undefined &&
    conflict.theirId !== undefined
  ) {
    const [ours, theirs] = await Promise.all([
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      readBlob(ctx, conflict.ourId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      readBlob(ctx, conflict.theirId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
    ]);
    return writeConflictMarkers([ours.content], [theirs.content]);
  }
  return undefined;
};

const writeWorkingTreeFile = async (
  ctx: Context,
  path: FilePath,
  content: Uint8Array,
): Promise<void> => {
  const fullPath = `${ctx.layout.workDir}/${path}`;
  const parent = parentDir(fullPath);
  // Stryker disable next-line BlockStatement: equivalent — the FileSystem port contract requires `write` to create parent directories ("creating parent directories as needed"), so this explicit mkdir is redundant defensive belt-and-braces.
  if (parent !== undefined) {
    await ctx.fs.mkdir(parent);
  }
  await ctx.fs.write(fullPath, content);
};

/** Remove a working-tree file if it exists. Exported for direct unit testing. */
export const removeWorkingTreeFile = async (ctx: Context, path: FilePath): Promise<void> => {
  const fullPath = `${ctx.layout.workDir}/${path}`;
  if (await ctx.fs.exists(fullPath)) {
    await ctx.fs.rm(fullPath);
  }
};

/** Compute the parent directory of a path. Exported for direct unit testing. */
export const parentDir = (fullPath: string): string | undefined => {
  const lastSlash = fullPath.lastIndexOf('/');
  if (lastSlash <= 0) return undefined;
  return fullPath.slice(0, lastSlash);
};

const zeroStat = (mode: FileMode): StatData => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
});

/** Build the conflict-state index entries. Exported for direct unit testing. */
export const buildConflictIndexEntries = (
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
): ReadonlyArray<IndexEntry> => {
  // Stage-0 entries from clean outcomes (resolved-deleted contributes
  // nothing). resolved-merged needs its bytes hashed but we already wrote
  // them — we'll re-derive the id by computing it lazily. For simplicity,
  // resolved-merged outcomes are EXCLUDED from the conflict-state index:
  // the path is left unmerged (user must add it manually) when it sits
  // alongside conflicts. This avoids needing writeObject under the index
  // lock with attendant complexity. Pure clean outcomes (unchanged /
  // resolved-known) keep their stage-0 entries.
  const stage0: IndexEntry[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'unchanged' || outcome.status === 'resolved-known') {
      stage0.push({
        ...zeroStat(outcome.mode),
        id: outcome.id,
        flags: { assumeValid: false, extended: false, stage: 0 },
        path: outcome.path,
      });
    }
  }

  const stageConflicts = conflictsToIndexEntries(conflicts, zeroStat);
  // serializeIndex sorts by path only (V8's sort is stable so the
  // upstream stage ordering survives) but the canonical git index
  // requires (path, stage) order. Sort explicitly here to make the
  // invariant load-bearing on our own code rather than V8's
  // stable-sort guarantee.
  const combined = [...stage0, ...stageConflicts];
  combined.sort((a, b) => {
    // Stryker disable next-line EqualityOperator: equivalent — for equal paths `<=`/`>=` both return -1; same-path entries always arrive stage-ascending (conflictsToIndexEntries sorts, stage-0 precedes them), so -1 already matches the correct order.
    if (a.path < b.path) return -1;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — for any distinct-path pair V8's sort derives the order from the `a.path < b.path → -1` rule above (evaluated in whichever argument order yields `<`), so this `>` branch never changes the observable sort result.
    if (a.path > b.path) return 1;
    // Stryker disable next-line ArithmeticOperator: equivalent — the stage branch only compares equal-path entries, which always arrive stage-ascending (conflictsToIndexEntries sorts conflict stages and rejects duplicate paths; stage-0 entries all share stage 0), so the comparator is a no-op on an already-ordered run regardless of sign.
    return a.flags.stage - b.flags.stage;
  });
  return combined;
};

/** Resolve the merge-commit author. Exported for direct unit testing. */
export const resolveMergeAuthor = async (
  ctx: Context,
  opts: MergeOptions,
): Promise<AuthorIdentity> => {
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

/** Resolve the merge-commit committer. Exported for direct unit testing. */
export const resolveMergeCommitter = (
  opts: MergeOptions,
  author: AuthorIdentity,
): AuthorIdentity => {
  const committerInput: {
    explicit?: AuthorIdentity;
    author?: AuthorIdentity;
    configUser?: AuthorIdentity;
  } = { author };
  if (opts.committer !== undefined) committerInput.explicit = opts.committer;
  return resolveCommitter(committerInput);
};

/** Resolve a merge target (40-hex oid or branch name). Exported for direct unit testing. */
export const resolveTarget = async (ctx: Context, target: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;
  return resolveRef(ctx, `refs/heads/${target}` as RefName);
};

const getTree = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> => {
  const obj = await readObject(ctx, commitId);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, commitId);
  return obj.data.tree;
};
