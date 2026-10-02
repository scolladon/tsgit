/**
 * The `worktree prune --expire <gc.worktreePruneExpire>` step `git gc` runs
 * after its repack and prune: every `<commonDir>/worktrees/<id>` entry git's
 * `should_prune_worktree` condemns is deleted, then every surviving entry
 * that names the same worktree as an earlier one (or as the main worktree)
 * goes as a duplicate, and an emptied `worktrees/` dir is removed.
 *
 * Condemned regardless of expiry: a non-directory entry, and an unlocked
 * admin dir whose `gitdir` file is missing, unopenable or empty. Condemned
 * only once expired: an unlocked admin dir whose `gitdir` names a vanished
 * worktree — expired when its `index` mtime is at or before the cutoff, or
 * when that `index` cannot be stat'ed at all.
 *
 * @writes
 *   surface: worktree
 *   kind:    equivalent-under-readback
 *   format:  git-worktree-admin
 */
import { asciiLower } from '../../../domain/pretty/ascii.js';
import { resolveWorktreePath } from '../../../domain/worktree/resolve-path.js';
import type { Context } from '../../../ports/context.js';
import type { DirEntry, FileStat } from '../../../ports/file-system.js';
import { realpathAllowingMissingLeaf } from '../../primitives/internal/alternate-chain.js';
import { gitPathSyntaxOf } from '../../primitives/internal/git-path-syntax.js';
import { worktreeScopedFs } from '../../primitives/internal/worktree-context.js';
import { narrowAlternatePathProbe } from '../../primitives/object-store.js';
import { commonGitDir } from '../../primitives/path-layout.js';
import { isUnopenableFile, stripGitSuffix } from './fsck/roots.js';

export interface PruneWorktreesOptions {
  /** Unix-seconds expiry: a vanished worktree whose `index` mtime is at or before it is pruned. */
  readonly cutoff: number;
  /** `core.ignoreCase` — duplicate detection folds ASCII case, as git's path comparison does. */
  readonly ignoreCase: boolean;
}

/** A surviving admin entry and the `.git` path its `gitdir` names. */
interface KeptWorktree {
  readonly id: string;
  readonly dotGit: string;
}

const PRUNE = 'prune';
const LOCKED = 'locked';
type Verdict = typeof PRUNE | typeof LOCKED | KeptWorktree;

/** Sorts before every real id, so the main worktree wins a duplicate tie as in git's `prune_cmp`. */
const MAIN_WORKTREE_ID = '';
const TRAILING_LINE_ENDS = /[\r\n]+$/;
const MS_PER_SECOND = 1000;

/** The `gitdir` pointer without trailing line ends, or `undefined` when git cannot open it. */
const readGitdirPointer = async (ctx: Context, adminDir: string): Promise<string | undefined> => {
  try {
    return (await ctx.fs.readUtf8(`${adminDir}/gitdir`)).replace(TRAILING_LINE_ENDS, '');
  } catch (err) {
    if (isUnopenableFile(err)) return undefined;
    throw err;
  }
};

/** git's `file_exists`: a `.git` path it cannot stat reads as vanished. */
const isPresent = async (ctx: Context, dotGit: string): Promise<boolean> => {
  try {
    return await worktreeScopedFs(ctx, stripGitSuffix(dotGit)).exists(dotGit);
  } catch (err) {
    if (isUnopenableFile(err)) return false;
    throw err;
  }
};

/** git prunes a vanished worktree whose `index` it cannot stat, whatever the cutoff. */
const isExpired = async (ctx: Context, adminDir: string, cutoff: number): Promise<boolean> => {
  try {
    const { mtimeMs } = await ctx.fs.stat(`${adminDir}/index`);
    return Math.floor(mtimeMs / MS_PER_SECOND) <= cutoff;
  } catch (err) {
    if (isUnopenableFile(err)) return true;
    throw err;
  }
};

/** git's `stat` through a link: `undefined` where it finds nothing it can open. */
const statFollowing = async (ctx: Context, path: string): Promise<FileStat | undefined> => {
  try {
    return await ctx.fs.stat(path);
  } catch (err) {
    if (isUnopenableFile(err)) return undefined;
    throw err;
  }
};

