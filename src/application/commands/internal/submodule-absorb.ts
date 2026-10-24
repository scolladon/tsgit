/**
 * What git does to a submodule before `rm` touches the working tree, ported function
 * by function: `validate_submodule_path` refuses a symbolic link anywhere on the path,
 * `submodule_uses_gitfile` tells an absorbed checkout from an embedded one (nested
 * submodules included), `absorb_git_dir_into_superproject` moves every embedded
 * repository under `modules/` and `bad_to_remove_submodule` judges local changes.
 */
import { dirname, TsgitError } from '../../../domain/error.js';
import type { IndexEntry } from '../../../domain/git-index/index.js';
import { FILE_MODE } from '../../../domain/objects/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
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
import { isGitDirectory, probeGitlinkCheckout } from '../../primitives/internal/gitlink-head.js';
import { joinPath } from '../../primitives/internal/join-working-tree-path.js';
import { requireWorkTree } from '../../primitives/internal/repo-state.js';
import { deriveGitlinkContext } from '../../primitives/internal/submodule-context.js';
import {
  createLeadingPathScanner,
  type LeadingPathScanner,
} from '../../primitives/internal/symlinked-leading-path.js';
import type { GitmodulesRow } from '../../primitives/parse-gitmodules.js';
import { readIndex } from '../../primitives/read-index.js';
import { updateConfigOperations } from '../../primitives/update-config.js';
import type { StatusResult } from '../status.js';
import {
  populatedCheckout,
  type RepositoryCheckout,
  readGitmodulesRows,
} from './submodule-state.js';

const DOT_GIT = '.git';
const COMMAND = 'rm';
const UNREADABLE_DIRECTORY_CODES: ReadonlySet<string> = new Set([
  'FILE_NOT_FOUND',
  'NOT_A_DIRECTORY',
]);

/** git's `validate_submodule_path`: no component of a submodule's path, the leaf included, may be a symbolic link. */
export const validateSubmodulePath = async (
  ctx: Context,
  scanner: LeadingPathScanner,
  path: FilePath,
): Promise<void> => {
  const component = await scanner.symlinkedLeadingComponent(path);
  if (component !== undefined) throw submodulePathIsSymlink(path, component);
  const leaf = await lstatIfReachable(ctx.fs, joinPath(requireWorkTree(ctx, COMMAND), path));
  if (leaf?.isSymbolicLink === true) throw submodulePathIsSymlink(path);
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

/** The gitlinks a checkout's index records and the `.gitmodules` rows naming them. */
const checkoutGitlinks = async (child: Context): Promise<CheckoutGitlinks> => {
  const { entries } = await readIndex(child);
  const stage0 = entries.filter((entry) => entry.flags.stage === 0);
  const workDir = requireWorkTree(child, COMMAND);
  const source = { workDir, stage0: new Map(stage0.map((entry) => [entry.path, entry])) };
  return {
    gitlinks: stage0.filter((entry) => entry.mode === FILE_MODE.GITLINK).map((entry) => entry.path),
    rows: await readGitmodulesRows(child, source),
  };
};

/** Whether a directory stands at the gitlink's path: git's `stat` of `<path>/.git` fails beneath anything else. */
const isDirectoryAt = async (ctx: Context, path: FilePath): Promise<boolean> =>
  (await lstatIfReachable(ctx.fs, joinPath(requireWorkTree(ctx, COMMAND), path)))?.isDirectory ===
  true;

/** git's `submodule foreach --recursive test -f .git`: every populated nested submodule is named and uses a gitfile. */
const nestedUseGitfiles = async (child: Context): Promise<boolean> => {
  const { gitlinks, rows } = await checkoutGitlinks(child);
  for (const path of gitlinks) {
    if (!(await isDirectoryAt(child, path))) continue;
    if ((await probeGitlinkCheckout(child, path)).kind !== 'repository') continue;
    if (!rows.some((row) => row.path === path)) return false;
    if ((await gitfileCheckoutOf(child, path)) === undefined) return false;
  }
  return true;
};

/**
 * git's `submodule_uses_gitfile`, answering the checkout it reaches: `<path>/.git` is a
 * gitfile and every populated nested submodule follows suit. `undefined` for a missing or
 * embedded repository; a gitfile git cannot read refuses as git's `read_gitfile` dies.
 */
export const gitfileCheckoutOf = async (
  ctx: Context,
  path: FilePath,
): Promise<RepositoryCheckout | undefined> => {
  const checkout = await populatedCheckout(ctx, path);
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

/**
 * git's `relocate_single_git_dir_into_superproject`: the embedded repository moves under
 * `modules/<name>`, points back at its checkout through `core.worktree`, and leaves a
 * gitfile behind. Answers the checkout's context, now reached through that gitfile.
 */
const relocateGitDir = async (
  ctx: Context,
  path: FilePath,
  rows: ReadonlyArray<GitmodulesRow>,
): Promise<Context> => {
  const row = rows.find((candidate) => candidate.path === path);
  if (row === undefined) throw submoduleNameNotFound(path);
  await refuseNestedModuleDir(ctx, row.name);
  const checkoutDir = joinPath(requireWorkTree(ctx, COMMAND), path);
  const dotGit = `${checkoutDir}/${DOT_GIT}`;
  const moduleDir = `${ctx.layout.gitDir}/modules/${row.name}`;
  await ctx.fs.mkdir(dirname(moduleDir));
  await ctx.fs.rename(dotGit, moduleDir);
  const child = deriveGitlinkContext(ctx, moduleDir, path);
  await updateConfigOperations(child, [
    {
      kind: 'set',
      section: 'core',
      key: 'worktree',
      value: relativePathBetween(moduleDir, checkoutDir),
    },
  ]);
  await ctx.fs.writeUtf8(dotGit, `gitdir: ${relativePathBetween(checkoutDir, moduleDir)}\n`);
  return child;
};

/** git's `absorb_git_dir_into_superproject` for one path: an embedded repository relocates, then the checkout's own submodules are absorbed. */
const absorbGitDir = async (
  ctx: Context,
  path: FilePath,
  rows: ReadonlyArray<GitmodulesRow>,
): Promise<void> => {
  if (!(await isDirectoryAt(ctx, path))) return;
  const checkout = await populatedCheckout(ctx, path);
  if (checkout === undefined) return;
  const child =
    checkout.via === 'directory' ? await relocateGitDir(ctx, path, rows) : await checkout.context();
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
  const workDir = requireWorkTree(ctx, COMMAND);
  for (const path of gitlinks) {
    if (!(await isPopulated(ctx, joinPath(workDir, path)))) continue;
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

const isDirty = ({ changes, untracked, unmerged }: StatusResult): boolean =>
  changes.length > 0 || untracked.length > 0 || unmerged.length > 0;

/** git's `bad_to_remove_submodule`: an empty directory is clean, one not using gitfiles throughout is modified, else the checkout's own status decides. */
const badToRemoveSubmodule = async (
  ctx: Context,
  scanner: LeadingPathScanner,
  path: FilePath,
  childStatus: ChildStatus,
): Promise<GitlinkLocalModification> => {
  if (await isEmptyDirectory(ctx, joinPath(requireWorkTree(ctx, COMMAND), path))) return 'clean';
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
  const stat = await lstatIfReachable(ctx.fs, joinPath(requireWorkTree(ctx, COMMAND), entry.path));
  if (stat === undefined) return 'vanished';
  if (await statDiffers(ctx, entry, stat)) return 'modified';
  return badToRemoveSubmodule(ctx, scanner, entry.path, childStatus);
};
