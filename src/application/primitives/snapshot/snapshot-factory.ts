import { TsgitError } from '../../../domain/error.js';
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import type {
  IndexResolver,
  TreeResolver,
  WorkdirEnumerator,
} from '../../../ports/snapshot-resolvers.js';
import { readObject } from '../read-object.js';
import { readReflog } from '../reflog-store.js';
import { resolveRef } from '../resolve-ref.js';
import { createIndexSnapshot } from './index-snapshot.js';
import type { IndexSnapshot, SnapshotOptions, TreeSnapshot, WorkdirSnapshot } from './snapshot.js';
import { createStashSnapshot, type StashSnapshot } from './stash-snapshot.js';
import { createTreeSnapshot } from './tree-snapshot.js';
import { createWorkdirSnapshot, type WorkdirSnapshotOptions } from './workdir-snapshot.js';

export interface SnapshotFactoryDeps {
  readonly ctx: Context;
  readonly indexResolver: IndexResolver;
  readonly treeResolver: TreeResolver;
  readonly workdirEnumerator: WorkdirEnumerator;
}

export interface SnapshotFactory {
  head(opts?: SnapshotOptions): TreeSnapshot;
  commit(oid: ObjectId, opts?: SnapshotOptions): TreeSnapshot;
  tree(oid: ObjectId, opts?: SnapshotOptions): TreeSnapshot;
  index(opts?: SnapshotOptions): IndexSnapshot;
  workdir(opts?: WorkdirSnapshotOptions): WorkdirSnapshot;
  mergeHead(opts?: SnapshotOptions): Promise<TreeSnapshot | null>;
  cherryPickHead(opts?: SnapshotOptions): Promise<TreeSnapshot | null>;
  revertHead(opts?: SnapshotOptions): Promise<TreeSnapshot | null>;
  fetchHead(opts?: SnapshotOptions): Promise<TreeSnapshot | null>;
  stashEntry(stashIndex: number, opts?: SnapshotOptions): Promise<StashSnapshot | null>;
}

const COMMIT_REF_FILES = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'FETCH_HEAD'] as const;

/**
 * Build a lazy `TreeSnapshot` whose root tree is resolved on first
 * iteration. The construction is purely synchronous — no I/O happens
 * until the consumer iterates (design §9 + ADR-149).
 */
const lazyTree = (deps: SnapshotFactoryDeps, treeId: ObjectId): TreeSnapshot =>
  createTreeSnapshot({ ctx: deps.ctx, treeResolver: deps.treeResolver }, treeId);

const treeIdFromCommit = async (ctx: Context, commitOid: ObjectId): Promise<ObjectId> => {
  const obj = await readObject(ctx, commitOid);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, commitOid);
  return obj.data.tree;
};

/**
 * Resolves a ref to its tree oid. The returned snapshot defers parsing
 * the tree itself until iterated; this helper only peeks at the commit
 * to learn the tree pointer.
 */
const treeSnapshotFromRef = async (
  deps: SnapshotFactoryDeps,
  ref: RefName | 'HEAD',
): Promise<TreeSnapshot> => {
  const commitId = await resolveRef(deps.ctx, ref, { peel: true });
  const treeId = await treeIdFromCommit(deps.ctx, commitId);
  return lazyTree(deps, treeId);
};

/**
 * Codes that may surface when a ref file disappears between the
 * `fs.exists` probe and the subsequent `resolveRef` read (the TOCTOU
 * window is narrow but non-zero). Either way the caller's contract is
 * `null` — "no compound state of that kind exists right now."
 */
const REF_DISAPPEARED_CODES = new Set(['FILE_NOT_FOUND', 'REF_NOT_FOUND']);

const refIfPresent = async (
  deps: SnapshotFactoryDeps,
  refFile: string,
): Promise<TreeSnapshot | null> => {
  const path = `${deps.ctx.layout.gitDir}/${refFile}`;
  // equivalent-mutant: skipping this fast-exit (mutant: `if (false)`) is
  // observably equivalent because the try/catch below also returns `null`
  // when `resolveRef` raises `REF_NOT_FOUND`. The early exit is kept as a
  // fast path so the absent case does not pay for one ref-store lookup.
  if (!(await deps.ctx.fs.exists(path))) return null;
  try {
    return await treeSnapshotFromRef(deps, refFile as RefName);
  } catch (err) {
    if (err instanceof TsgitError && REF_DISAPPEARED_CODES.has(err.data.code)) return null;
    throw err;
  }
};

