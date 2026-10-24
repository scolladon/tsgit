/**
 * What git does to a submodule before `rm` touches the working tree, ported function
 * by function: `validate_submodule_path` refuses a symbolic link anywhere on the path,
 * `submodule_uses_gitfile` tells an absorbed checkout from an embedded one (nested
 * submodules included), `absorb_git_dir_into_superproject` moves every embedded
 * repository under `modules/` and `bad_to_remove_submodule` judges local changes.
 */
import { dirname, permissionDenied, TsgitError } from '../../../domain/error.js';
import type { IndexEntry } from '../../../domain/git-index/index.js';
import { FILE_MODE } from '../../../domain/objects/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import { gitfileTooLarge, notARepository } from '../../../domain/repository/error.js';
import {
  submoduleGitDirNested,
  submoduleNameNotFound,
  submodulePathIsSymlink,
} from '../../../domain/submodule/error.js';
import { relativePathBetween } from '../../../domain/submodule/gitlink-path.js';
import type { Context } from '../../../ports/context.js';
import type { FileStat } from '../../../ports/file-system.js';
import { checkedOutHead } from '../../primitives/compare-working-tree-entry.js';
import { lstatIfReachable } from '../../primitives/internal/fs-probes.js';
import {
  isGitDirectory,
  probeGitlinkCheckout,
  statOrUnreachable,
} from '../../primitives/internal/gitlink-head.js';
import { joinPath } from '../../primitives/internal/join-working-tree-path.js';
import { realPathOf } from '../../primitives/internal/real-path.js';
import { requireWorkTree } from '../../primitives/internal/repo-state.js';
import { deriveGitlinkContext } from '../../primitives/internal/submodule-context.js';
import {
  createLeadingPathScanner,
  type LeadingPathScanner,
} from '../../primitives/internal/symlinked-leading-path.js';
import { worktreeScopedFs } from '../../primitives/internal/worktree-context.js';
import type { GitmodulesRow } from '../../primitives/parse-gitmodules.js';
import { commonGitDir } from '../../primitives/path-layout.js';
import { readIndex } from '../../primitives/read-index.js';
import { updateConfigOperations } from '../../primitives/update-config.js';
import type { StatusResult } from '../status.js';
import { type RepositoryCheckout, readGitmodulesRows } from './submodule-state.js';

const DOT_GIT = '.git';
const COMMAND = 'rm';
const UNREADABLE_DIRECTORY_CODES: ReadonlySet<string> = new Set([
  'FILE_NOT_FOUND',
  'NOT_A_DIRECTORY',
]);

const checkoutDirOf = (ctx: Context, path: FilePath): string =>
  joinPath(requireWorkTree(ctx, COMMAND), path);

const dotGitOf = (ctx: Context, path: FilePath): string => `${checkoutDirOf(ctx, path)}/${DOT_GIT}`;

/** git's `validate_submodule_path` refusal, or nothing: no component of a submodule's path, the leaf included, may be a symbolic link. */
const symlinkRefusal = async (
  ctx: Context,
  scanner: LeadingPathScanner,
  path: FilePath,
): Promise<TsgitError | undefined> => {
  const component = await scanner.symlinkedLeadingComponent(path);
  if (component !== undefined) return submodulePathIsSymlink(path, component);
  const leaf = await lstatIfReachable(ctx.fs, checkoutDirOf(ctx, path));
  return leaf?.isSymbolicLink === true ? submodulePathIsSymlink(path) : undefined;
};

/** git's `validate_submodule_path`: no component of a submodule's path, the leaf included, may be a symbolic link. */
export const validateSubmodulePath = async (
  ctx: Context,
  scanner: LeadingPathScanner,
  path: FilePath,
): Promise<void> => {
  const refusal = await symlinkRefusal(ctx, scanner, path);
  if (refusal !== undefined) throw refusal;
};

/** git's `is_empty_dir`: a directory listing nothing, through a link to one; whatever cannot be listed is not empty. */
export const isEmptyDirectory = async (ctx: Context, absolute: string): Promise<boolean> => {
  try {
    return (await ctx.fs.readdir(absolute)).length === 0;
  } catch (err) {
    if (err instanceof TsgitError && UNREADABLE_DIRECTORY_CODES.has(err.data.code)) return false;
    throw err;
  }
};

interface CheckoutGitlinks {
  readonly gitlinks: ReadonlyArray<FilePath>;
  readonly rows: ReadonlyArray<GitmodulesRow>;
}

