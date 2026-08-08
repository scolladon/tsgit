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
 * Repository working-tree root. Returns the workDir from the current context;
 * facade-tier code is responsible for discovery / realpath pinning
 * at construction time. Primitives consume the already-resolved path.
 */
export const getRepoRoot = (ctx: Context): FilePath => ctx.layout.workDir as FilePath;

/**
 * The shared (common) git dir: objects, `packed-refs`, `config`, shared refs and
 * their reflogs live here. For a normal repo or the main worktree this is the
 * `gitDir`; for a linked worktree it is the repository's common dir, while
 * per-worktree state (HEAD/index/…) stays under `gitDir`.
 */
export const commonDirOf = (layout: RepositoryLayout): string => layout.commonDir ?? layout.gitDir;

export const commonGitDir = (ctx: Context): string => commonDirOf(ctx.layout);

/**
 * The git dir that backs `name`'s loose ref / reflog: a per-worktree ref (HEAD,
 * ORIG_HEAD, refs/bisect/…) lives in the worktree's own `gitDir`; every shared
 * ref lives in the common dir. The single source for the ref/reflog split.
 */
export const perWorktreeRefDir = (ctx: Context, name: RefName): string =>
  isPerWorktreeRef(name) ? ctx.layout.gitDir : commonGitDir(ctx);

export const looseObjectPath = (gitDir: string, id: ObjectId): string =>
  `${gitDir}/objects/${computeLooseObjectPath(id)}`;

export const looseRefPath = (gitDir: string, name: RefName): string => `${gitDir}/${name}`;

export const packedRefsPath = (gitDir: string): string => `${gitDir}/packed-refs`;

export const indexPath = (gitDir: string): string => `${gitDir}/index`;

export const objectsDir = (gitDir: string, prefix: string): string => `${gitDir}/objects/${prefix}`;

export const packsDir = (gitDir: string): string => `${gitDir}/objects/pack`;

export const logsDir = (gitDir: string): string => `${gitDir}/logs`;

export const reflogPath = (gitDir: string, ref: RefName): string => `${gitDir}/logs/${ref}`;

export const sparseCheckoutPath = (gitDir: string): string => `${gitDir}/info/sparse-checkout`;

export const shallowFilePath = (gitDir: string): string => `${gitDir}/shallow`;

export const shallowLockPath = (gitDir: string): string => `${gitDir}/shallow.lock`;

/** The single-file commit-graph. Absent when the repo has no commit-graph or uses the chain form. */
export const commitGraphPath = (gitDir: string): string => `${gitDir}/objects/info/commit-graph`;

/** Chain manifest: one lowercase-hex layer hash per line, base→tip. */
export const commitGraphChainPath = (gitDir: string): string =>
  `${gitDir}/objects/info/commit-graphs/commit-graph-chain`;

/** One chain layer's graph file, named by its content hash. */
export const commitGraphLayerPath = (gitDir: string, hash: string): string =>
  `${gitDir}/objects/info/commit-graphs/graph-${hash}.graph`;

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
