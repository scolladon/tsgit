import type { PathPolicy } from '../adapters/node/path-policy.js';
import type { FilePath } from '../domain/objects/object-id.js';
import { notARepository } from '../domain/repository/error.js';
import { isValidHeadContent } from '../domain/repository/head-ref.js';
import { gitfileInvalidFormat, gitfileNoPath } from '../domain/worktree/error.js';
import { parseCommondir, parseGitfilePointer } from '../domain/worktree/gitfile.js';
import type { LayoutProbe } from '../ports/layout-probe.js';

/**
 * The walk's raw structural finding: where the gitDir (and, if different, the
 * common dir) live, and which route found it — `'DISCOVERED'` (a `.git`
 * entry) or `'BARE_DIR'` (cwd itself qualifies). Config-driven work-tree
 * resolution turns this into a full layout — the walk itself never decides a
 * work tree or bareness. A discriminated union (rather than an `origin?`
 * flattened onto both routes) so a `DISCOVERED` outcome's `origin` — the
 * directory holding the `.git` entry — is not-undefined by construction; the
 * discriminant itself is why `route` carries literal types here rather than a
 * named `WalkRoute` alias, which could not narrow the two arms apart.
 */
export type WalkOutcome =
  | {
      readonly route: 'DISCOVERED';
      readonly gitDir: string;
      readonly commonDir?: string;
      readonly origin: string;
    }
  | {
      readonly route: 'BARE_DIR';
      readonly gitDir: string;
      readonly commonDir?: string;
    };

/** A resolved gitDir location — the shared output of the `.git`-directory and cwd-is-gitdir checks. */
interface GitDirLocation {
  readonly gitDir: string;
  readonly commonDir?: string;
}

/**
 * Walk up from `cwd` looking for a `.git` entry, and — at every level — ask
 * whether the level itself is a git directory. A `.git` **directory** is a
 * candidate: if it does not validate (missing `HEAD`/`objects`/`refs`) the
 * walk falls through to the cwd-is-gitdir check at the same level, then
 * continues upward. A `.git` **file** (a linked-worktree/submodule/
 * `--separate-git-dir` gitfile pointer) is a commitment: once found, it is
 * resolved and either returns a layout or throws — the walk never falls back
 * to an ancestor repository past an unusable gitfile. The cwd-is-gitdir check
 * runs a cheap `HEAD`-file stat first so a level with neither a `.git` entry
 * nor a `HEAD` file costs exactly one extra `stat` over the pre-existing walk.
 *
 * Returns `undefined` when no usable git directory is found before reaching
 * the filesystem root — callers can choose to default to a fresh repo at
 * `cwd` (init/clone paths) or surface NOT_A_REPOSITORY (most other commands).
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
): Promise<WalkOutcome | undefined> => {
  let current = pathPolicy.resolve(cwd);
  while (true) {
    const candidate = pathPolicy.join(current, '.git');
    // stat, not lstat — a .git symlink to a real gitdir behaves as a directory.
    const stat = await probe.stat(candidate);
    if (stat?.isDirectory === true) {
      const located = await layoutFor(probe, candidate, pathPolicy);
      if (located !== undefined) return { ...located, route: 'DISCOVERED', origin: current };
    } else if (stat?.isFile === true) {
      const located = await layoutFromGitfile(probe, current, candidate, pathPolicy, stat.size);
      return { ...located, route: 'DISCOVERED', origin: current };
    }
    // Reached when `current` holds no `.git` entry, or an invalid `.git`
    // directory (the candidate branch above fell through rather than
    // returning) — never after a `.git` file, which always returns or throws.
    const bareLocated = await isCwdGitDirectory(probe, current, pathPolicy);
    if (bareLocated !== undefined) return { ...bareLocated, route: 'BARE_DIR' };
    const parent = pathPolicy.dirname(current);
    if (parent === current) return undefined; // reached filesystem root
    current = parent;
  }
};

/**
 * Resolves a worktree's `.git` gitfile to its git-directory location.
 * Extracted so the browser shim can reuse the exact same pointer-resolution
 * logic instead of re-implementing it. `gitfileSize` is the byte size the
 * caller's own `stat` of the gitfile reported — every caller has just stat'ed
 * the entry to learn it IS a file, so threading the size avoids a redundant
 * probe. `workDir` is used only to name the directory in a thrown
 * `NOT_A_REPOSITORY` — the caller decides how it participates in the
 * eventual layout.
 */
export const layoutFromGitfile = async (
  probe: LayoutProbe,
  workDir: string,
  gitfilePath: string,
  pathPolicy: PathPolicy,
  gitfileSize: number,
): Promise<GitDirLocation> => {
  const gitDir = await resolvePointer(probe, gitfilePath, workDir, pathPolicy, gitfileSize);
  const located = await layoutFor(probe, gitDir, pathPolicy);
  if (located === undefined) throw notARepository(workDir as FilePath);
  return located;
};

