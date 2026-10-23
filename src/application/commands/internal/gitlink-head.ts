import { TsgitError } from '../../../domain/error.js';
import type { FilePath, ObjectId } from '../../../domain/objects/object-id.js';
import { notARepository } from '../../../domain/repository/error.js';
import { parseCommondir, parseGitfilePointer } from '../../../domain/worktree/gitfile.js';
import { resolveWorktreePath } from '../../../domain/worktree/resolve-path.js';
import type { Context } from '../../../ports/context.js';
import type { FileSystem } from '../../../ports/file-system.js';
import type { AlternatePathProbe } from '../../../ports/object-source-access.js';
import { readUtf8IfPresent } from '../../primitives/internal/fs-probes.js';
import { refStorageOf } from '../../primitives/internal/gitlink-ref-storage.js';
import { joinPath } from '../../primitives/internal/join-working-tree-path.js';
import { hasUsableHead, requireWorkTree } from '../../primitives/internal/repo-state.js';
import { deriveGitlinkContext } from '../../primitives/internal/submodule-context.js';
import { worktreeScopedFs } from '../../primitives/internal/worktree-context.js';
import { narrowAlternatePathProbe } from '../../primitives/object-store.js';
import { resolveRefOrMissing } from '../../primitives/resolve-ref.js';

const DOT_GIT = '.git';
const COMMONDIR_FILE = 'commondir';
const SEPARATOR = '/';
const UNFOLLOWED_LINK_CODES: ReadonlySet<string> = new Set(['FILE_NOT_FOUND', 'PERMISSION_DENIED']);

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
  const { gitDir } = located;
  // HEAD is a plain file under either ref backend, so it is judged before the config is read.
  const unread = deriveGitlinkContext(ctx, gitDir, path, { fs: located.fs });
  if (!(await hasUsableHead(unread))) throw notARepository(located.shown);
  const { commonDir, fs } = await reaching(ctx, located);
  const child = deriveGitlinkContext(ctx, gitDir, path, {
    fs,
    commonDir,
    refStorage: await refStorageOf(fs, commonDir),
  });
  return resolveGitlinkHead(child);
};

/**
 * git's `resolve_gitlink_ref` reports a HEAD it cannot read as a plain failure and
 * `add` then keeps the recorded commit; only a `.git` that leads to no repository, or
 * a malformed repository format, dies. Every failure of the resolution itself is
 * therefore "no resolvable HEAD", while anything that is not a tsgit refusal is a bug.
 */
const resolveGitlinkHead = async (child: Context): Promise<ObjectId | undefined> => {
  try {
    return await resolveRefOrMissing(child, 'HEAD');
  } catch (err) {
    if (err instanceof TsgitError) return undefined;
    throw err;
  }
};

/**
 * A linked worktree's admin dir names its common dir — where shared refs and config
 * live — in `commondir`, relative to the admin dir or absolute; the filesystem is
 * widened to reach it.
 */
const reaching = async (
  ctx: Context,
  { gitDir, fs }: Located,
): Promise<{ readonly commonDir: string; readonly fs: FileSystem }> => {
  const declared = await readUtf8IfPresent(fs, `${gitDir}${SEPARATOR}${COMMONDIR_FILE}`);
  const value = declared === undefined ? undefined : parseCommondir(declared);
  if (value?.kind !== 'ok') return { commonDir: gitDir, fs };
  const commonDir = resolveWorktreePath(gitDir, value.path);
  return { commonDir, fs: worktreeScopedFs(ctx, [gitDir, commonDir]) };
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
  if (stat.isSymbolicLink) return symlinkCheckout(ctx, checkout, path);
  return gitfileCheckout(ctx, checkout, path);
};

const directoryCheckout = (ctx: Context, checkout: string, path: FilePath): Located => ({
  gitDir: `${checkout}${SEPARATOR}${DOT_GIT}`,
  shown: `${path}${SEPARATOR}${DOT_GIT}` as FilePath,
  fs: ctx.fs,
});

/**
 * git `stat`s `.git`, so a link to a repository directory is that directory, wherever it
 * lies, and a link to nothing, or one that loops, is no checkout at all; a link to a file is a gitfile.
 */
const symlinkCheckout = async (
  ctx: Context,
  checkout: string,
  path: FilePath,
): Promise<Located | undefined> => {
  const dotGit = `${checkout}${SEPARATOR}${DOT_GIT}`;
  const target = await statOrUnreachable(ctx, dotGit);
  if (target === undefined) return undefined;
  if (target.isDirectory) return linkedCheckout(ctx, checkout, path);
  return gitfileCheckout(ctx, checkout, path);
};

/**
 * A `.git` link that cannot be followed leaves nothing checked out: a dangling link, or a
 * loop or unsearchable target, which the adapters report alike as PERMISSION_DENIED.
 */
const statOrUnreachable = async (ctx: Context, dotGit: string) => {
  try {
    return await metadataOf(ctx, dotGit).stat(dotGit);
  } catch (err) {
    if (err instanceof TsgitError && UNFOLLOWED_LINK_CODES.has(err.data.code)) return undefined;
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
