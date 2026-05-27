import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import type {
  IndexResolver,
  TreeResolver,
  WorkdirEnumerator,
} from '../../../ports/snapshot-resolvers.js';
import { readObject } from '../read-object.js';
import { resolveRef } from '../resolve-ref.js';
import { createIndexSnapshot } from './index-snapshot.js';
import type { IndexSnapshot, SnapshotOptions, TreeSnapshot, WorkdirSnapshot } from './snapshot.js';
import type { StashSnapshot } from './stash-snapshot.js';
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

const refIfPresent = async (
  deps: SnapshotFactoryDeps,
  refFile: string,
): Promise<TreeSnapshot | null> => {
  const path = `${deps.ctx.layout.gitDir}/${refFile}`;
  if (!(await deps.ctx.fs.exists(path))) return null;
  return treeSnapshotFromRef(deps, refFile as RefName);
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
    stashEntry: async (stashIndex) => {
      const stashPath = `${deps.ctx.layout.gitDir}/refs/stash`;
      if (!(await deps.ctx.fs.exists(stashPath))) return null;
      // The stash log entry parsing (reflog) lives outside Wave 1 scope; the
      // factory returns null when no stash ref exists at all. A future wave
      // wires this to walk-reflog + parses the index/work/untracked tree triplet.
      void stashIndex;
      return null;
    },
  };
};
