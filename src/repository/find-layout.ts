import type { PathPolicy } from '../adapters/node/path-policy.js';
import type { FilePath } from '../domain/objects/object-id.js';
import { notARepository } from '../domain/repository/error.js';
import { gitfileInvalidFormat, gitfileNoPath } from '../domain/worktree/error.js';
import { parseCommondir, parseGitfilePointer } from '../domain/worktree/gitfile.js';
import type { LayoutProbe } from '../ports/layout-probe.js';
import type { RepositoryLayoutInput } from '../repository.js';

/**
 * Walk up from `cwd` looking for a `.git` entry. A `.git` **directory** is a
 * candidate: if it does not validate (missing `HEAD`/`objects`/`refs`) the
 * walk continues upward. A `.git` **file** (a linked-worktree/submodule/
 * `--separate-git-dir` gitfile pointer) is a commitment: once found, it is
 * resolved and either returns a layout or throws — the walk never falls back
 * to an ancestor repository past an unusable gitfile.
 *
 * Returns `undefined` when no usable `.git` is found before reaching the
 * filesystem root — callers can choose to default to a fresh repo at `cwd`
 * (init/clone paths) or surface NOT_A_REPOSITORY (most other commands).
 *
 * `pathPolicy` is required so the walk's `resolve` / `dirname` / `join`
 * semantics match the input form. Callers in production code source the
 * host-matching policy from the adapter they constructed; tests that pair
 * a POSIX-only adapter (e.g. the in-memory FS) with POSIX-shaped paths
 * inject `posixPolicy` to keep the walk POSIX-rooted on any host. The
 * default was lifted out of this module to avoid the repository layer
 * reaching across the hexagonal boundary into an adapter.
 */
export const findLayout = async (
  probe: LayoutProbe,
  cwd: string,
  pathPolicy: PathPolicy,
): Promise<RepositoryLayoutInput | undefined> => {
  let current = pathPolicy.resolve(cwd);
  while (true) {
    const candidate = pathPolicy.join(current, '.git');
    // stat, not lstat — a .git symlink to a real gitdir behaves as a directory.
    const stat = await probe.stat(candidate);
    if (stat?.isDirectory === true) {
      const layout = await layoutFor(probe, current, candidate, pathPolicy);
      if (layout !== undefined) return layout;
    } else if (stat?.isFile === true) {
      return layoutFromGitfile(probe, current, candidate, pathPolicy);
    }
    const parent = pathPolicy.dirname(current);
    if (parent === current) return undefined; // reached filesystem root
    current = parent;
  }
};

/**
 * Resolves a worktree's `.git` gitfile to its layout. Extracted so the
 * browser shim can reuse the exact same pointer-resolution logic instead of
 * re-implementing it.
 */
export const layoutFromGitfile = async (
  probe: LayoutProbe,
  workDir: string,
  gitfilePath: string,
  pathPolicy: PathPolicy,
): Promise<RepositoryLayoutInput> => {
  const gitDir = await resolvePointer(probe, gitfilePath, workDir, pathPolicy);
  const layout = await layoutFor(probe, workDir, gitDir, pathPolicy);
  if (layout === undefined) throw notARepository(workDir as FilePath);
  return layout;
};

/**
 * A `.git` gitfile or `commondir` file larger than this is rejected before
 * parsing. Real pointer files are a path plus a short prefix (well under one
 * kilobyte); an oversized one in the walk path is hostile or corrupt, and
 * capping here keeps discovery from feeding megabytes into the parser.
 */
const GITFILE_MAX_BYTES = 65536;

/**
 * Parses and resolves a gitfile's `gitdir:` pointer. The gitfile path was
 * already `stat`ed as a file by the caller, so `readUtf8` returning
 * `undefined` here means unreadable-or-vanished, not "absent". The probe
 * contract collapses every failure to `undefined`, so an EACCES is not
 * distinguishable from a race-removed file; both map to the gitfile-format
 * refusal because the invariant that matters is the hard stop — discovery
 * must never walk up past a `.git` file it could not use.
 */
