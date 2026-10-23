import { TsgitError } from '../../../domain/error.js';
import type { FilePath, ObjectId } from '../../../domain/objects/object-id.js';
import { notARepository } from '../../../domain/repository/error.js';
import { parseGitfilePointer } from '../../../domain/worktree/gitfile.js';
import { resolveWorktreePath } from '../../../domain/worktree/resolve-path.js';
import type { Context } from '../../../ports/context.js';
import { joinPath } from '../../primitives/internal/join-working-tree-path.js';
import { hasUsableHead, requireWorkTree } from '../../primitives/internal/repo-state.js';
import { deriveGitlinkContext } from '../../primitives/internal/submodule-context.js';
import { resolveRefOrMissing } from '../../primitives/resolve-ref.js';

const DOT_GIT = '.git';
const SEPARATOR = '/';

/** Where a checkout's repository lies on disk, and the path git names it by when it is broken. */
interface Located {
  readonly gitDir: string;
  readonly shown: FilePath;
}

/**
 * The commit checked out at a gitlink, read as git's `resolve_gitlink_ref` does:
 * through `<path>/.git`, a directory or a gitfile whose target may lie anywhere
 * (it is only read, never written). `undefined` when nothing is checked out
 * there or the checkout has no commit; a `.git` that leads to no repository
 * refuses, as git dies on it.
 */
export const gitlinkHeadOf = async (
  ctx: Context,
  path: FilePath,
): Promise<ObjectId | undefined> => {
  const checkout = joinPath(requireWorkTree(ctx, 'add'), path);
  const stat = await lstatOrMissing(ctx, `${checkout}${SEPARATOR}${DOT_GIT}`);
  if (stat === undefined) return undefined;
  const { gitDir, shown } = stat.isDirectory
    ? directoryCheckout(checkout, path)
    : await gitfileCheckout(ctx, checkout, path);
  const child = deriveGitlinkContext(ctx, gitDir, path);
  if (!(await hasUsableHead(child))) throw notARepository(shown);
  return resolveRefOrMissing(child, 'HEAD');
};

const directoryCheckout = (checkout: string, path: FilePath): Located => ({
  gitDir: `${checkout}${SEPARATOR}${DOT_GIT}`,
  shown: `${path}${SEPARATOR}${DOT_GIT}` as FilePath,
});

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
  return { gitDir: resolveWorktreePath(checkout, pointer.path), shown: shown as FilePath };
};

const lstatOrMissing = async (ctx: Context, absolute: string) => {
  try {
    return await ctx.fs.lstat(absolute);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
};
