/**
 * Pure path helpers composing `ctx.layout.gitDir` with known sub-paths.
 * No I/O. No port access. Primitive step 3.
 */
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { isPerWorktreeRef } from '../../domain/refs/index.js';
import { computeLooseObjectPath } from '../../domain/storage/loose-path.js';
import type { Context } from '../../ports/context.js';

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
export const commonGitDir = (ctx: Context): string => ctx.layout.commonDir ?? ctx.layout.gitDir;

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

export const lockSuffix = '.lock';