/** The gitlinks a checkout's index records and the `.gitmodules` rows naming them; a checkout recording none reads no `.gitmodules`, as git's foreach visits nothing. */
const checkoutGitlinks = async (child: Context): Promise<CheckoutGitlinks> => {
  const { entries } = await readIndex(child);
  const gitlinks = entries
    .filter((entry) => entry.flags.stage === 0 && entry.mode === FILE_MODE.GITLINK)
    .map((entry) => entry.path);
  if (gitlinks.length === 0) return { gitlinks, rows: [] };
  const workDir = requireWorkTree(child, COMMAND);
  return { gitlinks, rows: await readGitmodulesRows(child, { workDir, entries }) };
};

/** Whether a directory stands at the gitlink's path: git's `stat` of `<path>/.git` fails beneath anything else. */
const isDirectoryAt = async (ctx: Context, path: FilePath): Promise<boolean> =>
  (await lstatIfReachable(ctx.fs, checkoutDirOf(ctx, path)))?.isDirectory === true;

/** `<path>/.git` as git's `stat` sees it, links followed: nothing usable, a regular file, a directory, or something else (a FIFO, a socket). */
type DotGitShape = 'absent' | 'file' | 'directory' | 'other';

const dotGitShapeOf = async (ctx: Context, path: FilePath): Promise<DotGitShape> => {
  const dotGit = dotGitOf(ctx, path);
  const entry = await lstatIfReachable(ctx.fs, dotGit);
  const followed = entry?.isSymbolicLink === true ? await statOrUnreachable(ctx, dotGit) : entry;
  if (followed === undefined) return 'absent';
  if (followed.isFile) return 'file';
  return followed.isDirectory ? 'directory' : 'other';
};

/**
 * `<path>/.git` as git's dying `read_gitfile` reads it: the repository it leads to, nothing
 * when it is no regular file and no repository (git's non-fatal `NOT_A_FILE`), a refusal for
 * a gitfile past the size git reads or one git cannot follow.
 */
const readableCheckout = async (
  ctx: Context,
  path: FilePath,
): Promise<RepositoryCheckout | undefined> => {
  const checkout = await probeGitlinkCheckout(ctx, path);
  if (checkout.kind === 'oversized') throw gitfileTooLarge(checkout.shown);
  if (checkout.kind === 'repository') return checkout;
  if (checkout.kind === 'broken' && (await dotGitShapeOf(ctx, path)) === 'file') {
    throw notARepository(checkout.shown);
  }
  return undefined;
};

/**
 * git's `submodule foreach --recursive test -f .git`, which runs every recorded gitlink through
 * `validate_submodule_path` and the `.gitmodules` name lookup before asking whether it is
 * populated: a symbolic link or a missing name fails the whole command, an unpopulated or
 * unreadable checkout is skipped, and a populated one must use a gitfile throughout.
 */
const nestedUseGitfiles = async (child: Context): Promise<boolean> => {
  const scanner = createLeadingPathScanner(child);
  const { gitlinks, rows } = await checkoutGitlinks(child);
  for (const path of gitlinks) {
    if ((await symlinkRefusal(child, scanner, path)) !== undefined) return false;
    if (!rows.some((row) => row.path === path)) return false;
    if (!(await isDirectoryAt(child, path))) continue;
    if ((await probeGitlinkCheckout(child, path)).kind !== 'repository') continue;
    if ((await gitfileCheckoutOf(child, path)) === undefined) return false;
  }
  return true;
};

/**
 * git's `submodule_uses_gitfile`, answering the checkout it reaches: `<path>/.git` is a
 * gitfile and every populated nested submodule follows suit. `undefined` for a missing,
 * embedded or unreadable repository; a gitfile git cannot read refuses as its `read_gitfile` dies.
 */
export const gitfileCheckoutOf = async (
  ctx: Context,
  path: FilePath,
): Promise<RepositoryCheckout | undefined> => {
  const checkout = await readableCheckout(ctx, path);
  if (checkout?.via !== 'gitfile') return undefined;
  return (await nestedUseGitfiles(await checkout.context())) ? checkout : undefined;
};

/** git's `validate_submodule_git_dir`: no leading part of the module name may already be a repository under `modules/`. */
const refuseNestedModuleDir = async (ctx: Context, name: string): Promise<void> => {
  for (let slash = name.indexOf('/'); slash !== -1; slash = name.indexOf('/', slash + 1)) {
    const inside = name.slice(0, slash);
    if (await isGitDirectory(ctx.fs, `${ctx.layout.gitDir}/modules/${inside}`)) {
      throw submoduleGitDirNested(name, inside);
    }
  }
};

