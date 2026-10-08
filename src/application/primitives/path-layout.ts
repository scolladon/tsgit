/**
 * Pure path helpers composing `ctx.layout.gitDir` with known sub-paths.
 * No I/O. No port access. Primitive step 3.
 */
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { isPerWorktreeRef } from '../../domain/refs/index.js';
import { computeLooseObjectPath } from '../../domain/storage/loose-path.js';
import type { Context, RepositoryLayout } from '../../ports/context.js';

/**
 * Repository root. The working tree when the repository has one; the gitDir
 * itself for a bare repository or a work-tree-less discovery. Facade-tier
 * code is responsible for discovery / realpath pinning at construction time;
 * primitives consume the already-resolved path.
 */
export const getRepoRoot = (ctx: Context): FilePath =>
  (ctx.layout.workDir ?? ctx.layout.gitDir) as FilePath;

/**
 * The shared (common) git dir: objects, `packed-refs`, `config`, shared refs and
 * their reflogs live here. For a normal repo or the main worktree this is the
 * `gitDir`; for a linked worktree it is the repository's common dir, while
 * per-worktree state (HEAD/index/…) stays under `gitDir`.
 */
// Written as the explicit undefined test, not `??`: `commonDir` is never the
// empty string, so a `??`→`||` mutant would be equivalent noise where this
// form keeps every mutant killable.
export const commonDirOf = (layout: RepositoryLayout): string =>
  layout.commonDir === undefined ? layout.gitDir : layout.commonDir;

/**
 * Working directory for a spawned child process (hook, signer, textconv,
 * merge/filter driver): the work tree when the repository has one, else the
 * gitDir — git's own bare hooks run with `PWD=<bare.git>`. Same value as
 * `getRepoRoot`, distinct in intent: this names the spawn contract, so call
 * sites stop restating its why-comment.
 */
export const getSpawnCwd = (layout: RepositoryLayout): string => layout.workDir ?? layout.gitDir;

export const commonGitDir = (ctx: Context): string => commonDirOf(ctx.layout);

/**
 * The git dir that backs `name`'s loose ref / reflog: a per-worktree ref (HEAD,
 * ORIG_HEAD, refs/bisect/…) lives in the worktree's own `gitDir`; every shared
 * ref lives in the common dir. The single source for the ref/reflog split.
 */
export const perWorktreeRefDir = (ctx: Context, name: RefName): string =>
  isPerWorktreeRef(name) ? ctx.layout.gitDir : commonGitDir(ctx);

/** A repository's own `objects` directory — the primary object store. */
export const objectsDirOf = (gitDir: string): string => `${gitDir}/objects`;

/** Loose-object path under an arbitrary `objects` directory (primary or alternate). */
export const looseObjectPathIn = (objectsDirectory: string, id: ObjectId): string =>
  `${objectsDirectory}/${computeLooseObjectPath(id)}`;

export const looseObjectPath = (gitDir: string, id: ObjectId): string =>
  looseObjectPathIn(objectsDirOf(gitDir), id);

/** A loose fanout directory (`<objects>/xx`) under an arbitrary `objects` directory. */
export const fanoutDirIn = (objectsDirectory: string, prefix: string): string =>
  `${objectsDirectory}/${prefix}`;

export const looseRefPath = (gitDir: string, name: RefName): string => `${gitDir}/${name}`;

export const packedRefsPath = (gitDir: string): string => `${gitDir}/packed-refs`;

/** The reftable backend's stack directory — the files-backend's `refs/` counterpart. */
export const reftableDir = (gitDir: string): string => `${gitDir}/reftable`;

/** The reftable stack's ordered table list, oldest → newest. */
export const tablesListPath = (gitDir: string): string => `${gitDir}/reftable/tables.list`;

/** The lock file a reftable transaction holds while `tables.list` is being rewritten. */
export const tablesListLockPath = (gitDir: string): string => `${gitDir}/reftable/tables.list.lock`;

/** The lock a compacting transaction holds on one table while it is part of
 *  an in-progress merge segment — `<table>.ref.lock`, observed alongside
 *  `tables.list.lock` during auto-compaction. */
export const reftableTableLockPath = (gitDir: string, tableName: string): string =>
  `${reftableDir(gitDir)}/${tableName}.lock`;

export const indexPath = (gitDir: string): string => `${gitDir}/index`;

export const objectsDir = (gitDir: string, prefix: string): string =>
  fanoutDirIn(objectsDirOf(gitDir), prefix);

export const packsDir = (gitDir: string): string => `${gitDir}/objects/pack`;

export const packsDirIn = (objectsDirectory: string): string => `${objectsDirectory}/pack`;

export const logsDir = (gitDir: string): string => `${gitDir}/logs`;

export const reflogPath = (gitDir: string, ref: RefName): string => `${gitDir}/logs/${ref}`;

export const sparseCheckoutPath = (gitDir: string): string => `${gitDir}/info/sparse-checkout`;

export const shallowFilePath = (gitDir: string): string => `${gitDir}/shallow`;

export const shallowLockPath = (gitDir: string): string => `${gitDir}/shallow.lock`;

/** The single-file commit-graph of one object store. */
export const commitGraphPathIn = (objectsDir: string): string => `${objectsDir}/info/commit-graph`;

/** Chain manifest of one object store: one lowercase-hex layer hash per line, base→tip. */
export const commitGraphChainPathIn = (objectsDir: string): string =>
  `${objectsDir}/info/commit-graphs/commit-graph-chain`;

/** One chain layer's graph file in one object store, named by its content hash. */
export const commitGraphLayerPathIn = (objectsDir: string, hash: string): string =>
  `${objectsDir}/info/commit-graphs/graph-${hash}.graph`;

/** The single-file commit-graph. Absent when the repo has no commit-graph or uses the chain form. */
export const commitGraphPath = (gitDir: string): string => commitGraphPathIn(`${gitDir}/objects`);

/** Chain manifest: one lowercase-hex layer hash per line, base→tip. */
export const commitGraphChainPath = (gitDir: string): string =>
  commitGraphChainPathIn(`${gitDir}/objects`);

/** The directory holding the chain manifest and its layer files. */
export const commitGraphLayersDir = (gitDir: string): string =>
  `${gitDir}/objects/info/commit-graphs`;

/** One chain layer's graph file, named by its content hash. */
export const commitGraphLayerPath = (gitDir: string, hash: string): string =>
  commitGraphLayerPathIn(`${gitDir}/objects`, hash);

/**
 * The flat multi-pack-index. Absent when the repo has no midx or uses the
 * chain form. Takes the PACKS directory, not gitDir — unlike its
 * commit-graph siblings above — because `loadMidxSet` fixes its own root at
 * the packs directory `scanPacks` already resolved.
 */
export const multiPackIndexPath = (packsDir: string): string => `${packsDir}/multi-pack-index`;

/** Chain manifest: one lowercase-hex layer digest per line, base → tip. */
export const multiPackIndexChainPath = (packsDir: string): string =>
  `${packsDir}/multi-pack-index.d/multi-pack-index-chain`;

/** One chain layer's midx file, named by that layer's own trailer digest. */
export const multiPackIndexLayerPath = (packsDir: string, digest: string): string =>
  `${packsDir}/multi-pack-index.d/multi-pack-index-${digest}.midx`;

export const lockSuffix = '.lock';