/**
 * A `.git` gitfile, `commondir` file, or `HEAD` file larger than this is
 * rejected before parsing. Real pointer files are a path plus a short prefix
 * and a real `HEAD` is a refname or an object id (well under one kilobyte);
 * an oversized one in the walk path is hostile or corrupt, and capping here
 * keeps discovery from feeding megabytes into the parser.
 */
export const GITFILE_MAX_BYTES = 65536;

/**
 * Parses and resolves a gitfile's `gitdir:` pointer. The gitfile path was
 * already `stat`ed as a file by the caller (which is where `gitfileSize`
 * comes from), so `readUtf8` returning `undefined` here means
 * unreadable-or-vanished, not "absent". The probe contract collapses every
 * failure to `undefined`, so an EACCES is not distinguishable from a
 * race-removed file; both map to the gitfile-format refusal because the
 * invariant that matters is the hard stop — discovery must never walk up
 * past a `.git` file it could not use.
 */
const resolvePointer = async (
  probe: LayoutProbe,
  gitfilePath: string,
  baseDir: string,
  pathPolicy: PathPolicy,
  gitfileSize: number,
): Promise<string> => {
  if (gitfileSize > GITFILE_MAX_BYTES) throw gitfileInvalidFormat(gitfilePath);
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
 * Validates `gitDir` and resolves its `commonDir`, returning the location
 * when valid or `undefined` when not — the directory branch's "candidate,
 * not commitment" contract (caller decides whether to walk up or throw).
 */
const layoutFor = async (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
): Promise<GitDirLocation | undefined> => {
  const commonDir = await resolveCommonDir(probe, gitDir, pathPolicy);
  if (!(await isGitDirectory(probe, gitDir, commonDir, pathPolicy))) return undefined;
  return {
    gitDir,
    // Omitted (not set to undefined) when equal to gitDir — exactOptionalPropertyTypes
    // forbids the explicit-undefined form, and omission keeps a normal repo's
    // layout byte-identical to today's.
    ...(commonDir !== gitDir ? { commonDir } : {}),
  };
};

/**
 * The per-level check for whether `current` itself is a git directory
 * (rather than merely holding a `.git` entry). A cheap `HEAD`-file `stat`
 * gates the expensive `resolveCommonDir` + `objects`/`refs` probes
 * `layoutFor` pays — a level with no `HEAD` file costs exactly this one
 * extra `stat`, never the full validation. Reusing `layoutFor` here means the
 * `HEAD` file is stat'ed twice on the rare level that passes the cheap gate
 * (once here, once inside `isGitDirectory`), which is the accepted cost of
 * not duplicating the validation logic.
 */
const isCwdGitDirectory = async (
  probe: LayoutProbe,
  current: string,
  pathPolicy: PathPolicy,
): Promise<GitDirLocation | undefined> => {
  const headStat = await probe.stat(pathPolicy.join(current, 'HEAD'));
  if (headStat?.isFile !== true) return undefined;
  return layoutFor(probe, current, pathPolicy);
};

/**
 * Resolves `gitDir`'s `commondir` file. An absent file means `commonDir`
 * equals `gitDir` — this is what makes a submodule gitdir and a
 * `--separate-git-dir` gitdir valid without a commondir file of their own.
 */
export const resolveCommonDir = async (
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
 * following `stat`, so a symlinked HEAD qualifies when its target exists and
 * reads back as valid content) and its content must parse as either a hex
 * object id or a `ref:` symbolic ref — the same grammar `isValidHeadContent`
 * checks. This is what stops a planted directory holding innocuous `HEAD`,
 * `objects/`, `refs/` entries from shadowing an enclosing repository: real
 * git climbs past it, and so must this. The one residual gap from real git:
 * a `HEAD` symlink whose *link text* begins `refs/` but whose target does
 * not exist is accepted by git and rejected here, because this probe only
 * exposes a following `stat` plus `readUtf8`, never the raw link text. A
 * directory named `HEAD` is not a head and fails the check; an oversized
 * `HEAD` is rejected on its `stat`ed size, without being read.
 */
const isGitDirectory = async (
  probe: LayoutProbe,
  gitDir: string,
  commonDir: string,
  pathPolicy: PathPolicy,
): Promise<boolean> => {
  const headPath = pathPolicy.join(gitDir, 'HEAD');
  const head = await probe.stat(headPath);
  if (head?.isFile !== true) return false;
  if (head.size > GITFILE_MAX_BYTES) return false;
  const content = await probe.readUtf8(headPath);
  if (content === undefined || !isValidHeadContent(content)) return false;
  const objects = await probe.stat(pathPolicy.join(commonDir, 'objects'));
  if (objects?.isDirectory !== true) return false;
  const refs = await probe.stat(pathPolicy.join(commonDir, 'refs'));
  return refs?.isDirectory === true;
};