const resolvePointer = async (
  probe: LayoutProbe,
  gitfilePath: string,
  baseDir: string,
  pathPolicy: PathPolicy,
): Promise<string> => {
  const stat = await probe.stat(gitfilePath);
  if (stat === undefined || stat.size > GITFILE_MAX_BYTES) {
    throw gitfileInvalidFormat(gitfilePath);
  }
  const raw = await probe.readUtf8(gitfilePath);
  if (raw === undefined) throw gitfileInvalidFormat(gitfilePath);
  const parsed = parseGitfilePointer(raw);
  if (parsed.kind === 'invalid-format') throw gitfileInvalidFormat(gitfilePath);
  if (parsed.kind === 'no-path') throw gitfileNoPath(gitfilePath);
  return pathPolicy.isAbsolute(parsed.path)
    ? pathPolicy.resolve(parsed.path)
    : pathPolicy.resolve(pathPolicy.join(baseDir, parsed.path));
};

/**
 * Validates `gitDir` and resolves its `commonDir`, returning the layout when
 * valid or `undefined` when not — the directory branch's "candidate, not
 * commitment" contract (caller decides whether to walk up or throw).
 */
const layoutFor = async (
  probe: LayoutProbe,
  workDir: string,
  gitDir: string,
  pathPolicy: PathPolicy,
): Promise<RepositoryLayoutInput | undefined> => {
  const commonDir = await resolveCommonDir(probe, gitDir, pathPolicy);
  if (!(await isGitDirectory(probe, gitDir, commonDir, pathPolicy))) return undefined;
  return {
    workDir,
    gitDir,
    bare: false,
    // Omitted (not set to undefined) when equal to gitDir — exactOptionalPropertyTypes
    // forbids the explicit-undefined form, and omission keeps a normal repo's
    // layout byte-identical to today's.
    ...(commonDir !== gitDir ? { commonDir } : {}),
  };
};

/**
 * Resolves `gitDir`'s `commondir` file. An absent file means `commonDir`
 * equals `gitDir` — this is what makes a submodule gitdir and a
 * `--separate-git-dir` gitdir valid without a commondir file of their own.
 */
const resolveCommonDir = async (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
): Promise<string> => {
  const commondirPath = pathPolicy.join(gitDir, 'commondir');
  const stat = await probe.stat(commondirPath);
  if (stat === undefined) return gitDir;
  if (stat.size > GITFILE_MAX_BYTES) throw gitfileInvalidFormat(commondirPath);
  const raw = await probe.readUtf8(commondirPath);
  if (raw === undefined) return gitDir;
  const value = parseCommondir(raw);
  if (value.kind === 'empty') throw gitfileInvalidFormat(commondirPath);
  return pathPolicy.isAbsolute(value.path)
    ? pathPolicy.resolve(value.path)
    : pathPolicy.resolve(pathPolicy.join(gitDir, value.path));
};

/**
 * Git's `is_git_directory`, narrowed: `HEAD` must be a regular file (via a
 * following `stat`, so a symlinked HEAD qualifies) but its content is never
 * parsed. Ref parsing is unavailable at discovery time; a directory with a
 * malformed `HEAD` is accepted here and rejected later by the primitives
 * tier with its own structured error, rather than by silently walking up
 * past it. A directory named `HEAD` is not a head and fails the check.
 */
const isGitDirectory = async (
  probe: LayoutProbe,
  gitDir: string,
  commonDir: string,
  pathPolicy: PathPolicy,
): Promise<boolean> => {
  const head = await probe.stat(pathPolicy.join(gitDir, 'HEAD'));
  if (head?.isFile !== true) return false;
  const objects = await probe.stat(pathPolicy.join(commonDir, 'objects'));
  if (objects?.isDirectory !== true) return false;
  const refs = await probe.stat(pathPolicy.join(commonDir, 'refs'));
  return refs?.isDirectory === true;
};