/** git's `is_directory` on a registry entry, which follows a symlink. */
const isAdminDirectory = async (ctx: Context, path: string, entry: DirEntry): Promise<boolean> =>
  entry.isSymbolicLink ? (await statFollowing(ctx, path))?.isDirectory === true : entry.isDirectory;

/** git realpaths the admin dir, so a relative `gitdir` resolves beside a link's target. */
const dotGitOf = async (ctx: Context, adminDir: string, pointer: string): Promise<string> =>
  resolveWorktreePath(
    pointer.startsWith('/') ? adminDir : await realAdminDir(ctx, adminDir),
    pointer,
  );

const realAdminDir = async (ctx: Context, adminDir: string): Promise<string> =>
  (await realpathAllowingMissingLeaf(
    gitPathSyntaxOf(ctx),
    ctx.alternatePathProbe?.(adminDir) ?? narrowAlternatePathProbe(ctx.fs),
    adminDir,
    adminDir,
  )) ?? adminDir;

/** git's `should_prune_worktree` for an admin directory; a locked one is kept but never compared for duplicates. */
const verdictFor = async (ctx: Context, id: string, cutoff: number): Promise<Verdict> => {
  const adminDir = `${commonGitDir(ctx)}/worktrees/${id}`;
  if (await ctx.fs.exists(`${adminDir}/locked`)) return LOCKED;
  const pointer = await readGitdirPointer(ctx, adminDir);
  if (pointer === undefined || pointer === '') return PRUNE;
  const dotGit = await dotGitOf(ctx, adminDir, pointer);
  if (!(await isPresent(ctx, dotGit)) && (await isExpired(ctx, adminDir, cutoff))) return PRUNE;
  return { id, dotGit };
};

/**
 * git's `delete_git_dir`, short of following a link into the directory it
 * names: a dangling link is left, as git finds nothing to open behind it;
 * any other entry is removed, a link without its target.
 */
const deleteAdminEntry = async (ctx: Context, path: string): Promise<void> => {
  const isLink = (await ctx.fs.lstat(path)).isSymbolicLink;
  if (isLink && (await statFollowing(ctx, path)) === undefined) return;
  await ctx.fs.rmRecursive(path);
};

const byDotGitThenId =
  (fold: (path: string) => string) =>
  (a: KeptWorktree, b: KeptWorktree): number => {
    const left = fold(a.dotGit);
    const right = fold(b.dotGit);
    if (left !== right) return left < right ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  };

/** git's `prune_dups`: every entry naming the same path as the one sorted before it. */
const duplicateIds = (
  kept: ReadonlyArray<KeptWorktree>,
  fold: (path: string) => string,
): ReadonlyArray<string> => {
  const sorted = [...kept].sort(byDotGitThenId(fold));
  const duplicates: string[] = [];
  sorted.reduce((previous, current) => {
    if (fold(previous.dotGit) === fold(current.dotGit)) duplicates.push(current.id);
    return current;
  });
  return duplicates;
};

/** git's `delete_worktrees_dir_if_empty`: an `rmdir` that only ever removes an empty dir. */
const removeIfEmpty = async (ctx: Context, root: string): Promise<void> => {
  if ((await ctx.fs.readdir(root)).length === 0) await ctx.fs.rm(root);
};

export const pruneWorktrees = async (ctx: Context, opts: PruneWorktreesOptions): Promise<void> => {
  const root = `${commonGitDir(ctx)}/worktrees`;
  if (!(await ctx.fs.exists(root))) return;
  const kept: KeptWorktree[] = [{ id: MAIN_WORKTREE_ID, dotGit: commonGitDir(ctx) }];
  for (const entry of await ctx.fs.readdir(root)) {
    const path = `${root}/${entry.name}`;
    const isAdmin = await isAdminDirectory(ctx, path, entry);
    const verdict = isAdmin ? await verdictFor(ctx, entry.name, opts.cutoff) : PRUNE;
    if (verdict === PRUNE) await deleteAdminEntry(ctx, path);
    else if (verdict !== LOCKED) kept.push(verdict);
  }
  const fold = opts.ignoreCase ? asciiLower : (path: string) => path;
  for (const id of duplicateIds(kept, fold)) await deleteAdminEntry(ctx, `${root}/${id}`);
  await removeIfEmpty(ctx, root);
};
