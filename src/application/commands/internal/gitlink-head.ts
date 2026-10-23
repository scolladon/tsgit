import { TsgitError } from '../../../domain/error.js';
import type { FilePath, ObjectId } from '../../../domain/objects/object-id.js';
import { notARepository } from '../../../domain/repository/error.js';
import { parseGitfilePointer } from '../../../domain/worktree/gitfile.js';
import { resolveWorktreePath } from '../../../domain/worktree/resolve-path.js';
import type { Context } from '../../../ports/context.js';
import type { FileSystem } from '../../../ports/file-system.js';
import type { AlternatePathProbe } from '../../../ports/object-source-access.js';
import { joinPath } from '../../primitives/internal/join-working-tree-path.js';
import { hasUsableHead, requireWorkTree } from '../../primitives/internal/repo-state.js';
import { deriveGitlinkContext } from '../../primitives/internal/submodule-context.js';
import { worktreeScopedFs } from '../../primitives/internal/worktree-context.js';
import { narrowAlternatePathProbe } from '../../primitives/object-store.js';
import { resolveRefOrMissing } from '../../primitives/resolve-ref.js';

const DOT_GIT = '.git';
const SEPARATOR = '/';

/** Where a checkout's repository lies on disk, the path git names it by when it is broken, and the filesystem that reaches it. */
interface Located {
  readonly gitDir: string;
  readonly shown: FilePath;
  readonly fs: FileSystem;
}

/**
 * The commit checked out at a gitlink, read as git's `resolve_gitlink_ref` does:
 * through `<path>/.git`, a directory, a symlink to one, or a gitfile whose target
 * may lie anywhere (it is only read, never written). `undefined` when nothing is
 * checked out there or the checkout has no commit; a `.git` that leads to no
 * repository refuses, as git dies on it.
 */
export const gitlinkHeadOf = async (
  ctx: Context,
  path: FilePath,
): Promise<ObjectId | undefined> => {
  const checkout = joinPath(requireWorkTree(ctx, 'add'), path);
  const located = await locateCheckout(ctx, checkout, path);
  if (located === undefined) return undefined;
  const child = deriveGitlinkContext(ctx, located.gitDir, path, { fs: located.fs });
  if (!(await hasUsableHead(child))) throw notARepository(located.shown);
  return resolveRefOrMissing(child, 'HEAD');
};

const locateCheckout = async (
  ctx: Context,
  checkout: string,
  path: FilePath,
): Promise<Located | undefined> => {
  const dotGit = `${checkout}${SEPARATOR}${DOT_GIT}`;
  const stat = await lstatOrMissing(ctx, dotGit);
  if (stat === undefined) return undefined;
  if (stat.isDirectory) return directoryCheckout(ctx, checkout, path);
  if (stat.isSymbolicLink && (await linksToDirectory(ctx, dotGit))) {
    return linkedCheckout(ctx, checkout, path);
  }
  return gitfileCheckout(ctx, checkout, path);
};

const directoryCheckout = (ctx: Context, checkout: string, path: FilePath): Located => ({
  gitDir: `${checkout}${SEPARATOR}${DOT_GIT}`,
  shown: `${path}${SEPARATOR}${DOT_GIT}` as FilePath,
  fs: ctx.fs,
});

/** git `stat`s `.git`, so a link to a repository directory is that directory, wherever it lies. */
const linksToDirectory = async (ctx: Context, dotGit: string): Promise<boolean> => {
  try {
    return (await metadataOf(ctx, dotGit).stat(dotGit)).isDirectory;
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return false;
    throw err;
  }
};

const metadataOf = (ctx: Context, path: string): AlternatePathProbe =>
  ctx.alternatePathProbe?.(path) ?? narrowAlternatePathProbe(ctx.fs);

const linkedCheckout = async (ctx: Context, checkout: string, path: FilePath): Promise<Located> => {
  const dotGit = `${checkout}${SEPARATOR}${DOT_GIT}`;
  const gitDir = resolveWorktreePath(checkout, await metadataOf(ctx, dotGit).readlink(dotGit));
  return {
    gitDir,
    shown: `${path}${SEPARATOR}${DOT_GIT}` as FilePath,
    fs: worktreeScopedFs(ctx, gitDir),
  };
};

const gitfileCheckout = async (
  ctx: Context,
  checkout: string,
  path: FilePath,
): Promise<Located> => {
  const dotGit = `${path}${SEPARATOR}${DOT_GIT}` as FilePath;
  const pointer = parseGitfilePointer(await ctx.fs.readUtf8(`${checkout}${SEPARATOR}${DOT_GIT}`));
  if (pointer.kind !== 'ok') throw notARepository(dotGit);
  const shown = pointer.path.startsWith(SEPARATOR)
    ? pointer.path
    : `${path}${SEPARATOR}${pointer.path}`;
  const gitDir = resolveWorktreePath(checkout, pointer.path);
  return { gitDir, shown: shown as FilePath, fs: worktreeScopedFs(ctx, gitDir) };
};

const lstatOrMissing = async (ctx: Context, absolute: string) => {
  try {
    return await ctx.fs.lstat(absolute);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
};
