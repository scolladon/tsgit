import type { PathPolicy } from '../adapters/node/path-policy.js';
import type { FilePath } from '../domain/objects/object-id.js';
import { notARepository } from '../domain/repository/error.js';
import { isRefsLinkText, isValidHeadContent } from '../domain/repository/head-ref.js';
import { gitfileInvalidFormat, gitfileNoPath } from '../domain/worktree/error.js';
import { parseCommondir, parseGitfilePointer } from '../domain/worktree/gitfile.js';
import type { LayoutProbe } from '../ports/layout-probe.js';
import { longestStrictAncestor } from './ceiling-stop.js';

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
    }
  | {
      readonly route: 'EXPLICIT';
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
 * candidate: if it does not validate (missing or malformed `HEAD`, missing
 * `objects`/`refs`) the walk falls through to the cwd-is-gitdir check at the
 * same level, then continues upward — though an unusable `commondir` past a
 * valid `HEAD` is a hard stop even here, exactly as git dies on it. A
 * `.git` **file** (a linked-worktree/submodule/
 * `--separate-git-dir` gitfile pointer) is a commitment: once found, it is
 * resolved and either returns a layout or throws — the walk never falls back
 * to an ancestor repository past an unusable gitfile. The cwd-is-gitdir check
 * probes `HEAD` first, so a level with neither a `.git` entry nor a `HEAD`
 * costs one extra `stat` (plus, on adapters exposing `readLink`, one
 * `readlink` — the price of judging a symlinked `HEAD` by its link text the
 * way git does) over the pre-existing walk.
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
 *
 * `ceilingDirs`, when given, bounds the climb: `longestStrictAncestor` is
 * computed ONCE before the loop starts (never per level), and the loop head
 * refuses to examine — or look past — that directory. Omitted entirely, the
 * walk behaves exactly as before.
 */
export const findLayout = async (
  probe: LayoutProbe,
  cwd: string,
  pathPolicy: PathPolicy,
  ceilingDirs?: ReadonlyArray<string>,
): Promise<WalkOutcome | undefined> => {
  let current = pathPolicy.resolve(cwd);
  const atCeiling = ceilingTest(ceilingDirs, current, pathPolicy);
  while (true) {
    if (atCeiling(current)) return undefined;
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
    // The same validator asks whether `current` ITSELF is a git directory.
    const bareLocated = await layoutFor(probe, current, pathPolicy);
    if (bareLocated !== undefined) return { ...bareLocated, route: 'BARE_DIR' };
    const parent = pathPolicy.dirname(current);
    if (parent === current) return undefined; // reached filesystem root
    current = parent;
  }
};

/**
 * The walk's loop-head ceiling predicate, computed ONCE before the loop.
 * Comparison goes through `normalizeForCompare` — the same normalisation the
 * ceiling selection itself uses — because a raw equality would walk straight
 * past a case-mismatched stop on a case-insensitive filesystem, failing open
 * on the one bound the caller set.
 */
const ceilingTest = (
  ceilingDirs: ReadonlyArray<string> | undefined,
  resolvedCwd: string,
  pathPolicy: PathPolicy,
): ((current: string) => boolean) => {
  const ceilStop = longestStrictAncestor(ceilingDirs, resolvedCwd, pathPolicy);
  if (ceilStop === undefined) return () => false;
  const ceilKey = pathPolicy.normalizeForCompare(ceilStop);
  return (current) => pathPolicy.normalizeForCompare(current) === ceilKey;
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
 *
 * Exported so `resolve-layout.ts`'s explicit-gitDir route can route a
 * gitDir argument that names a regular file through the same gitfile
 * grammar rather than re-implementing it.
 */
export const resolvePointer = async (
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
 * Git's `is_git_directory`, shared by every walk and gitfile route: `HEAD`
 * is validated first (a directory that is simply not a git directory returns
 * `undefined` and the walk climbs), then the `commondir` pointer is resolved
 * — an unusable one past a valid `HEAD` is a HARD refusal on every route,
 * exactly as git dies there — then the shared dirs are checked.
 */
const layoutFor = async (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
): Promise<GitDirLocation | undefined> => {
  // HEAD first, on every walk/gitfile route — git's `is_git_directory` validates the head
  // before touching the common dir, so a garbage-`HEAD` directory (a planted
  // tree, or three innocuous entries) is climbed past without its `commondir`
  // ever being parsed. It doubles as the cheap gate: a level with no `HEAD`
  // file is rejected on that single `stat`, before any read.
  if (!(await hasValidHead(probe, gitDir, pathPolicy))) return undefined;
  // An unusable `commondir` past a valid `HEAD` is a HARD refusal, not a
  // skip: measured, git dies (`fatal: failed to read <dir>/commondir` /
  // `Invalid path`) and does NOT climb to an enclosing repository — on the
  // walk routes exactly as on the gitfile/explicit ones.
  const commonDir = await resolveCommonDir(probe, gitDir, pathPolicy);
  if (!(await sharedDirsValid(probe, commonDir, pathPolicy))) return undefined;
  return {
    gitDir,
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
export const resolveCommonDir = async (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
): Promise<string> => {
  const commondirPath = pathPolicy.join(gitDir, 'commondir');
  const stat = await probe.stat(commondirPath);
  if (stat === undefined) return gitDir;
  // A non-regular `commondir` (a directory, or a FIFO/device on the node
  // probe) is treated as absent, never read: `readUtf8` on a FIFO would
  // block forever waiting for a writer, handing any planted special file a
  // denial of the whole discovery.
  if (stat.isFile !== true) return gitDir;
  if (stat.size > GITFILE_MAX_BYTES) throw gitfileInvalidFormat(commondirPath);
  const raw = await probe.readUtf8(commondirPath);
  if (raw === undefined) return gitDir;
  // Three measured shapes: a ZERO-BYTE file is git's hard fatal (`failed to
  // read <path>/commondir`); a newline-only file strips to empty and is
  // accepted as "this gitDir is its own common dir"; anything else is a path
  // verbatim (whitespace included — `"   \n"` names a directory called
  // `"   "`, which then simply fails the shared-dir validation).
  if (raw.length === 0) throw gitfileInvalidFormat(commondirPath);
  const value = parseCommondir(raw);
  if (value.kind === 'empty') return gitDir;
  if (pathPolicy.isAbsolute(value.path)) return pathPolicy.resolve(value.path);
  // git resolves a RELATIVE pointer component by component (its physical
  // realpath walk) and dies (`fatal: Invalid path`) on the first missing
  // INTERMEDIATE — only the FINAL component may be absent (the target then
  // simply fails the shared-dir validation and the candidate is a miss).
  // Stepwise resolution here mirrors that: a lexical pre-collapse would let
  // `missing/../../shared` skip straight past the missing component git
  // trips on. Relative pointers only: an absolute target may lie outside a
  // sandboxed adapter's containment root, where the probe's absence/denial
  // collapse would turn an unverifiable parent into a false refusal. A few
  // extra `stat`s, paid only by the rare directory carrying a relative
  // `commondir` at all.
  const segments = value.path.split('/').filter((segment) => segment.length > 0);
  let current = gitDir;
  for (const segment of segments.slice(0, -1)) {
    current = pathPolicy.resolve(pathPolicy.join(current, segment));
    const step = await probe.stat(current);
    if (step?.isDirectory !== true) throw gitfileInvalidFormat(commondirPath);
  }
  // Once every intermediate exists, the lexical resolve of the ORIGINAL
  // pointer equals the stepwise result (this tier has no symlinks to make
  // them diverge), and using it avoids a dead fallback for the impossible
  // empty-segments case (an all-slash relative pointer cannot exist — it
  // would be absolute).
  return pathPolicy.resolve(pathPolicy.join(gitDir, value.path));
};

/**
 * The `HEAD` half of git's `is_git_directory`: a symlink is judged by its
 * LINK TEXT first (adapters exposing `readLink`); otherwise `HEAD` must be a
 * regular file (via a following `stat`) and its content must
 * parse as either a hex object id or a `ref:` symbolic ref — the grammar
 * `isValidHeadContent` checks. This is what stops a planted directory
 * holding innocuous `HEAD`, `objects/`, `refs/` entries from shadowing an
 * enclosing repository: real git climbs past it, and so must this. The one
 * residual gap from real git: a `HEAD` symlink whose *link text* begins
 * `refs/` but whose target does not exist is accepted by git and rejected
 * here, because this probe only exposes a following `stat` plus `readUtf8`,
 * never the raw link text on adapters without `readLink`. A directory named
 * `HEAD` is not a head and fails the check.
 */
const hasValidHead = async (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
): Promise<boolean> => {
  const headPath = pathPolicy.join(gitDir, 'HEAD');
  // Link text FIRST, like git's `validate_headref` (an lstat): a `HEAD`
  // symlink is judged by where it POINTS — `refs/…` qualifies even when the
  // target does not exist, anything else disqualifies even when it does.
  // Adapters without the capability (or a non-symlink `HEAD`, where
  // `readLink` collapses to undefined) fall through to the content check.
  const linkText = await probe.readLink?.(headPath);
  if (linkText !== undefined) return isRefsLinkText(linkText);
  const head = await probe.stat(headPath);
  if (head?.isFile !== true) return false;
  // No size gate: git validates only the first 255 bytes of HEAD and never
  // consults its size, so an oversized-but-valid HEAD is still a git
  // directory (measured) — rejecting on size would climb PAST a repository
  // git resolves, the outward-escape class. Both grammar tests are anchored
  // prefix matches, so the parse cost is bounded regardless of file size,
  // and a regular file always terminates the read.
  const content = await probe.readUtf8(headPath);
  return content !== undefined && isValidHeadContent(content);
};

/** The shared-dir half of git's `is_git_directory`: `objects/` and `refs/` at the common dir. */
const sharedDirsValid = async (
  probe: LayoutProbe,
  commonDir: string,
  pathPolicy: PathPolicy,
): Promise<boolean> => {
  const objects = await probe.stat(pathPolicy.join(commonDir, 'objects'));
  if (objects?.isDirectory !== true) return false;
  const refs = await probe.stat(pathPolicy.join(commonDir, 'refs'));
  return refs?.isDirectory === true;
};