/** The `.gitmodules` name git files the path's repository under; none is git's `could not lookup name` refusal. */
const moduleNameOf = (path: FilePath, rows: ReadonlyArray<GitmodulesRow>): string => {
  const row = rows.find((candidate) => candidate.path === path);
  if (row === undefined) throw submoduleNameNotFound(path);
  return row.name;
};

const moduleDirOf = (ctx: Context, name: string): string => `${ctx.layout.gitDir}/modules/${name}`;

/** Whether a repository already lies inside the superproject's own git directory, where git leaves it: real paths on both sides, as git's `real_pathdup` compares them. */
const isInsideGitDir = async (ctx: Context, realGitDir: string): Promise<boolean> => {
  const common = (await realPathOf(ctx, commonGitDir(ctx))) ?? commonGitDir(ctx);
  return realGitDir === common || realGitDir.startsWith(`${common}/`);
};

/** The repository a checkout's `.git` really leads to, every link resolved; a chain git cannot resolve refuses before anything moves. */
const realRepositoryOf = async (
  ctx: Context,
  path: FilePath,
  reached: Context,
): Promise<string> => {
  const real = await realPathOf(ctx, reached.layout.gitDir);
  if (real === undefined) throw permissionDenied(dotGitOf(ctx, path));
  return real;
};

/**
 * git's `connect_work_tree_and_git_dir`: the gitfile first, then `core.worktree` in the
 * module's config, both relative. A `.git` that cannot be written as a file — a directory,
 * a FIFO — fails or blocks exactly where git's `write_file` does.
 */
const connectWorkTreeAndGitDir = async (
  ctx: Context,
  path: FilePath,
  moduleDir: string,
): Promise<Context> => {
  const checkoutDir = checkoutDirOf(ctx, path);
  await ctx.fs.writeUtf8(
    `${checkoutDir}/${DOT_GIT}`,
    `gitdir: ${relativePathBetween(checkoutDir, moduleDir)}\n`,
  );
  const child = deriveGitlinkContext(ctx, moduleDir, path);
  await updateConfigOperations(child, [
    {
      kind: 'set',
      section: 'core',
      key: 'worktree',
      value: relativePathBetween(moduleDir, checkoutDir),
    },
  ]);
  return child;
};

/**
 * A `.git` link whose repository just moved away: git writes the gitfile through it, which
 * lands the file at the link's old target, outside the checkout; the link is replaced instead.
 */
const removeDotGitLink = async (ctx: Context, path: FilePath): Promise<void> => {
  const dotGit = dotGitOf(ctx, path);
  const entry = await lstatIfReachable(ctx.fs, dotGit);
  if (entry?.isSymbolicLink === true) await ctx.fs.rm(dotGit);
};

/**
 * git's `relocate_single_git_dir_into_superproject`: the repository `.git` really reaches — the
 * directory itself, or the one a chain of links leads to — moves under `modules/<name>` unless
 * it already lies inside the superproject's git directory, and the checkout is connected back
 * to it. The move runs through a filesystem reaching the resolved repository, wherever it lies.
 * Answers the checkout's context as it is reached afterwards.
 */
const relocateGitDir = async (
  ctx: Context,
  path: FilePath,
  rows: ReadonlyArray<GitmodulesRow>,
  checkout: RepositoryCheckout,
): Promise<Context> => {
  const name = moduleNameOf(path, rows);
  await refuseNestedModuleDir(ctx, name);
  const reached = await checkout.context();
  const realGitDir = await realRepositoryOf(ctx, path, reached);
  if (await isInsideGitDir(ctx, realGitDir)) return reached;
  const moduleDir = moduleDirOf(ctx, name);
  await ctx.fs.mkdir(dirname(moduleDir));
  await worktreeScopedFs(ctx, realGitDir).rename(realGitDir, moduleDir);
  await removeDotGitLink(ctx, path);
  return connectWorkTreeAndGitDir(ctx, path, moduleDir);
};

/** git's arm for a populated path whose `.git` leads to no repository: the name is looked up, then the checkout is connected to `modules/<name>`. */
const connectUnreadableCheckout = async (
  ctx: Context,
  path: FilePath,
  rows: ReadonlyArray<GitmodulesRow>,
): Promise<void> => {
  const name = moduleNameOf(path, rows);
  await refuseNestedModuleDir(ctx, name);
  const moduleDir = moduleDirOf(ctx, name);
  await ctx.fs.mkdir(moduleDir);
  await connectWorkTreeAndGitDir(ctx, path, moduleDir);
};