const compoundFactory =
  (deps: SnapshotFactoryDeps, refFile: (typeof COMMIT_REF_FILES)[number]) =>
  async (): Promise<TreeSnapshot | null> =>
    refIfPresent(deps, refFile);

/**
 * Pulls the resolvers, enumerator, and `Context` together behind a
 * single facade. Every factory method either is purely synchronous
 * (`head`, `commit`, `tree`, `index`, `workdir`) or returns a promise
 * solely because it has to check ref-file existence first. None of
 * them parse the underlying source until the returned snapshot is
 * iterated (design §9 construction discipline).
 */
export const createSnapshotFactory = (deps: SnapshotFactoryDeps): SnapshotFactory => {
  const tree = (oid: ObjectId): TreeSnapshot => lazyTree(deps, oid);

  return {
    head: () => {
      const snapshot: TreeSnapshot = {
        kind: 'commit',
        entries: async function* (opts) {
          const inner = await treeSnapshotFromRef(deps, 'HEAD');
          yield* inner.entries(opts);
        },
      };
      return snapshot;
    },
    commit: (oid) => {
      const snapshot: TreeSnapshot = {
        kind: 'commit',
        entries: async function* (opts) {
          const treeId = await treeIdFromCommit(deps.ctx, oid);
          yield* lazyTree(deps, treeId).entries(opts);
        },
      };
      return snapshot;
    },
    tree,
    index: () => createIndexSnapshot({ ctx: deps.ctx, indexResolver: deps.indexResolver }),
    workdir: (opts) =>
      createWorkdirSnapshot({ ctx: deps.ctx, enumerator: deps.workdirEnumerator }, opts),
    mergeHead: compoundFactory(deps, 'MERGE_HEAD'),
    cherryPickHead: compoundFactory(deps, 'CHERRY_PICK_HEAD'),
    revertHead: compoundFactory(deps, 'REVERT_HEAD'),
    fetchHead: compoundFactory(deps, 'FETCH_HEAD'),
    stashEntry: (stashIndex) => stashEntry(deps, stashIndex),
  };
};

const STASH_REF = 'refs/stash' as RefName;

const commitTree = async (ctx: Context, commitOid: ObjectId): Promise<ObjectId> => {
  const obj = await readObject(ctx, commitOid);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, commitOid);
  return obj.data.tree;
};

/**
 * Parse the stash entry at stack index `stashIndex` (0 = newest) into its
 * `StashSnapshot` trio. Resolves the W commit from the `refs/stash` reflog and
 * reads W's parents to locate the trees — `W^{tree}` (workdir), `W^2^{tree}`
 * (index), and `W^3^{tree}` (untracked, present only on an `--include-untracked`
 * stash). Returns `null` when the stash ref / reflog is absent or the index is
 * out of range. Tree iteration is deferred until a snapshot is iterated.
 */
const stashEntry = async (
  deps: SnapshotFactoryDeps,
  stashIndex: number,
): Promise<StashSnapshot | null> => {
  const stored = await readReflog(deps.ctx, STASH_REF);
  const reflog = stored[stored.length - 1 - stashIndex];
  if (reflog === undefined) return null;
  const wObj = await readObject(deps.ctx, reflog.newId);
  if (wObj.type !== 'commit') throw unexpectedObjectType('commit', wObj.type, reflog.newId);
  const [, indexParent, untrackedParent] = wObj.data.parents;
  if (indexParent === undefined) return null;
  const indexTree = await commitTree(deps.ctx, indexParent);
  const untracked =
    untrackedParent !== undefined
      ? lazyTree(deps, await commitTree(deps.ctx, untrackedParent))
      : null;
  return createStashSnapshot({
    index: lazyTree(deps, indexTree),
    workdir: lazyTree(deps, wObj.data.tree),
    untracked,
  });
};