/**
 * git's `absorb_git_dir_into_superproject` for one path: an embedded repository relocates, a
 * gitfile one is entered, then the checkout's own submodules are absorbed. A `.git` that is
 * present but leads to no repository — a directory that is not one, a FIFO — is connected
 * to `modules/<name>` as git does, which needs the name first.
 */
const absorbGitDir = async (
  ctx: Context,
  path: FilePath,
  rows: ReadonlyArray<GitmodulesRow>,
): Promise<void> => {
  if ((await dotGitShapeOf(ctx, path)) === 'absent') return;
  const checkout = await readableCheckout(ctx, path);
  if (checkout === undefined) {
    await connectUnreadableCheckout(ctx, path, rows);
    return;
  }
  const child =
    checkout.via === 'directory'
      ? await relocateGitDir(ctx, path, rows, checkout)
      : await checkout.context();
  await absorbNested(child);
};

/** git's absorb-gitdirs helper run inside a checkout: every gitlink it records is validated and absorbed. */
const absorbNested = async (child: Context): Promise<void> => {
  const scanner = createLeadingPathScanner(child);
  const { gitlinks, rows } = await checkoutGitlinks(child);
  for (const path of gitlinks) {
    await validateSubmodulePath(child, scanner, path);
    await absorbGitDir(child, path, rows);
  }
};

/** git's `file_exists(path) && !is_empty_dir(path)`: something lives at the path. */
const isPopulated = async (ctx: Context, absolute: string): Promise<boolean> =>
  (await lstatIfReachable(ctx.fs, absolute)) !== undefined &&
  !(await isEmptyDirectory(ctx, absolute));

/**
 * git's `submodules_absorb_gitdir_if_needed`: before `rm` removes anything, every matched
 * gitlink that is populated and does not already use a gitfile throughout is validated and
 * absorbed, so no repository dies with its directory.
 */
export const absorbGitDirs = async (
  ctx: Context,
  scanner: LeadingPathScanner,
  gitlinks: ReadonlyArray<FilePath>,
  rows: ReadonlyArray<GitmodulesRow>,
): Promise<void> => {
  for (const path of gitlinks) {
    if (!(await isPopulated(ctx, checkoutDirOf(ctx, path)))) continue;
    await validateSubmodulePath(ctx, scanner, path);
    if (!(await isDirectoryAt(ctx, path))) continue;
    if ((await gitfileCheckoutOf(ctx, path)) !== undefined) continue;
    await absorbGitDir(ctx, path, rows);
  }
};

export type GitlinkLocalModification = 'vanished' | 'clean' | 'modified';

export type ChildStatus = (child: Context) => Promise<StatusResult>;

/** git's `ie_match_stat` on a gitlink: nothing for an entry marked valid or skip-worktree, else a type change or a moved HEAD. */
const statDiffers = async (ctx: Context, entry: IndexEntry, stat: FileStat): Promise<boolean> => {
  if (entry.flags.assumeValid || entry.flags.skipWorktree) return false;
  if (!stat.isDirectory) return true;
  const head = await checkedOutHead(ctx, entry.path);
  return head !== undefined && head !== entry.id;
};

const isDirty = ({ clean }: StatusResult): boolean => !clean;

/** git's `bad_to_remove_submodule`: an empty directory is clean, one not using gitfiles throughout is modified, else the checkout's own status decides. */
const badToRemoveSubmodule = async (
  ctx: Context,
  scanner: LeadingPathScanner,
  path: FilePath,
  childStatus: ChildStatus,
): Promise<GitlinkLocalModification> => {
  if (await isEmptyDirectory(ctx, checkoutDirOf(ctx, path))) return 'clean';
  await validateSubmodulePath(ctx, scanner, path);
  const checkout = await gitfileCheckoutOf(ctx, path);
  if (checkout === undefined) return 'modified';
  return isDirty(await childStatus(await checkout.context())) ? 'modified' : 'clean';
};

/**
 * `git rm`'s `check_local_mod` on a gitlink: vanished when nothing is at the path, modified
 * when the stat arm or git's `bad_to_remove_submodule` says so, clean otherwise.
 */
export const gitlinkLocalModification = async (
  ctx: Context,
  scanner: LeadingPathScanner,
  entry: IndexEntry,
  childStatus: ChildStatus,
): Promise<GitlinkLocalModification> => {
  const stat = await lstatIfReachable(ctx.fs, checkoutDirOf(ctx, entry.path));
  if (stat === undefined) return 'vanished';
  if (await statDiffers(ctx, entry, stat)) return 'modified';
  return badToRemoveSubmodule(ctx, scanner, entry.path, childStatus);
};
